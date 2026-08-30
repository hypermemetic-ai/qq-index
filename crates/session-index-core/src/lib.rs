//! Durable derived storage foundation for qq session-history indexing.
//!
//! This crate owns schema validation, incremental projected-document ingestion,
//! and bounded synchronous batch retrieval on one connection. Reader pooling,
//! cancellation, daemon transport, DSH projection, and resumable backfill are
//! deliberately later phases.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use thiserror::Error;

mod search;
pub use search::*;

/// SQLite application id: ASCII `QSI1`.
pub const APPLICATION_ID: i32 = 0x5153_4931;
/// First on-disk schema version.
pub const SCHEMA_VERSION: i32 = 1;
/// Projection contract stored with the derived index.
pub const PROJECTION_VERSION: &str = "qq-session-projection-v1";
/// Fixed schema-shape marker checked on every open.
pub const SCHEMA_FINGERPRINT: &str = "qq-session-index-schema-v1";

const BUSY_TIMEOUT: Duration = Duration::from_millis(250);
pub(crate) const MAX_SESSION_ID_BYTES: usize = 128;
pub(crate) const MAX_WORKSPACE_BYTES: usize = 4_096;
const MAX_EVENT_TYPE_BYTES: usize = 96;
pub(crate) const MAX_SURFACE_BYTES: usize = 64;
const MAX_BODY_BYTES: usize = 1_048_576;
const MAX_FINGERPRINT_BYTES: usize = 256;
const MAX_REVISION_BYTES: usize = 256;
const MAX_BATCH_KEY_BYTES: usize = 256;
pub(crate) const MAX_SCOPE_TOKENS: usize = 16;
pub(crate) const MAX_SCOPE_TOKEN_BYTES: usize = 64;
const MAX_BATCH_DOCUMENTS: usize = 10_000;

const SCHEMA_SQL: &str = r#"
CREATE TABLE index_meta (
    singleton          INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation         INTEGER NOT NULL CHECK (generation >= 0),
    source_watermark   INTEGER NOT NULL CHECK (source_watermark >= 0),
    projection_version TEXT NOT NULL,
    schema_fingerprint TEXT NOT NULL
) STRICT;
INSERT INTO index_meta(
    singleton, generation, source_watermark, projection_version, schema_fingerprint
)
VALUES (
    1, 0, 0, 'qq-session-projection-v1', 'qq-session-index-schema-v1'
);

CREATE TABLE sessions (
    session_id      TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL,
    next_seq        INTEGER NOT NULL CHECK (next_seq >= 0),
    header_revision TEXT NOT NULL
) STRICT;

CREATE TABLE documents (
    doc_id             INTEGER PRIMARY KEY,
    session_id         TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    seq                INTEGER NOT NULL CHECK (seq >= 0),
    event_time_unix_ms INTEGER NOT NULL,
    event_type         TEXT NOT NULL,
    surface            TEXT NOT NULL,
    workspace_id       TEXT NOT NULL,
    scope_terms        TEXT NOT NULL,
    body               TEXT NOT NULL,
    fingerprint        TEXT NOT NULL,
    source_revision    TEXT NOT NULL,
    UNIQUE(session_id, seq)
) STRICT;
CREATE INDEX documents_session_time ON documents(session_id, event_time_unix_ms, seq);
CREATE INDEX documents_metadata ON documents(workspace_id, surface, event_time_unix_ms, session_id, seq);

CREATE VIRTUAL TABLE documents_fts USING fts5(
    body,
    scope_terms,
    content='documents',
    content_rowid='doc_id',
    tokenize='unicode61'
);

CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, body, scope_terms)
  VALUES (new.doc_id, new.body, new.scope_terms);
END;
CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, body, scope_terms)
  VALUES ('delete', old.doc_id, old.body, old.scope_terms);
END;
CREATE TRIGGER documents_au AFTER UPDATE OF body, scope_terms ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, body, scope_terms)
  VALUES ('delete', old.doc_id, old.body, old.scope_terms);
  INSERT INTO documents_fts(rowid, body, scope_terms)
  VALUES (new.doc_id, new.body, new.scope_terms);
END;

