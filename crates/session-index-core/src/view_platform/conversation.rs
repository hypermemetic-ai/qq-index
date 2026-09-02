use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, Transaction, params, params_from_iter};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    CompiledView, HandlerQueryResult, ViewAccessManifestV1, ViewAuthorityV1, ViewError,
    ViewManifestV1, checked_optional_text, checked_scope_token, checked_text, from_sql_u64,
    invalid_mutation, invalid_query, parse_row, quote_fts, to_sql_u64,
};

const MAX_LITERAL_BYTES: usize = 512;
const MAX_BODY_BYTES: usize = 1_048_576;
const MAX_TITLE_BYTES: usize = 4_096;
const MAX_FILTERS: usize = 32;
const POSTING_BUDGET_PER_LITERAL: usize = 256;
const MAX_LIMIT: usize = 100;
const RRF_K: f64 = 60.0;

static ACCESSES: &[ViewAccessManifestV1] = &[ViewAccessManifestV1 {
    name: "literal-session-search",
    maximum_results: MAX_LIMIT,
    maximum_work_units: POSTING_BUDGET_PER_LITERAL * 5,
    authorization: "workspace-token-set/v1:pre-rank",
}];

pub static MANIFEST: ViewManifestV1 = ViewManifestV1 {
    id: "qq.session.conversation",
    version: 1,
    digest: "sha256:d0b9747489491459e3f7c2cabe2c31d032d8be93ccec1519803d8a512de7b4a5",
    build_id: "conversation-v1-physical-1",
    source_contract: "dsh-v0.1.2-alpha.4/observeSession",
    source_state_version: "qq-session-conversation-projection-v1",
    partition_key: "sessionId",
    row_schema: "qq-session-conversation-row-v1",
    authorization_contract: "workspace-token-set/v1",
    maximum_partition_rows: 1_024,
    maximum_partition_bytes: 900 * 1_024,
    physical_schema: "qq-session-conversation-sqlite-v1",
    test_only: false,
    accesses: ACCESSES,
};

pub(super) struct ConversationView;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationRow {
    row_key: String,
    session_id: String,
    seq: u64,
    event_time_unix_ms: i64,
    event_type: String,
    surface: String,
    workspace_scope_token: String,
    body: String,
    fingerprint: String,
    session_title: String,
    session_updated_at_unix_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchParams {
    literals: Vec<String>,
    limit: usize,
    #[serde(default)]
    after_unix_ms: Option<i64>,
    #[serde(default)]
    before_unix_ms: Option<i64>,
    #[serde(default)]
    event_types: Vec<String>,
    #[serde(default)]
    surfaces: Vec<String>,
}

#[derive(Clone)]
struct Hit {
    session_id: String,
    seq: u64,
    event_time_unix_ms: i64,
    event_type: String,
    surface: String,
    title: String,
    session_updated_at_unix_ms: i64,
    score: f64,
    source_rank: usize,
    query_ordinal: usize,
    row_key: String,
}

struct Fused {
    score: f64,
    matches: BTreeSet<usize>,
    evidence: Hit,
}

impl CompiledView for ConversationView {
    fn manifest(&self) -> &'static ViewManifestV1 {
        &MANIFEST
    }

