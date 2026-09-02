//! Versioned compiled materialized views for bounded workflow queries.
//!
//! The catalog owns only immutable identity, lifecycle, partition checkpoints,
//! atomic dispatch, and bounded telemetry. Compiled handlers own row schemas,
//! SQL, projection payload validation, authorization, and named access plans.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{
    Connection, InterruptHandle, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
    params,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

mod conversation;
mod exact_range;

use conversation::ConversationView;
use exact_range::ExactRangeView;

pub const VIEW_QUERY_VERSION_V1: &str = "qq-index-query/v1";
pub const VIEW_MUTATION_VERSION_V1: &str = "qq-index-view-mutation/v1";
pub const VIEW_DESCRIBE_VERSION_V1: &str = "qq-index-view-describe/v1";
pub const VIEW_LIFECYCLE_VERSION_V1: &str = "qq-index-view-lifecycle/v1";
pub const VIEW_PARTITION_STATE_VERSION_V1: &str = "qq-index-view-partition-state/v1";
pub const VIEW_RESPONSE_VERSION_V1: &str = "qq-index-view-response/v1";
pub const VIEW_APPLICATION_ID: i32 = 0x5156_4932; // ASCII QVI2
pub const VIEW_SCHEMA_VERSION: i32 = 2;
pub const MAX_VIEW_ROWS_PER_MUTATION: usize = 1_024;
pub const MAX_VIEW_DELETES_PER_MUTATION: usize = 1_024;
pub const MAX_VIEW_PARTITION_STATE_KEYS: usize = 64;
const MAX_TEXT_BYTES: usize = 4_096;
const MAX_ROW_BYTES: usize = 1_048_576;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ViewStateV1 {
    Building,
    Ready,
    Failed,
}