CREATE TABLE ingest_batches (
    idempotency_key    TEXT PRIMARY KEY,
    payload_fingerprint TEXT NOT NULL,
    source_watermark   INTEGER NOT NULL CHECK (source_watermark >= 0),
    generation         INTEGER NOT NULL CHECK (generation > 0),
    inserted_documents INTEGER NOT NULL CHECK (inserted_documents >= 0),
    replayed_documents INTEGER NOT NULL CHECK (replayed_documents >= 0)
) STRICT;
"#;

/// Errors fail closed; opening never mutates a foreign or unsupported database.
#[derive(Debug, Error)]
pub enum IndexError {
    #[error("session index already exists at {0}")]
    AlreadyExists(PathBuf),
    #[error("session index does not exist at {0}")]
    NotFound(PathBuf),
    #[error(
        "refusing foreign SQLite database (application_id={application_id}, user_version={user_version})"
    )]
    ForeignDatabase {
        application_id: i32,
        user_version: i32,
    },
    #[error("unsupported session-index schema version {found}; expected {expected}")]
    UnsupportedSchema { found: i32, expected: i32 },
    #[error("session-index schema is incomplete: {0}")]
    InvalidSchema(String),
    #[error("invalid projected mutation: {0}")]
    InvalidMutation(String),
    #[error("invalid search-batch-v1 request: {0}")]
    InvalidSearch(String),
    #[error(
        "source watermark {available} at generation {generation} is below required watermark {minimum}"
    )]
    SourceWatermarkUnavailable {
        minimum: u64,
        available: u64,
        generation: u64,
    },
    #[error("source watermark {next} does not advance current watermark {current}")]
    NonMonotonicWatermark { current: u64, next: u64 },
    #[error("idempotency key {key:?} was reused with different content")]
    IdempotencyConflict { key: String },
    #[error("session {session_id:?} expected seq {expected}, received {actual}")]
    SequenceGap {
        session_id: String,
        expected: u64,
        actual: u64,
    },
    #[error("session {session_id:?} seq {seq} conflicts with the indexed document")]
    DocumentConflict { session_id: String, seq: u64 },
    #[error("session {session_id:?} changed workspace from {expected:?} to {actual:?}")]
    WorkspaceConflict {
        session_id: String,
        expected: String,
        actual: String,
    },
    #[error("session-index lock was poisoned")]
    LockPoisoned,
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// One already-projected searchable DSH event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectedDocument {
    pub session_id: String,
    pub seq: u64,
    pub event_time_unix_ms: i64,
    pub event_type: String,
    pub surface: String,
    pub workspace_id: String,
    pub scope_tokens: Vec<String>,
    pub body: String,
    pub fingerprint: String,
    pub source_revision: String,
}

/// One atomic, replay-safe mutation received from a trusted projection adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MutationBatch {
    pub idempotency_key: String,
    pub payload_fingerprint: String,
    pub source_watermark: u64,
    pub documents: Vec<ProjectedDocument>,
}

/// Durable state returned after a batch commit or exact batch replay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitReceipt {
    pub generation: u64,
    pub source_watermark: u64,
    pub inserted_documents: usize,
    pub replayed_documents: usize,
    pub batch_replayed: bool,
}

/// Current durable index generation and source progress.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexMetadata {
    pub generation: u64,
    pub source_watermark: u64,
    pub projection_version: String,
}