    fn create_schema(&self, transaction: &Transaction<'_>) -> Result<(), ViewError> {
        transaction.execute_batch(
            "CREATE TABLE conversation_rows (
                row_key TEXT PRIMARY KEY,
                partition_key TEXT NOT NULL REFERENCES view_partitions(partition_key) ON DELETE CASCADE,
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL CHECK (seq >= 0),
                event_time_unix_ms INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                surface TEXT NOT NULL,
                workspace_scope_token TEXT NOT NULL,
                body TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                session_title TEXT NOT NULL,
                session_updated_at_unix_ms INTEGER NOT NULL,
                UNIQUE(session_id, seq)
             ) STRICT;
             CREATE INDEX conversation_coordinate ON conversation_rows(session_id, seq);
             CREATE INDEX conversation_time_type_surface ON conversation_rows(event_time_unix_ms, event_type, surface, session_id, seq);
             CREATE INDEX conversation_scope_time ON conversation_rows(workspace_scope_token, event_time_unix_ms, session_id, seq);
             CREATE VIRTUAL TABLE conversation_fts USING fts5(
                body,
                workspace_scope_token,
                content='conversation_rows',
                content_rowid='rowid',
                tokenize='unicode61'
             );
             CREATE TRIGGER conversation_rows_ai AFTER INSERT ON conversation_rows BEGIN
                INSERT INTO conversation_fts(rowid, body, workspace_scope_token)
                VALUES (new.rowid, new.body, new.workspace_scope_token);
             END;
             CREATE TRIGGER conversation_rows_ad AFTER DELETE ON conversation_rows BEGIN
                INSERT INTO conversation_fts(conversation_fts, rowid, body, workspace_scope_token)
                VALUES ('delete', old.rowid, old.body, old.workspace_scope_token);
             END;
             CREATE TRIGGER conversation_rows_au AFTER UPDATE ON conversation_rows BEGIN
                INSERT INTO conversation_fts(conversation_fts, rowid, body, workspace_scope_token)
                VALUES ('delete', old.rowid, old.body, old.workspace_scope_token);
                INSERT INTO conversation_fts(rowid, body, workspace_scope_token)
                VALUES (new.rowid, new.body, new.workspace_scope_token);
             END;",
        )?;
        Ok(())
    }

    fn validate_schema(&self, connection: &Connection) -> Result<(), ViewError> {
        require_objects(
            connection,
            &[
                "conversation_rows",
                "conversation_coordinate",
                "conversation_time_type_surface",
                "conversation_scope_time",
                "conversation_fts",
                "conversation_rows_ai",
                "conversation_rows_ad",
                "conversation_rows_au",
            ],
        )
    }

    fn replace_partition(
        &self,
        transaction: &Transaction<'_>,
        partition_key: &str,
        rows: &[Value],
    ) -> Result<usize, ViewError> {
        // The checkpoint is inserted by the generic transaction after handler work,
        // so install a private provisional parent before rows reference it.
        ensure_provisional_partition(transaction, partition_key)?;
        transaction.execute(
            "DELETE FROM conversation_rows WHERE partition_key = ?1",
            [partition_key],
        )?;
        for row in rows {
            insert_row(transaction, partition_key, row)?;
        }
        Ok(rows.len())
    }

    fn apply_delta(
        &self,
        transaction: &Transaction<'_>,
        partition_key: &str,
        upserts: &[Value],
        deletes: &[String],
    ) -> Result<usize, ViewError> {
        for row_key in deletes {
            transaction.execute(
                "DELETE FROM conversation_rows WHERE row_key = ?1 AND partition_key = ?2",
                params![row_key, partition_key],
            )?;
        }
        for row in upserts {
            insert_row(transaction, partition_key, row)?;
        }
        Ok(upserts.len() + deletes.len())
    }

    fn delete_partition(
        &self,
        transaction: &Transaction<'_>,
        partition_key: &str,
    ) -> Result<usize, ViewError> {
        Ok(transaction.execute(
            "DELETE FROM conversation_rows WHERE partition_key = ?1",
            [partition_key],
        )?)
    }

    fn execute(
        &self,
        connection: &Connection,
        access: &str,
        params: &Value,
        authority: &ViewAuthorityV1,
    ) -> Result<HandlerQueryResult, ViewError> {
        if access != "literal-session-search" {
            return Err(ViewError::UnsupportedAccess {
                id: MANIFEST.id.to_owned(),
                version: MANIFEST.version,
                access: access.to_owned(),
            });
        }
        let params: SearchParams = serde_json::from_value(params.clone())
            .map_err(|error| invalid_query(error.to_string()))?;
        validate_search(&params)?;

        let transaction = connection.unchecked_transaction()?;
        let mut all_sources = Vec::with_capacity(params.literals.len());
        let mut postings_scanned = 0u64;
        for (ordinal, literal) in params.literals.iter().enumerate() {
            let (source, scanned) =
                search_literal(&transaction, literal, ordinal, &params, authority)?;
            postings_scanned = postings_scanned.saturating_add(scanned as u64);
            all_sources.push(source);
        }
        let mut fused: BTreeMap<String, Fused> = BTreeMap::new();
        for source in &all_sources {
            for hit in source {
                let contribution = 1.0 / (RRF_K + hit.source_rank as f64);
                let value = fused
                    .entry(hit.session_id.clone())
                    .or_insert_with(|| Fused {
                        score: 0.0,
                        matches: BTreeSet::new(),
                        evidence: hit.clone(),
                    });
                value.score += contribution;
                value.matches.insert(hit.query_ordinal);
                if evidence_order(hit, &value.evidence) == Ordering::Less {
                    value.evidence = hit.clone();
                }
            }
        }
        let mut fused: Vec<_> = fused.into_iter().collect();
        fused.sort_by(|left, right| {
            right
                .1
                .score
                .total_cmp(&left.1.score)
                .then_with(|| left.0.cmp(&right.0))
        });
        let truncated = fused.len() > params.limit;
        fused.truncate(params.limit);
        let sessions: Vec<Value> = fused
            .into_iter()
            .enumerate()
            .map(|(index, (session_id, fused))| {
                json!({
                    "rank": index + 1,
                    "sessionId": session_id,
                    "score": fused.score,
                    "matchingLiteralOrdinals": fused.matches.into_iter().collect::<Vec<_>>(),
                    "title": fused.evidence.title,
                    "sessionUpdatedAtUnixMs": fused.evidence.session_updated_at_unix_ms,
                    "evidence": {
                        "rowKey": fused.evidence.row_key,
                        "seq": fused.evidence.seq.to_string(),
                        "eventTimeUnixMs": fused.evidence.event_time_unix_ms,
                        "eventType": fused.evidence.event_type,
                        "surface": fused.evidence.surface,
                    }
                })
            })
            .collect();
        transaction.commit()?;
        let mut counts = BTreeMap::new();
        counts.insert("literals".to_owned(), params.literals.len() as u64);
        counts.insert("postingsScanned".to_owned(), postings_scanned);
        counts.insert("results".to_owned(), sessions.len() as u64);
        Ok(HandlerQueryResult {
            value: json!({ "sessions": sessions, "truncated": truncated }),
            counts,
        })
    }
}