impl ViewStateV1 {
    fn as_str(self) -> &'static str {
        match self {
            Self::Building => "building",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self, ViewError> {
        match value {
            "building" => Ok(Self::Building),
            "ready" => Ok(Self::Ready),
            "failed" => Ok(Self::Failed),
            _ => Err(ViewError::InvalidStorage(
                "unknown view lifecycle state".to_owned(),
            )),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewAccessManifestV1 {
    pub name: &'static str,
    pub maximum_results: usize,
    pub maximum_work_units: usize,
    pub authorization: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewManifestV1 {
    pub id: &'static str,
    pub version: u32,
    pub digest: &'static str,
    pub build_id: &'static str,
    pub source_contract: &'static str,
    pub source_state_version: &'static str,
    pub partition_key: &'static str,
    pub row_schema: &'static str,
    pub authorization_contract: &'static str,
    pub physical_schema: &'static str,
    pub maximum_partition_rows: usize,
    pub maximum_partition_bytes: usize,
    pub test_only: bool,
    pub accesses: &'static [ViewAccessManifestV1],
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewIdentityV1 {
    pub id: String,
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewSourceCheckpointV1 {
    pub source_identity: String,
    pub durable_revision: String,
    pub next_cursor: u64,
    pub source_fence: String,
    pub lag_ms: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ViewMutationV1 {
    ReplacePartition {
        view: ViewIdentityV1,
        partition_key: String,
        source: ViewSourceCheckpointV1,
        rows: Vec<Value>,
    },
    ApplyDelta {
        view: ViewIdentityV1,
        partition_key: String,
        expected_cursor: u64,
        source: ViewSourceCheckpointV1,
        upserts: Vec<Value>,
        deletes: Vec<String>,
    },
    DeletePartition {
        view: ViewIdentityV1,
        partition_key: String,
        expected_cursor: u64,
        source_identity: String,
        source_fence: String,
        lag_ms: u64,
    },
}

impl ViewMutationV1 {
    pub fn view(&self) -> &ViewIdentityV1 {
        match self {
            Self::ReplacePartition { view, .. }
            | Self::ApplyDelta { view, .. }
            | Self::DeletePartition { view, .. } => view,
        }
    }

    pub fn operation_name(&self) -> &'static str {
        match self {
            Self::ReplacePartition { .. } => "replace-partition",
            Self::ApplyDelta { .. } => "apply-delta",
            Self::DeletePartition { .. } => "delete-partition",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ViewLifecycleV1 {
    Activate {
        view: ViewIdentityV1,
        source_fence: String,
        lag_ms: u64,
    },
    MarkBuilding {
        view: ViewIdentityV1,
        source_fence: String,
        lag_ms: u64,
    },
    MarkFailed {
        view: ViewIdentityV1,
        source_fence: String,
        lag_ms: u64,
    },
}

impl ViewLifecycleV1 {
    pub fn view(&self) -> &ViewIdentityV1 {
        match self {
            Self::Activate { view, .. }
            | Self::MarkBuilding { view, .. }
            | Self::MarkFailed { view, .. } => view,
        }
    }

    fn fields(&self) -> (ViewStateV1, &str, u64) {
        match self {
            Self::Activate {
                source_fence,
                lag_ms,
                ..
            } => (ViewStateV1::Ready, source_fence, *lag_ms),
            Self::MarkBuilding {
                source_fence,
                lag_ms,
                ..
            } => (ViewStateV1::Building, source_fence, *lag_ms),
            Self::MarkFailed {
                source_fence,
                lag_ms,
                ..
            } => (ViewStateV1::Failed, source_fence, *lag_ms),
        }
    }

    pub fn operation_name(&self) -> &'static str {
        match self {
            Self::Activate { .. } => "activate",
            Self::MarkBuilding { .. } => "mark-building",
            Self::MarkFailed { .. } => "mark-failed",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewAuthorityV1 {
    pub kind: String,
    pub scope_tokens: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewFreshnessV1 {
    pub mode: String,
    pub max_lag_ms: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ViewQueryV1 {
    pub view: ViewIdentityV1,
    pub access: String,
    pub params: Value,
    pub authority: ViewAuthorityV1,
    pub freshness: ViewFreshnessV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSnapshotV1 {
    pub generation: u64,
    pub source_fence: String,
    pub lag_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewTelemetryV1 {
    pub operation: String,
    pub outcome: String,
    pub elapsed_micros: u64,
    pub phases_micros: BTreeMap<String, u64>,
    pub counts: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewQueryResponseV1 {
    pub version: &'static str,
    pub view: ViewIdentityV1,
    pub build_id: String,
    pub access: String,
    pub snapshot: ViewSnapshotV1,
    pub result: Value,
    pub telemetry: ViewTelemetryV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewOperationReceiptV1 {
    pub version: &'static str,
    pub view: ViewIdentityV1,
    pub build_id: String,
    pub state: ViewStateV1,
    pub snapshot: ViewSnapshotV1,
    pub partition_key: Option<String>,
    pub next_cursor: Option<u64>,
    pub affected_rows: usize,
    pub telemetry: ViewTelemetryV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPartitionStateV1 {
    pub partition_key: String,
    pub source_identity: String,
    pub durable_revision: String,
    pub next_cursor: u64,
    pub generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPartitionStatesV1 {
    pub view: ViewIdentityV1,
    pub build_id: String,
    pub snapshot: ViewSnapshotV1,
    pub partitions: Vec<ViewPartitionStateV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDescriptionV1 {
    pub manifest: ViewManifestV1,
    pub state: ViewStateV1,
    pub snapshot: ViewSnapshotV1,
}

#[derive(Debug, Error)]
pub enum ViewError {
    #[error("unsupported view {id:?} version {version}")]
    UnsupportedView { id: String, version: u32 },
    #[error("unsupported access {access:?} for view {id:?} version {version}")]
    UnsupportedAccess {
        id: String,
        version: u32,
        access: String,
    },
    #[error("view {id:?} version {version} is building")]
    ViewBuilding { id: String, version: u32 },
    #[error("view {id:?} version {version} has failed")]
    ViewFailed { id: String, version: u32 },
    #[error("view freshness unavailable: lag {available_lag_ms}ms exceeds {maximum_lag_ms}ms")]
    FreshnessUnavailable {
        available_lag_ms: u64,
        maximum_lag_ms: u64,
    },
    #[error("view authorization is required")]
    AuthorizationRequired,
    #[error("invalid view mutation: {0}")]
    InvalidMutation(String),
    #[error("invalid view query: {0}")]
    InvalidQuery(String),
    #[error("partition cursor conflict: expected {expected}, actual {actual}")]
    CursorConflict { expected: u64, actual: u64 },
    #[error("partition lifecycle identity conflict")]
    SourceIdentityConflict,
    #[error("invalid view storage: {0}")]
    InvalidStorage(String),
    #[error("view storage already exists at {0}")]
    AlreadyExists(PathBuf),
    #[error("view storage does not exist at {0}")]
    NotFound(PathBuf),
    #[error("controlled view query was interrupted")]
    Interrupted,
    #[error("view catalog lock was poisoned")]
    LockPoisoned,
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub struct ViewCatalog {
    root: PathBuf,
    entries: Vec<ViewEntry>,
}

struct ViewEntry {
    handler: Box<dyn CompiledView>,
    connection: Mutex<Connection>,
    interrupt: Arc<InterruptHandle>,
}

trait CompiledView: Send + Sync {
    fn manifest(&self) -> &'static ViewManifestV1;
    fn create_schema(&self, transaction: &Transaction<'_>) -> Result<(), ViewError>;
    fn validate_schema(&self, connection: &Connection) -> Result<(), ViewError>;
    fn replace_partition(
        &self,
        transaction: &Transaction<'_>,
        partition_key: &str,
        rows: &[Value],
    ) -> Result<usize, ViewError>;
    fn apply_delta(
        &self,
        transaction: &Transaction<'_>,
        partition_key: &str,
        upserts: &[Value],
        deletes: &[String],
    ) -> Result<usize, ViewError>;
    fn delete_partition(
        &self,
        transaction: &Transaction<'_>,
        partition_key: &str,
    ) -> Result<usize, ViewError>;
    fn execute(
        &self,
        connection: &Connection,
        access: &str,
        params: &Value,
        authority: &ViewAuthorityV1,
    ) -> Result<HandlerQueryResult, ViewError>;
}

struct HandlerQueryResult {
    value: Value,
    counts: BTreeMap<String, u64>,
}

#[derive(Clone, Debug)]
struct StoredMeta {
    state: ViewStateV1,
    generation: u64,
    source_fence: String,
    lag_ms: u64,
}

impl ViewCatalog {
    /// Create all statically compiled view stores beside the legacy rollback DB.
    pub fn create(legacy_database_path: impl AsRef<Path>) -> Result<Self, ViewError> {
        Self::open_impl(legacy_database_path.as_ref(), true)
    }

    /// Open compiled view stores. Missing stores are initialized as rebuilding derived state.
    pub fn open_or_create(legacy_database_path: impl AsRef<Path>) -> Result<Self, ViewError> {
        Self::open_impl(legacy_database_path.as_ref(), false)
    }

    fn open_impl(legacy_database_path: &Path, exclusive: bool) -> Result<Self, ViewError> {
        let root = view_root(legacy_database_path)?;
        if exclusive && root.exists() {
            return Err(ViewError::AlreadyExists(root));
        }
        fs::create_dir_all(&root)?;
        let mut entries = Vec::new();
        for handler in compiled_handlers() {
            let path = root.join(view_file_name(handler.manifest()));
            let exists = path.exists();
            let connection = if exists {
                Connection::open_with_flags(
                    &path,
                    OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )?
            } else {
                Connection::open_with_flags(
                    &path,
                    OpenFlags::SQLITE_OPEN_READ_WRITE
                        | OpenFlags::SQLITE_OPEN_CREATE
                        | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )?
            };
            configure(&connection)?;
            if exists {
                validate_store(&connection, handler.manifest(), handler.as_ref())?;
            } else {
                create_store(&connection, handler.manifest(), handler.as_ref())?;
            }
            let interrupt = Arc::new(connection.get_interrupt_handle());
            entries.push(ViewEntry {
                handler,
                connection: Mutex::new(connection),
                interrupt,
            });
        }
        Ok(Self { root, entries })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn manifests(&self) -> Vec<ViewManifestV1> {
        self.entries
            .iter()
            .map(|entry| *entry.handler.manifest())
            .collect()
    }

    pub fn describe(&self) -> Result<Vec<ViewDescriptionV1>, ViewError> {
        let mut descriptions = Vec::with_capacity(self.entries.len());
        for entry in &self.entries {
            let connection = lock(&entry.connection)?;
            let meta = read_meta(&connection)?;
            descriptions.push(ViewDescriptionV1 {
                manifest: *entry.handler.manifest(),
                state: meta.state,
                snapshot: snapshot(&meta),
            });
        }
        Ok(descriptions)
    }

    pub fn partition_states(
        &self,
        view: &ViewIdentityV1,
        partition_keys: &[String],
    ) -> Result<ViewPartitionStatesV1, ViewError> {
        if partition_keys.is_empty() || partition_keys.len() > MAX_VIEW_PARTITION_STATE_KEYS {
            return Err(ViewError::InvalidQuery(format!(
                "partitionKeys length must be 1..={MAX_VIEW_PARTITION_STATE_KEYS}"
            )));
        }
        let mut unique = std::collections::BTreeSet::new();
        for key in partition_keys {
            validate_text("partitionKey", key, 1, 256, ViewError::InvalidQuery)?;
            if !unique.insert(key) {
                return Err(ViewError::InvalidQuery(
                    "partitionKeys must be unique".to_owned(),
                ));
            }
        }
        let entry = self.entry(view)?;
        let connection = lock(&entry.connection)?;
        let meta = read_meta(&connection)?;
        let mut partitions = Vec::new();
        let mut statement = connection.prepare(
            "SELECT source_identity, durable_revision, next_cursor, generation
             FROM view_partitions WHERE partition_key = ?1",
        )?;
        for partition_key in partition_keys {
            let stored: Option<(String, String, i64, i64)> = statement
                .query_row([partition_key], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .optional()?;
            if let Some((source_identity, durable_revision, next_cursor, generation)) = stored {
                partitions.push(ViewPartitionStateV1 {
                    partition_key: partition_key.clone(),
                    source_identity,
                    durable_revision,
                    next_cursor: sql_u64(next_cursor, "nextCursor")?,
                    generation: sql_u64(generation, "generation")?,
                });
            }
        }
        Ok(ViewPartitionStatesV1 {
            view: view.clone(),
            build_id: entry.handler.manifest().build_id.to_owned(),
            snapshot: snapshot(&meta),
            partitions,
        })
    }

    pub fn apply_mutation(
        &self,
        mutation: &ViewMutationV1,
    ) -> Result<ViewOperationReceiptV1, ViewError> {
        let started = Instant::now();
        validate_mutation(mutation)?;
        let entry = self.entry(mutation.view())?;
        let mut connection = lock(&entry.connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_meta(&transaction)?;
        let generation = current
            .generation
            .checked_add(1)
            .ok_or_else(|| ViewError::InvalidStorage("view generation overflow".to_owned()))?;
        let (partition_key, next_cursor, affected_rows, source_fence, lag_ms) = match mutation {
            ViewMutationV1::ReplacePartition {
                partition_key,
                source,
                rows,
                ..
            } => {
                let affected =
                    entry
                        .handler
                        .replace_partition(&transaction, partition_key, rows)?;
                upsert_checkpoint(&transaction, partition_key, source, generation)?;
                (
                    Some(partition_key.clone()),
                    Some(source.next_cursor),
                    affected,
                    source.source_fence.as_str(),
                    source.lag_ms,
                )
            }
            ViewMutationV1::ApplyDelta {
                partition_key,
                expected_cursor,
                source,
                upserts,
                deletes,
                ..
            } => {
                validate_checkpoint(
                    &transaction,
                    partition_key,
                    *expected_cursor,
                    &source.source_identity,
                )?;
                if source.next_cursor < *expected_cursor {
                    return Err(ViewError::InvalidMutation(
                        "nextCursor must not precede expectedCursor".to_owned(),
                    ));
                }
                let affected =
                    entry
                        .handler
                        .apply_delta(&transaction, partition_key, upserts, deletes)?;
                upsert_checkpoint(&transaction, partition_key, source, generation)?;
                (
                    Some(partition_key.clone()),
                    Some(source.next_cursor),
                    affected,
                    source.source_fence.as_str(),
                    source.lag_ms,
                )
            }
            ViewMutationV1::DeletePartition {
                partition_key,
                expected_cursor,
                source_identity,
                source_fence,
                lag_ms,
                ..
            } => {
                validate_checkpoint(
                    &transaction,
                    partition_key,
                    *expected_cursor,
                    source_identity,
                )?;
                let affected = entry
                    .handler
                    .delete_partition(&transaction, partition_key)?;
                transaction.execute(
                    "DELETE FROM view_partitions WHERE partition_key = ?1",
                    [partition_key],
                )?;
                (
                    Some(partition_key.clone()),
                    None,
                    affected,
                    source_fence.as_str(),
                    *lag_ms,
                )
            }
        };
        update_meta_progress(&transaction, generation, source_fence, lag_ms)?;
        let meta = read_meta(&transaction)?;
        transaction.commit()?;
        let mut counts = BTreeMap::new();
        counts.insert("affectedRows".to_owned(), affected_rows as u64);
        counts.insert("partitions".to_owned(), 1);
        Ok(ViewOperationReceiptV1 {
            version: VIEW_RESPONSE_VERSION_V1,
            view: mutation.view().clone(),
            build_id: entry.handler.manifest().build_id.to_owned(),
            state: meta.state,
            snapshot: snapshot(&meta),
            partition_key,
            next_cursor,
            affected_rows,
            telemetry: telemetry(
                mutation.operation_name(),
                "ok",
                started,
                BTreeMap::new(),
                counts,
            ),
        })
    }

    pub fn apply_lifecycle(
        &self,
        lifecycle: &ViewLifecycleV1,
    ) -> Result<ViewOperationReceiptV1, ViewError> {
        let started = Instant::now();
        let (state, source_fence, lag_ms) = lifecycle.fields();
        validate_text(
            "sourceFence",
            source_fence,
            1,
            MAX_TEXT_BYTES,
            ViewError::InvalidMutation,
        )?;
        let entry = self.entry(lifecycle.view())?;
        let mut connection = lock(&entry.connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_meta(&transaction)?;
        let generation = current
            .generation
            .checked_add(1)
            .ok_or_else(|| ViewError::InvalidStorage("view generation overflow".to_owned()))?;
        transaction.execute(
            "UPDATE view_meta SET state = ?1, generation = ?2, source_fence = ?3, lag_ms = ?4 WHERE singleton = 1",
            params![state.as_str(), u64_sql(generation, "generation")?, source_fence, u64_sql(lag_ms, "lagMs")?],
        )?;
        let meta = read_meta(&transaction)?;
        transaction.commit()?;
        Ok(ViewOperationReceiptV1 {
            version: VIEW_RESPONSE_VERSION_V1,
            view: lifecycle.view().clone(),
            build_id: entry.handler.manifest().build_id.to_owned(),
            state,
            snapshot: snapshot(&meta),
            partition_key: None,
            next_cursor: None,
            affected_rows: 0,
            telemetry: telemetry(
                lifecycle.operation_name(),
                "ok",
                started,
                BTreeMap::new(),
                BTreeMap::new(),
            ),
        })
    }

    pub fn query(&self, request: &ViewQueryV1) -> Result<ViewQueryResponseV1, ViewError> {
        self.query_controlled(request, Arc::new(AtomicBool::new(false)), u64::MAX)
    }

    pub fn query_controlled(
        &self,
        request: &ViewQueryV1,
        cancelled: Arc<AtomicBool>,
        deadline_unix_ms: u64,
    ) -> Result<ViewQueryResponseV1, ViewError> {
        self.query_controlled_with_lease(request, cancelled, deadline_unix_ms, |_| true, || {})
    }

    /// Execute a controlled query while exposing the matching interrupt handle only for the
    /// interval in which this request owns the view connection mutex. Callers use the callbacks
    /// to atomically publish their active phase/handle and to clear both before mutex release.
    pub fn query_controlled_with_lease<Activate, Release>(
        &self,
        request: &ViewQueryV1,
        cancelled: Arc<AtomicBool>,
        deadline_unix_ms: u64,
        activate: Activate,
        release: Release,
    ) -> Result<ViewQueryResponseV1, ViewError>
    where
        Activate: FnOnce(Arc<InterruptHandle>) -> bool,
        Release: FnOnce(),
    {
        let started = Instant::now();
        validate_query(request)?;
        let entry = self.entry(&request.view)?;
        if !entry
            .handler
            .manifest()
            .accesses
            .iter()
            .any(|access| access.name == request.access)
        {
            return Err(ViewError::UnsupportedAccess {
                id: request.view.id.clone(),
                version: request.view.version,
                access: request.access.clone(),
            });
        }
        let connection = lock_controlled(&entry.connection, &cancelled, deadline_unix_ms)?;
        if !activate(Arc::clone(&entry.interrupt)) {
            release();
            return Err(ViewError::Interrupted);
        }
        let progress_cancelled = Arc::clone(&cancelled);
        connection.progress_handler(
            1_000,
            Some(move || {
                progress_cancelled.load(Ordering::Relaxed) || now_unix_ms() >= deadline_unix_ms
            }),
        );
        let result = (|| {
            if cancelled.load(Ordering::Acquire) || now_unix_ms() >= deadline_unix_ms {
                return Err(ViewError::Interrupted);
            }
            let meta = read_meta(&connection)?;
            match meta.state {
                ViewStateV1::Building => {
                    return Err(ViewError::ViewBuilding {
                        id: request.view.id.clone(),
                        version: request.view.version,
                    });
                }
                ViewStateV1::Failed => {
                    return Err(ViewError::ViewFailed {
                        id: request.view.id.clone(),
                        version: request.view.version,
                    });
                }
                ViewStateV1::Ready => {}
            }
            if meta.lag_ms > request.freshness.max_lag_ms {
                return Err(ViewError::FreshnessUnavailable {
                    available_lag_ms: meta.lag_ms,
                    maximum_lag_ms: request.freshness.max_lag_ms,
                });
            }
            let query_started = Instant::now();
            let result = entry.handler.execute(
                &connection,
                &request.access,
                &request.params,
                &request.authority,
            )?;
            let query_elapsed = elapsed_micros(query_started);
            let mut phases = BTreeMap::new();
            phases.insert("indexedPlan".to_owned(), query_elapsed);
            Ok(ViewQueryResponseV1 {
                version: VIEW_RESPONSE_VERSION_V1,
                view: request.view.clone(),
                build_id: entry.handler.manifest().build_id.to_owned(),
                access: request.access.clone(),
                snapshot: snapshot(&meta),
                result: result.value,
                telemetry: telemetry("execute", "ok", started, phases, result.counts),
            })
        })();
        connection.progress_handler(0, None::<fn() -> bool>);
        // `connection` still owns the per-view mutex here. Clear the caller's published
        // interrupt handle before another request can acquire and reuse this connection.
        release();
        result
    }

    fn entry(&self, identity: &ViewIdentityV1) -> Result<&ViewEntry, ViewError> {
        validate_identity(identity)?;
        self.entries
            .iter()
            .find(|entry| {
                let manifest = entry.handler.manifest();
                manifest.id == identity.id && manifest.version == identity.version
            })
            .ok_or_else(|| ViewError::UnsupportedView {
                id: identity.id.clone(),
                version: identity.version,
            })
    }
}

fn compiled_handlers() -> Vec<Box<dyn CompiledView>> {
    vec![Box::new(ConversationView), Box::new(ExactRangeView)]
}

fn view_root(legacy_database_path: &Path) -> Result<PathBuf, ViewError> {
    let name = legacy_database_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            ViewError::InvalidStorage(
                "legacy database path must end in a UTF-8 file name".to_owned(),
            )
        })?;
    Ok(legacy_database_path.with_file_name(format!("{name}.views-v2")))
}

fn view_file_name(manifest: &ViewManifestV1) -> String {
    match (manifest.id, manifest.version) {
        ("qq.session.conversation", 1) => "qq-session-conversation-v1.db".to_owned(),
        ("qq.test.exact-range", 1) => "qq-test-exact-range-v1.db".to_owned(),
        _ => unreachable!("every compiled view needs a fixed non-user-derived file name"),
    }
}

fn configure(connection: &Connection) -> Result<(), ViewError> {
    connection.busy_timeout(std::time::Duration::from_millis(250))?;
    connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;")?;
    Ok(())
}

fn create_store(
    connection: &Connection,
    manifest: &ViewManifestV1,
    handler: &dyn CompiledView,
) -> Result<(), ViewError> {
    let transaction = connection.unchecked_transaction()?;
    transaction.pragma_update(None, "application_id", VIEW_APPLICATION_ID)?;
    transaction.pragma_update(None, "user_version", VIEW_SCHEMA_VERSION)?;
    transaction.execute_batch(
        "CREATE TABLE view_meta (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            view_id TEXT NOT NULL,
            view_version INTEGER NOT NULL CHECK (view_version > 0),
            manifest_digest TEXT NOT NULL,
            build_id TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('building','ready','failed')),
            generation INTEGER NOT NULL CHECK (generation >= 0),
            source_fence TEXT NOT NULL,
            lag_ms INTEGER NOT NULL CHECK (lag_ms >= 0)
         ) STRICT;
         CREATE TABLE view_partitions (
            partition_key TEXT PRIMARY KEY,
            source_identity TEXT NOT NULL,
            durable_revision TEXT NOT NULL,
            next_cursor INTEGER NOT NULL CHECK (next_cursor >= 0),
            generation INTEGER NOT NULL CHECK (generation >= 0)
         ) STRICT;",
    )?;
    transaction.execute(
        "INSERT INTO view_meta VALUES (1, ?1, ?2, ?3, ?4, 'building', 0, 'uninitialized', 9223372036854775807)",
        params![manifest.id, manifest.version, manifest.digest, manifest.build_id],
    )?;
    handler.create_schema(&transaction)?;
    transaction.commit()?;
    Ok(())
}

fn validate_store(
    connection: &Connection,
    manifest: &ViewManifestV1,
    handler: &dyn CompiledView,
) -> Result<(), ViewError> {
    let application_id: i32 =
        connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let schema_version: i32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if application_id != VIEW_APPLICATION_ID || schema_version != VIEW_SCHEMA_VERSION {
        return Err(ViewError::InvalidStorage(
            "foreign or unsupported view database".to_owned(),
        ));
    }
    let identity: Option<(String, u32, String, String)> = connection.query_row(
        "SELECT view_id, view_version, manifest_digest, build_id FROM view_meta WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional()?;
    if identity
        != Some((
            manifest.id.to_owned(),
            manifest.version,
            manifest.digest.to_owned(),
            manifest.build_id.to_owned(),
        ))
    {
        return Err(ViewError::InvalidStorage(
            "view manifest identity mismatch".to_owned(),
        ));
    }
    handler.validate_schema(connection)
}

fn read_meta(connection: &Connection) -> Result<StoredMeta, ViewError> {
    connection
        .query_row(
            "SELECT state, generation, source_fence, lag_ms FROM view_meta WHERE singleton = 1",
            [],
            |row| {
                let state: String = row.get(0)?;
                let generation: i64 = row.get(1)?;
                let source_fence: String = row.get(2)?;
                let lag_ms: i64 = row.get(3)?;
                Ok((state, generation, source_fence, lag_ms))
            },
        )
        .map_err(ViewError::from)
        .and_then(|(state, generation, source_fence, lag_ms)| {
            Ok(StoredMeta {
                state: ViewStateV1::parse(&state)?,
                generation: sql_u64(generation, "generation")?,
                source_fence,
                lag_ms: sql_u64(lag_ms, "lagMs")?,
            })
        })
}

fn update_meta_progress(
    transaction: &Transaction<'_>,
    generation: u64,
    source_fence: &str,
    lag_ms: u64,
) -> Result<(), ViewError> {
    transaction.execute(
        "UPDATE view_meta SET generation = ?1, source_fence = ?2, lag_ms = ?3 WHERE singleton = 1",
        params![
            u64_sql(generation, "generation")?,
            source_fence,
            u64_sql(lag_ms, "lagMs")?
        ],
    )?;
    Ok(())
}

fn upsert_checkpoint(
    transaction: &Transaction<'_>,
    partition_key: &str,
    source: &ViewSourceCheckpointV1,
    generation: u64,
) -> Result<(), ViewError> {
    transaction.execute(
        "INSERT INTO view_partitions(partition_key, source_identity, durable_revision, next_cursor, generation)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(partition_key) DO UPDATE SET
           source_identity=excluded.source_identity, durable_revision=excluded.durable_revision,
           next_cursor=excluded.next_cursor, generation=excluded.generation",
        params![partition_key, source.source_identity, source.durable_revision,
            u64_sql(source.next_cursor, "nextCursor")?, u64_sql(generation, "generation")?],
    )?;
    Ok(())
}

fn validate_checkpoint(
    transaction: &Transaction<'_>,
    partition_key: &str,
    expected: u64,
    identity: &str,
) -> Result<(), ViewError> {
    let stored: Option<(String, i64)> = transaction
        .query_row(
            "SELECT source_identity, next_cursor FROM view_partitions WHERE partition_key = ?1",
            [partition_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((actual_identity, actual_cursor)) = stored else {
        return Err(ViewError::CursorConflict {
            expected,
            actual: 0,
        });
    };
    if actual_identity != identity {
        return Err(ViewError::SourceIdentityConflict);
    }
    let actual = sql_u64(actual_cursor, "nextCursor")?;
    if actual != expected {
        return Err(ViewError::CursorConflict { expected, actual });
    }
    Ok(())
}

fn validate_mutation(mutation: &ViewMutationV1) -> Result<(), ViewError> {
    validate_identity(mutation.view())?;
    match mutation {
        ViewMutationV1::ReplacePartition {
            partition_key,
            source,
            rows,
            ..
        } => {
            validate_partition_and_source(partition_key, source)?;
            if rows.len() > MAX_VIEW_ROWS_PER_MUTATION {
                return Err(ViewError::InvalidMutation(
                    "rows exceed mutation bound".to_owned(),
                ));
            }
            validate_payload_sizes(rows)?;
        }
        ViewMutationV1::ApplyDelta {
            partition_key,
            source,
            upserts,
            deletes,
            ..
        } => {
            validate_partition_and_source(partition_key, source)?;
            if upserts.len() > MAX_VIEW_ROWS_PER_MUTATION
                || deletes.len() > MAX_VIEW_DELETES_PER_MUTATION
            {
                return Err(ViewError::InvalidMutation(
                    "delta exceeds mutation bound".to_owned(),
                ));
            }
            validate_payload_sizes(upserts)?;
            for key in deletes {
                validate_text("delete row key", key, 1, 256, ViewError::InvalidMutation)?;
            }
        }
        ViewMutationV1::DeletePartition {
            partition_key,
            source_identity,
            source_fence,
            ..
        } => {
            validate_text(
                "partitionKey",
                partition_key,
                1,
                256,
                ViewError::InvalidMutation,
            )?;
            validate_text(
                "sourceIdentity",
                source_identity,
                1,
                MAX_TEXT_BYTES,
                ViewError::InvalidMutation,
            )?;
            validate_text(
                "sourceFence",
                source_fence,
                1,
                MAX_TEXT_BYTES,
                ViewError::InvalidMutation,
            )?;
        }
    }
    Ok(())
}

fn validate_partition_and_source(
    partition_key: &str,
    source: &ViewSourceCheckpointV1,
) -> Result<(), ViewError> {
    validate_text(
        "partitionKey",
        partition_key,
        1,
        256,
        ViewError::InvalidMutation,
    )?;
    validate_text(
        "sourceIdentity",
        &source.source_identity,
        1,
        MAX_TEXT_BYTES,
        ViewError::InvalidMutation,
    )?;
    validate_text(
        "durableRevision",
        &source.durable_revision,
        1,
        MAX_TEXT_BYTES,
        ViewError::InvalidMutation,
    )?;
    validate_text(
        "sourceFence",
        &source.source_fence,
        1,
        MAX_TEXT_BYTES,
        ViewError::InvalidMutation,
    )
}

fn validate_payload_sizes(rows: &[Value]) -> Result<(), ViewError> {
    let mut total = 0usize;
    for row in rows {
        total = total
            .checked_add(
                serde_json::to_vec(row)
                    .map_err(|error| ViewError::InvalidMutation(error.to_string()))?
                    .len(),
            )
            .ok_or_else(|| ViewError::InvalidMutation("row payload size overflow".to_owned()))?;
        if total > MAX_ROW_BYTES {
            return Err(ViewError::InvalidMutation(
                "row payload exceeds byte bound".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_query(request: &ViewQueryV1) -> Result<(), ViewError> {
    validate_identity(&request.view)?;
    validate_text("access", &request.access, 1, 128, ViewError::InvalidQuery)?;
    if request.authority.kind != "workspace-token-set/v1"
        || request.authority.scope_tokens.is_empty()
        || request.authority.scope_tokens.len() > 16
    {
        return Err(ViewError::AuthorizationRequired);
    }
    for token in &request.authority.scope_tokens {
        if token.is_empty()
            || token.len() > 64
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        {
            return Err(ViewError::InvalidQuery(
                "authority scope token is malformed".to_owned(),
            ));
        }
    }
    if request.freshness.mode != "caught-up" {
        return Err(ViewError::InvalidQuery(
            "freshness mode must be caught-up".to_owned(),
        ));
    }
    Ok(())
}

fn validate_identity(identity: &ViewIdentityV1) -> Result<(), ViewError> {
    validate_text("view id", &identity.id, 1, 128, ViewError::InvalidQuery)?;
    if identity.version == 0 {
        return Err(ViewError::InvalidQuery(
            "view version must be positive".to_owned(),
        ));
    }
    Ok(())
}

fn validate_text<F>(
    name: &str,
    value: &str,
    minimum: usize,
    maximum: usize,
    error: F,
) -> Result<(), ViewError>
where
    F: Fn(String) -> ViewError,
{
    let bytes = value.len();
    if bytes < minimum || bytes > maximum || value.contains('\0') {
        return Err(error(format!(
            "{name} must contain {minimum}..={maximum} UTF-8 bytes and no NUL"
        )));
    }
    Ok(())
}

fn snapshot(meta: &StoredMeta) -> ViewSnapshotV1 {
    ViewSnapshotV1 {
        generation: meta.generation,
        source_fence: meta.source_fence.clone(),
        lag_ms: meta.lag_ms,
    }
}

fn telemetry(
    operation: &str,
    outcome: &str,
    started: Instant,
    phases_micros: BTreeMap<String, u64>,
    counts: BTreeMap<String, u64>,
) -> ViewTelemetryV1 {
    ViewTelemetryV1 {
        operation: operation.to_owned(),
        outcome: outcome.to_owned(),
        elapsed_micros: elapsed_micros(started),
        phases_micros,
        counts,
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn elapsed_micros(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
}

fn lock_controlled<'a>(
    connection: &'a Mutex<Connection>,
    cancelled: &AtomicBool,
    deadline_unix_ms: u64,
) -> Result<MutexGuard<'a, Connection>, ViewError> {
    loop {
        if cancelled.load(Ordering::Acquire) || now_unix_ms() >= deadline_unix_ms {
            return Err(ViewError::Interrupted);
        }
        match connection.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => return Err(ViewError::LockPoisoned),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(1)),
        }
    }
}

fn lock(connection: &Mutex<Connection>) -> Result<MutexGuard<'_, Connection>, ViewError> {
    connection.lock().map_err(|_| ViewError::LockPoisoned)
}

fn u64_sql(value: u64, name: &str) -> Result<i64, ViewError> {
    i64::try_from(value)
        .map_err(|_| ViewError::InvalidMutation(format!("{name} exceeds SQLite integer range")))
}

fn sql_u64(value: i64, name: &str) -> Result<u64, ViewError> {
    u64::try_from(value).map_err(|_| ViewError::InvalidStorage(format!("{name} is negative")))
}

pub(crate) fn parse_row<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T, ViewError> {
    serde_json::from_value(value.clone())
        .map_err(|error| ViewError::InvalidMutation(error.to_string()))
}

pub(crate) fn invalid_mutation(message: impl Into<String>) -> ViewError {
    ViewError::InvalidMutation(message.into())
}

pub(crate) fn invalid_query(message: impl Into<String>) -> ViewError {
    ViewError::InvalidQuery(message.into())
}

pub(crate) fn checked_text(value: &str, name: &str, maximum: usize) -> Result<(), ViewError> {
    validate_text(name, value, 1, maximum, ViewError::InvalidMutation)
}

pub(crate) fn checked_optional_text(
    value: &str,
    name: &str,
    maximum: usize,
) -> Result<(), ViewError> {
    validate_text(name, value, 0, maximum, ViewError::InvalidMutation)
}

pub(crate) fn checked_scope_token(value: &str) -> Result<(), ViewError> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return Err(invalid_mutation(
            "workspaceScopeToken must be lowercase ASCII alphanumeric",
        ));
    }
    Ok(())
}

pub(crate) fn to_sql_u64(value: u64, name: &str) -> Result<i64, ViewError> {
    u64_sql(value, name)
}
pub(crate) fn from_sql_u64(value: i64, name: &str) -> Result<u64, ViewError> {
    sql_u64(value, name)
}
pub(crate) fn quote_fts(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