/// Single-connection Phase 1A storage core.
///
/// The mutex serializes current operations. A later service milestone will add a
/// writer and bounded read pool without changing the on-disk contract.
pub struct SessionIndex {
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl SessionIndex {
    /// Create a fresh derived index. Existing paths are never adopted implicitly.
    pub fn create(path: impl AsRef<Path>) -> Result<Self, IndexError> {
        let path = path.as_ref().to_path_buf();
        if path.exists() {
            return Err(IndexError::AlreadyExists(path));
        }
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        validate_empty_database(&connection)?;
        configure_connection(&connection)?;
        ensure_fts5(&connection)?;
        let transaction = connection.unchecked_transaction()?;
        transaction.execute_batch(SCHEMA_SQL)?;
        transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
        validate_schema(&connection)?;
        Ok(Self {
            path,
            connection: Mutex::new(connection),
        })
    }

    /// Open an existing index without source discovery, migration, or backfill.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, IndexError> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Err(IndexError::NotFound(path));
        }
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // Validate all durable identity/schema metadata before any PRAGMA below can
        // persistently alter a malformed or spoofed database.
        validate_schema(&connection)?;
        ensure_fts5(&connection)?;
        configure_connection(&connection)?;
        Ok(Self {
            path,
            connection: Mutex::new(connection),
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn metadata(&self) -> Result<IndexMetadata, IndexError> {
        let connection = self.lock()?;
        read_metadata(&connection)
    }

    pub fn document_count(&self) -> Result<u64, IndexError> {
        let count: i64 = self
            .lock()?
            .query_row("SELECT count(*) FROM documents", [], |row| row.get(0))?;
        i64_to_u64(count, "document count")
    }

    /// Apply a normalized incremental batch in one atomic transaction.
    pub fn apply_batch(&self, batch: &MutationBatch) -> Result<CommitReceipt, IndexError> {
        validate_batch(batch)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(receipt) = replay_receipt(&transaction, batch)? {
            transaction.rollback()?;
            return Ok(receipt);
        }

        let current = read_metadata_tx(&transaction)?;
        if batch.source_watermark <= current.source_watermark {
            return Err(IndexError::NonMonotonicWatermark {
                current: current.source_watermark,
                next: batch.source_watermark,
            });
        }

        let mut inserted_documents = 0usize;
        let mut replayed_documents = 0usize;
        for document in &batch.documents {
            let scope_terms = canonical_scope_terms(&document.scope_tokens)?;
            match session_state(&transaction, &document.session_id)? {
                None => {
                    if document.seq != 0 {
                        return Err(IndexError::SequenceGap {
                            session_id: document.session_id.clone(),
                            expected: 0,
                            actual: document.seq,
                        });
                    }
                    transaction.execute(
                        "INSERT INTO sessions(session_id, workspace_id, next_seq, header_revision) VALUES (?1, ?2, 0, ?3)",
                        params![document.session_id, document.workspace_id, document.source_revision],
                    )?;
                    insert_document(&transaction, document, &scope_terms)?;
                    update_session_after_insert(&transaction, document)?;
                    inserted_documents += 1;
                }
                Some((next_seq, workspace_id)) => {
                    if workspace_id != document.workspace_id {
                        return Err(IndexError::WorkspaceConflict {
                            session_id: document.session_id.clone(),
                            expected: workspace_id,
                            actual: document.workspace_id.clone(),
                        });
                    }
                    if document.seq > next_seq {
                        return Err(IndexError::SequenceGap {
                            session_id: document.session_id.clone(),
                            expected: next_seq,
                            actual: document.seq,
                        });
                    }
                    if document.seq < next_seq {
                        if stored_document_matches(&transaction, document, &scope_terms)? {
                            replayed_documents += 1;
                            continue;
                        }
                        return Err(IndexError::DocumentConflict {
                            session_id: document.session_id.clone(),
                            seq: document.seq,
                        });
                    }
                    insert_document(&transaction, document, &scope_terms)?;
                    update_session_after_insert(&transaction, document)?;
                    inserted_documents += 1;
                }
            }
        }

        let generation = current
            .generation
            .checked_add(1)
            .ok_or_else(|| IndexError::InvalidSchema("generation overflow".to_owned()))?;
        transaction.execute(
            "UPDATE index_meta SET generation = ?1, source_watermark = ?2 WHERE singleton = 1",
            params![
                u64_to_i64(generation, "generation")?,
                u64_to_i64(batch.source_watermark, "source watermark")?
            ],
        )?;
        transaction.execute(
            "INSERT INTO ingest_batches(idempotency_key, payload_fingerprint, source_watermark, generation, inserted_documents, replayed_documents) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                batch.idempotency_key,
                batch.payload_fingerprint,
                u64_to_i64(batch.source_watermark, "source watermark")?,
                u64_to_i64(generation, "generation")?,
                usize_to_i64(inserted_documents, "inserted document count")?,
                usize_to_i64(replayed_documents, "replayed document count")?,
            ],
        )?;
        transaction.commit()?;
        Ok(CommitReceipt {
            generation,
            source_watermark: batch.source_watermark,
            inserted_documents,
            replayed_documents,
            batch_replayed: false,
        })
    }

    /// Search 1--5 literals serially in one explicit read transaction on this
    /// index's single connection. This Phase 1A API does not provide concurrent
    /// production serving, deadline interruption, or cancellation.
    pub fn search_batch_v1(
        &self,
        request: &SearchBatchV1,
    ) -> Result<SearchBatchResponseV1, IndexError> {
        let mut connection = self.lock()?;
        search_batch_v1_on_connection(&mut connection, request)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, IndexError> {
        self.connection.lock().map_err(|_| IndexError::LockPoisoned)
    }
}

fn validate_empty_database(connection: &Connection) -> Result<(), IndexError> {
    let application_id: i32 =
        connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let user_version: i32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let object_count: i64 = connection.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    if application_id != 0 || user_version != 0 || object_count != 0 {
        return Err(IndexError::ForeignDatabase {
            application_id,
            user_version,
        });
    }
    Ok(())
}

fn configure_connection(connection: &Connection) -> Result<(), IndexError> {
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "trusted_schema", "OFF")?;
    let journal_mode: String =
        connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(IndexError::InvalidSchema(format!(
            "SQLite refused WAL mode: {journal_mode}"
        )));
    }
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

fn ensure_fts5(connection: &Connection) -> Result<(), IndexError> {
    let enabled: i64 = connection.query_row(
        "SELECT sqlite_compileoption_used('ENABLE_FTS5')",
        [],
        |row| row.get(0),
    )?;
    if enabled != 1 {
        return Err(IndexError::InvalidSchema(
            "bundled SQLite does not include FTS5".to_owned(),
        ));
    }
    Ok(())
}

fn validate_identity(connection: &Connection) -> Result<(), IndexError> {
    let application_id: i32 =
        connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let user_version: i32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if application_id != APPLICATION_ID {
        return Err(IndexError::ForeignDatabase {
            application_id,
            user_version,
        });
    }
    if user_version != SCHEMA_VERSION {
        return Err(IndexError::UnsupportedSchema {
            found: user_version,
            expected: SCHEMA_VERSION,
        });
    }
    Ok(())
}

fn validate_schema(connection: &Connection) -> Result<(), IndexError> {
    validate_identity(connection)?;
    for (object, expected_type) in [
        ("index_meta", "table"),
        ("sessions", "table"),
        ("documents", "table"),
        ("documents_fts", "table"),
        ("ingest_batches", "table"),
        ("documents_session_time", "index"),
        ("documents_metadata", "index"),
        ("documents_ai", "trigger"),
        ("documents_ad", "trigger"),
        ("documents_au", "trigger"),
    ] {
        let object_type: Option<String> = connection
            .query_row(
                "SELECT type FROM sqlite_schema WHERE name = ?1",
                [object],
                |row| row.get(0),
            )
            .optional()?;
        if object_type.as_deref() != Some(expected_type) {
            return Err(IndexError::InvalidSchema(format!(
                "required {expected_type} {object:?} is missing or has the wrong type"
            )));
        }
    }
    let metadata_rows: i64 =
        connection.query_row("SELECT count(*) FROM index_meta", [], |row| row.get(0))?;
    if metadata_rows != 1 {
        return Err(IndexError::InvalidSchema(
            "metadata table must contain exactly one row".to_owned(),
        ));
    }
    let metadata = read_metadata(connection)?;
    if metadata.projection_version != PROJECTION_VERSION {
        return Err(IndexError::InvalidSchema(format!(
            "unsupported projection version {:?}",
            metadata.projection_version
        )));
    }
    Ok(())
}

fn read_metadata(connection: &Connection) -> Result<IndexMetadata, IndexError> {
    let (generation, watermark, projection, schema_fingerprint): (i64, i64, String, String) =
        connection.query_row(
            "SELECT generation, source_watermark, projection_version, schema_fingerprint FROM index_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    if schema_fingerprint != SCHEMA_FINGERPRINT {
        return Err(IndexError::InvalidSchema(format!(
            "unsupported schema fingerprint {schema_fingerprint:?}"
        )));
    }
    Ok(IndexMetadata {
        generation: i64_to_u64(generation, "generation")?,
        source_watermark: i64_to_u64(watermark, "source watermark")?,
        projection_version: projection,
    })
}

pub(crate) fn read_metadata_tx(transaction: &Transaction<'_>) -> Result<IndexMetadata, IndexError> {
    let (generation, watermark, projection, schema_fingerprint): (i64, i64, String, String) =
        transaction.query_row(
            "SELECT generation, source_watermark, projection_version, schema_fingerprint FROM index_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    if schema_fingerprint != SCHEMA_FINGERPRINT {
        return Err(IndexError::InvalidSchema(format!(
            "unsupported schema fingerprint {schema_fingerprint:?}"
        )));
    }
    Ok(IndexMetadata {
        generation: i64_to_u64(generation, "generation")?,
        source_watermark: i64_to_u64(watermark, "source watermark")?,
        projection_version: projection,
    })
}

fn replay_receipt(
    transaction: &Transaction<'_>,
    batch: &MutationBatch,
) -> Result<Option<CommitReceipt>, IndexError> {
    let stored: Option<(String, i64, i64, i64, i64)> = transaction
        .query_row(
            "SELECT payload_fingerprint, source_watermark, generation, inserted_documents, replayed_documents FROM ingest_batches WHERE idempotency_key = ?1",
            [&batch.idempotency_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    let Some((fingerprint, watermark, generation, inserted, replayed)) = stored else {
        return Ok(None);
    };
    let stored_count = inserted.checked_add(replayed).ok_or_else(|| {
        IndexError::InvalidSchema("stored replay document count overflow".to_owned())
    })?;
    let mut exact_replay = fingerprint == batch.payload_fingerprint
        && i64_to_u64(watermark, "stored source watermark")? == batch.source_watermark
        && i64_to_usize(stored_count, "stored batch document count")? == batch.documents.len();
    if exact_replay {
        for document in &batch.documents {
            let scope_terms = canonical_scope_terms(&document.scope_tokens)?;
            if !stored_document_matches(transaction, document, &scope_terms)? {
                exact_replay = false;
                break;
            }
        }
    }
    if !exact_replay {
        return Err(IndexError::IdempotencyConflict {
            key: batch.idempotency_key.clone(),
        });
    }
    Ok(Some(CommitReceipt {
        generation: i64_to_u64(generation, "stored generation")?,
        source_watermark: batch.source_watermark,
        inserted_documents: i64_to_usize(inserted, "stored inserted document count")?,
        replayed_documents: i64_to_usize(replayed, "stored replayed document count")?,
        batch_replayed: true,
    }))
}

fn session_state(
    transaction: &Transaction<'_>,
    session_id: &str,
) -> Result<Option<(u64, String)>, IndexError> {
    let stored: Option<(i64, String)> = transaction
        .query_row(
            "SELECT next_seq, workspace_id FROM sessions WHERE session_id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    stored
        .map(|(seq, workspace)| Ok((i64_to_u64(seq, "session next_seq")?, workspace)))
        .transpose()
}

fn insert_document(
    transaction: &Transaction<'_>,
    document: &ProjectedDocument,
    scope_terms: &str,
) -> Result<(), IndexError> {
    transaction.execute(
        "INSERT INTO documents(session_id, seq, event_time_unix_ms, event_type, surface, workspace_id, scope_terms, body, fingerprint, source_revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            document.session_id,
            u64_to_i64(document.seq, "document seq")?,
            document.event_time_unix_ms,
            document.event_type,
            document.surface,
            document.workspace_id,
            scope_terms,
            document.body,
            document.fingerprint,
            document.source_revision,
        ],
    )?;
    Ok(())
}

fn update_session_after_insert(
    transaction: &Transaction<'_>,
    document: &ProjectedDocument,
) -> Result<(), IndexError> {
    let next_seq = document
        .seq
        .checked_add(1)
        .ok_or_else(|| IndexError::InvalidMutation("document seq overflow".to_owned()))?;
    transaction.execute(
        "UPDATE sessions SET next_seq = ?1, header_revision = ?2 WHERE session_id = ?3",
        params![
            u64_to_i64(next_seq, "session next_seq")?,
            document.source_revision,
            document.session_id,
        ],
    )?;
    Ok(())
}

fn stored_document_matches(
    transaction: &Transaction<'_>,
    document: &ProjectedDocument,
    scope_terms: &str,
) -> Result<bool, IndexError> {
    let matches: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM documents WHERE session_id = ?1 AND seq = ?2 AND event_time_unix_ms = ?3 AND event_type = ?4 AND surface = ?5 AND workspace_id = ?6 AND scope_terms = ?7 AND body = ?8 AND fingerprint = ?9 AND source_revision = ?10)",
        params![
            document.session_id,
            u64_to_i64(document.seq, "document seq")?,
            document.event_time_unix_ms,
            document.event_type,
            document.surface,
            document.workspace_id,
            scope_terms,
            document.body,
            document.fingerprint,
            document.source_revision,
        ],
        |row| row.get(0),
    )?;
    Ok(matches)
}

fn validate_batch(batch: &MutationBatch) -> Result<(), IndexError> {
    validate_text(
        "idempotency key",
        &batch.idempotency_key,
        1,
        MAX_BATCH_KEY_BYTES,
    )?;
    validate_text(
        "payload fingerprint",
        &batch.payload_fingerprint,
        1,
        MAX_FINGERPRINT_BYTES,
    )?;
    if batch.source_watermark == 0 {
        return Err(IndexError::InvalidMutation(
            "source watermark must be positive".to_owned(),
        ));
    }
    if batch.documents.is_empty() || batch.documents.len() > MAX_BATCH_DOCUMENTS {
        return Err(IndexError::InvalidMutation(format!(
            "document batch length must be 1..={MAX_BATCH_DOCUMENTS}"
        )));
    }
    let mut last_seq_by_session = BTreeMap::new();
    for document in &batch.documents {
        validate_document(document)?;
        if let Some(previous) =
            last_seq_by_session.insert(document.session_id.as_str(), document.seq)
        {
            let expected = previous.checked_add(1).ok_or_else(|| {
                IndexError::InvalidMutation("document seq overflow inside batch".to_owned())
            })?;
            if document.seq != expected {
                return Err(IndexError::InvalidMutation(format!(
                    "documents for session {:?} must be contiguous and increasing; expected seq {expected}, received {}",
                    document.session_id, document.seq
                )));
            }
        }
    }
    Ok(())
}

fn validate_document(document: &ProjectedDocument) -> Result<(), IndexError> {
    validate_text("session id", &document.session_id, 1, MAX_SESSION_ID_BYTES)?;
    if document.seq > i64::MAX as u64 {
        return Err(IndexError::InvalidMutation(
            "document seq exceeds SQLite integer range".to_owned(),
        ));
    }
    validate_text("event type", &document.event_type, 1, MAX_EVENT_TYPE_BYTES)?;
    validate_text("surface", &document.surface, 1, MAX_SURFACE_BYTES)?;
    validate_text(
        "workspace id",
        &document.workspace_id,
        1,
        MAX_WORKSPACE_BYTES,
    )?;
    validate_text("body", &document.body, 1, MAX_BODY_BYTES)?;
    validate_text(
        "document fingerprint",
        &document.fingerprint,
        1,
        MAX_FINGERPRINT_BYTES,
    )?;
    validate_text(
        "source revision",
        &document.source_revision,
        1,
        MAX_REVISION_BYTES,
    )?;
    canonical_scope_terms(&document.scope_tokens)?;
    Ok(())
}

pub(crate) fn validate_text(
    name: &str,
    value: &str,
    minimum_bytes: usize,
    maximum_bytes: usize,
) -> Result<(), IndexError> {
    let length = value.len();
    if length < minimum_bytes || length > maximum_bytes || value.contains('\0') {
        return Err(IndexError::InvalidMutation(format!(
            "{name} must contain {minimum_bytes}..={maximum_bytes} UTF-8 bytes and no NUL"
        )));
    }
    Ok(())
}

pub(crate) fn canonical_scope_terms(tokens: &[String]) -> Result<String, IndexError> {
    if tokens.is_empty() || tokens.len() > MAX_SCOPE_TOKENS {
        return Err(IndexError::InvalidMutation(format!(
            "scope token count must be 1..={MAX_SCOPE_TOKENS}"
        )));
    }
    let mut canonical = BTreeSet::new();
    for token in tokens {
        validate_scope_token(token)?;
        canonical.insert(token.as_str());
    }
    Ok(canonical.into_iter().collect::<Vec<_>>().join(" "))
}

pub(crate) fn validate_scope_token(token: &str) -> Result<(), IndexError> {
    if token.is_empty()
        || token.len() > MAX_SCOPE_TOKEN_BYTES
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return Err(IndexError::InvalidMutation(format!(
            "scope token must be 1..={MAX_SCOPE_TOKEN_BYTES} lowercase ASCII alphanumeric bytes"
        )));
    }
    Ok(())
}