fn ensure_provisional_partition(
    transaction: &Transaction<'_>,
    partition_key: &str,
) -> Result<(), ViewError> {
    transaction.execute(
        "INSERT INTO view_partitions(partition_key, source_identity, durable_revision, next_cursor, generation)
         VALUES (?1, 'provisional', 'provisional', 0, 0)
         ON CONFLICT(partition_key) DO NOTHING",
        [partition_key],
    )?;
    Ok(())
}

fn insert_row(
    transaction: &Transaction<'_>,
    partition_key: &str,
    value: &Value,
) -> Result<(), ViewError> {
    let row: ConversationRow = parse_row(value)?;
    validate_row(&row, partition_key)?;
    let changed = transaction
        .execute(
            "INSERT INTO conversation_rows(
            row_key, partition_key, session_id, seq, event_time_unix_ms, event_type, surface,
            workspace_scope_token, body, fingerprint, session_title, session_updated_at_unix_ms
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(row_key) DO UPDATE SET
            partition_key=excluded.partition_key, session_id=excluded.session_id, seq=excluded.seq,
            event_time_unix_ms=excluded.event_time_unix_ms, event_type=excluded.event_type,
            surface=excluded.surface, workspace_scope_token=excluded.workspace_scope_token,
            body=excluded.body, fingerprint=excluded.fingerprint,
            session_title=excluded.session_title,
            session_updated_at_unix_ms=excluded.session_updated_at_unix_ms
         WHERE conversation_rows.partition_key = excluded.partition_key",
            params![
                row.row_key,
                partition_key,
                row.session_id,
                to_sql_u64(row.seq, "seq")?,
                row.event_time_unix_ms,
                row.event_type,
                row.surface,
                row.workspace_scope_token,
                row.body,
                row.fingerprint,
                row.session_title,
                row.session_updated_at_unix_ms
            ],
        )
        .map_err(|error| match error {
            rusqlite::Error::SqliteFailure(_, _) => invalid_mutation(
                "conversation coordinate or row key conflicts with another partition",
            ),
            other => ViewError::Sqlite(other),
        })?;
    if changed != 1 {
        return Err(invalid_mutation(
            "conversation coordinate or row key conflicts with another partition",
        ));
    }
    Ok(())
}

fn validate_row(row: &ConversationRow, partition_key: &str) -> Result<(), ViewError> {
    if row.session_id != partition_key {
        return Err(invalid_mutation(
            "conversation row sessionId must equal partitionKey",
        ));
    }
    checked_text(&row.row_key, "rowKey", 256)?;
    checked_text(&row.session_id, "sessionId", 128)?;
    checked_text(&row.event_type, "eventType", 96)?;
    checked_text(&row.surface, "surface", 64)?;
    checked_scope_token(&row.workspace_scope_token)?;
    checked_optional_text(&row.body, "body", MAX_BODY_BYTES)?;
    checked_text(&row.fingerprint, "fingerprint", 256)?;
    checked_optional_text(&row.session_title, "sessionTitle", MAX_TITLE_BYTES)
}

fn validate_search(params: &SearchParams) -> Result<(), ViewError> {
    if params.literals.is_empty() || params.literals.len() > 5 {
        return Err(invalid_query("literals length must be 1..=5"));
    }
    for literal in &params.literals {
        if literal.trim().is_empty() || literal.len() > MAX_LITERAL_BYTES || literal.contains('\0')
        {
            return Err(invalid_query(
                "literal must contain 1..=512 bytes and no NUL",
            ));
        }
    }
    if params.limit == 0 || params.limit > MAX_LIMIT {
        return Err(invalid_query("limit must be 1..=100"));
    }
    if params
        .after_unix_ms
        .zip(params.before_unix_ms)
        .is_some_and(|(after, before)| after > before)
    {
        return Err(invalid_query("afterUnixMs must not exceed beforeUnixMs"));
    }
    validate_filters(&params.event_types, "eventTypes")?;
    validate_filters(&params.surfaces, "surfaces")
}

fn validate_filters(values: &[String], name: &str) -> Result<(), ViewError> {
    if values.len() > MAX_FILTERS {
        return Err(invalid_query(format!("{name} exceeds filter bound")));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        if value.is_empty() || value.len() > 96 || value.contains('\0') || !unique.insert(value) {
            return Err(invalid_query(format!(
                "{name} contains invalid or duplicate values"
            )));
        }
    }
    Ok(())
}

fn search_literal(
    transaction: &Transaction<'_>,
    literal: &str,
    ordinal: usize,
    params: &SearchParams,
    authority: &ViewAuthorityV1,
) -> Result<(Vec<Hit>, usize), ViewError> {
    let scope = authority
        .scope_tokens
        .iter()
        .map(|token| quote_fts(token))
        .collect::<Vec<_>>()
        .join(" OR ");
    let expression = format!(
        "body : {} AND workspace_scope_token : ({scope})",
        quote_fts(literal)
    );
    let mut sql = String::from(
        "SELECT r.row_key, r.session_id, r.seq, r.event_time_unix_ms, r.event_type, r.surface,
                r.session_title, r.session_updated_at_unix_ms, bm25(conversation_fts, 1.0, 0.0)
         FROM conversation_fts JOIN conversation_rows r ON r.rowid = conversation_fts.rowid
         WHERE conversation_fts MATCH ?",
    );
    let mut bindings = vec![SqlValue::Text(expression)];
    if let Some(after) = params.after_unix_ms {
        sql.push_str(" AND r.event_time_unix_ms >= ?");
        bindings.push(SqlValue::Integer(after));
    }
    if let Some(before) = params.before_unix_ms {
        sql.push_str(" AND r.event_time_unix_ms <= ?");
        bindings.push(SqlValue::Integer(before));
    }
    append_list(&mut sql, &mut bindings, "r.event_type", &params.event_types);
    append_list(&mut sql, &mut bindings, "r.surface", &params.surfaces);
    sql.push_str(
        " ORDER BY bm25(conversation_fts, 1.0, 0.0), r.session_id COLLATE BINARY, r.seq LIMIT 256",
    );
    let mut statement = transaction.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(bindings.iter()))?;
    let mut seen = BTreeSet::new();
    let mut hits = Vec::new();
    let mut scanned = 0usize;
    while let Some(row) = rows.next()? {
        scanned += 1;
        let session_id: String = row.get(1)?;
        if !seen.insert(session_id.clone()) {
            continue;
        }
        hits.push(Hit {
            row_key: row.get(0)?,
            session_id,
            seq: from_sql_u64(row.get(2)?, "seq")?,
            event_time_unix_ms: row.get(3)?,
            event_type: row.get(4)?,
            surface: row.get(5)?,
            title: row.get(6)?,
            session_updated_at_unix_ms: row.get(7)?,
            score: row.get(8)?,
            source_rank: hits.len() + 1,
            query_ordinal: ordinal,
        });
        if hits.len() == MAX_LIMIT {
            break;
        }
    }
    let _ = hits.iter().map(|hit| hit.score).sum::<f64>(); // score is retained for deterministic evidence diagnostics.
    Ok((hits, scanned))
}

fn append_list(sql: &mut String, bindings: &mut Vec<SqlValue>, column: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }
    sql.push_str(" AND ");
    sql.push_str(column);
    sql.push_str(" IN (");
    for (index, value) in values.iter().enumerate() {
        if index != 0 {
            sql.push(',');
        }
        sql.push('?');
        bindings.push(SqlValue::Text(value.clone()));
    }
    sql.push(')');
}

fn evidence_order(left: &Hit, right: &Hit) -> Ordering {
    left.source_rank
        .cmp(&right.source_rank)
        .then_with(|| left.query_ordinal.cmp(&right.query_ordinal))
        .then_with(|| left.seq.cmp(&right.seq))
}

fn require_objects(connection: &Connection, expected: &[&str]) -> Result<(), ViewError> {
    for name in expected {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = ?1)",
            [name],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(ViewError::InvalidStorage(format!(
                "conversation schema missing {name}"
            )));
        }
    }
    Ok(())
}