pub(crate) fn quoted_fts_phrase(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub(crate) fn u64_to_i64(value: u64, name: &str) -> Result<i64, IndexError> {
    i64::try_from(value)
        .map_err(|_| IndexError::InvalidMutation(format!("{name} exceeds SQLite integer range")))
}

fn usize_to_i64(value: usize, name: &str) -> Result<i64, IndexError> {
    i64::try_from(value)
        .map_err(|_| IndexError::InvalidMutation(format!("{name} exceeds SQLite integer range")))
}

pub(crate) fn i64_to_u64(value: i64, name: &str) -> Result<u64, IndexError> {
    u64::try_from(value)
        .map_err(|_| IndexError::InvalidSchema(format!("{name} is negative or invalid")))
}

fn i64_to_usize(value: i64, name: &str) -> Result<usize, IndexError> {
    usize::try_from(value)
        .map_err(|_| IndexError::InvalidSchema(format!("{name} is negative or invalid")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn document(session: &str, seq: u64, body: &str, scopes: &[&str]) -> ProjectedDocument {
        ProjectedDocument {
            session_id: session.to_owned(),
            seq,
            event_time_unix_ms: 1_700_000_000_000 + i64::try_from(seq).unwrap(),
            event_type: "user/message".to_owned(),
            surface: "conversation".to_owned(),
            workspace_id: "workspace-a".to_owned(),
            scope_tokens: scopes.iter().map(|value| (*value).to_owned()).collect(),
            body: body.to_owned(),
            fingerprint: format!("fingerprint-{session}-{seq}"),
            source_revision: format!("revision-{session}-{seq}"),
        }
    }

    fn batch(key: &str, watermark: u64, documents: Vec<ProjectedDocument>) -> MutationBatch {
        MutationBatch {
            idempotency_key: key.to_owned(),
            payload_fingerprint: format!("payload-{key}"),
            source_watermark: watermark,
            documents,
        }
    }

    fn index() -> (TempDir, PathBuf, SessionIndex) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("index.db");
        let index = SessionIndex::create(&path).unwrap();
        (root, path, index)
    }

    #[test]
    fn creates_reopens_and_rejects_foreign_or_wrong_versions() {
        let (_root, path, index) = index();
        assert_eq!(
            index.metadata().unwrap(),
            IndexMetadata {
                generation: 0,
                source_watermark: 0,
                projection_version: PROJECTION_VERSION.to_owned(),
            }
        );
        {
            let connection = index.lock().unwrap();
            let foreign_keys: i64 = connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                .unwrap();
            let trusted_schema: i64 = connection
                .query_row("PRAGMA trusted_schema", [], |row| row.get(0))
                .unwrap();
            let busy_timeout_ms: i64 = connection
                .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
                .unwrap();
            assert_eq!(foreign_keys, 1);
            assert_eq!(trusted_schema, 0);
            assert_eq!(busy_timeout_ms, 250);
        }
        drop(index);
        let reopened = SessionIndex::open(&path).unwrap();
        assert_eq!(reopened.document_count().unwrap(), 0);
        drop(reopened);

        let foreign_root = tempfile::tempdir().unwrap();
        let foreign_path = foreign_root.path().join("foreign.db");
        let foreign = Connection::open(&foreign_path).unwrap();
        foreign
            .execute("CREATE TABLE private_data(value TEXT)", [])
            .unwrap();
        drop(foreign);
        assert!(matches!(
            SessionIndex::open(&foreign_path),
            Err(IndexError::ForeignDatabase { .. })
        ));
        let foreign = Connection::open(&foreign_path).unwrap();
        assert_eq!(
            foreign
                .query_row("SELECT count(*) FROM private_data", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );

        let version_root = tempfile::tempdir().unwrap();
        let version_path = version_root.path().join("version.db");
        drop(SessionIndex::create(&version_path).unwrap());
        let version = Connection::open(&version_path).unwrap();
        version.pragma_update(None, "user_version", 999).unwrap();
        drop(version);
        assert!(matches!(
            SessionIndex::open(&version_path),
            Err(IndexError::UnsupportedSchema {
                found: 999,
                expected: SCHEMA_VERSION
            })
        ));
    }

    #[test]
    fn incrementally_ingests_replays_and_advances_generation() {
        let (_root, path, index) = index();
        let first = batch(
            "batch-1",
            10,
            vec![
                document("session-a", 0, "aurora alpha", &["scopea"]),
                document("session-a", 1, "cobalt beta", &["scopea"]),
            ],
        );
        let receipt = index.apply_batch(&first).unwrap();
        assert_eq!(receipt.generation, 1);
        assert_eq!(receipt.inserted_documents, 2);
        assert!(!receipt.batch_replayed);
        assert_eq!(index.document_count().unwrap(), 2);

        let replay = index.apply_batch(&first).unwrap();
        assert!(replay.batch_replayed);
        assert_eq!(replay.generation, 1);
        assert_eq!(index.metadata().unwrap().source_watermark, 10);

        let second = batch(
            "batch-2",
            11,
            vec![document("session-a", 2, "lattice gamma", &["scopea"])],
        );
        let receipt = index.apply_batch(&second).unwrap();
        assert_eq!(receipt.generation, 2);
        assert_eq!(index.document_count().unwrap(), 3);
        drop(index);

        let reopened = SessionIndex::open(&path).unwrap();
        assert_eq!(reopened.metadata().unwrap().generation, 2);
        assert_eq!(reopened.metadata().unwrap().source_watermark, 11);
        assert_eq!(reopened.document_count().unwrap(), 3);
    }

    #[test]
    fn rejects_gaps_conflicts_and_non_monotonic_batches_atomically() {
        let (_root, _path, index) = index();
        let gap = batch(
            "gap",
            1,
            vec![document("session-gap", 1, "gap", &["scopea"])],
        );
        assert!(matches!(
            index.apply_batch(&gap),
            Err(IndexError::SequenceGap {
                expected: 0,
                actual: 1,
                ..
            })
        ));
        assert_eq!(index.metadata().unwrap().generation, 0);
        assert_eq!(index.document_count().unwrap(), 0);

        let first = batch(
            "first",
            2,
            vec![document("session-a", 0, "original", &["scopea"])],
        );
        index.apply_batch(&first).unwrap();

        let mut conflicting = document("session-a", 0, "changed", &["scopea"]);
        conflicting.fingerprint = "other-fingerprint".to_owned();
        assert!(matches!(
            index.apply_batch(&batch("conflict", 3, vec![conflicting])),
            Err(IndexError::DocumentConflict { seq: 0, .. })
        ));
        assert_eq!(index.metadata().unwrap().generation, 1);
        assert_eq!(index.document_count().unwrap(), 1);

        let same_watermark = batch(
            "same-watermark",
            2,
            vec![document("session-a", 1, "next", &["scopea"])],
        );
        assert!(matches!(
            index.apply_batch(&same_watermark),
            Err(IndexError::NonMonotonicWatermark {
                current: 2,
                next: 2
            })
        ));
        assert_eq!(index.document_count().unwrap(), 1);

        let mut changed_key = first.clone();
        changed_key.payload_fingerprint = "different".to_owned();
        assert!(matches!(
            index.apply_batch(&changed_key),
            Err(IndexError::IdempotencyConflict { .. })
        ));
    }
}
