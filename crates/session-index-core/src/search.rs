use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use rusqlite::types::Value;
use rusqlite::{Connection, TransactionBehavior, params_from_iter};

use crate::{
    IndexError, MAX_SCOPE_TOKEN_BYTES, MAX_SCOPE_TOKENS, MAX_SESSION_ID_BYTES, MAX_SURFACE_BYTES,
    MAX_WORKSPACE_BYTES, canonical_scope_terms, i64_to_u64, quoted_fts_phrase, read_metadata_tx,
    u64_to_i64, validate_scope_token, validate_text,
};

/// Semantic version of [`SearchBatchV1`]. Transport wrappers must reject other versions.
pub const SEARCH_BATCH_VERSION_V1: &str = "search-batch-v1";
/// Semantic version of [`SearchBatchResponseV1`].
pub const SEARCH_BATCH_RESPONSE_VERSION_V1: &str = "search-batch-response-v1";
/// Protocol-fixed reciprocal-rank-fusion constant.
pub const RRF_K_V1: u32 = 60;
/// Fixed per-literal row budget. A caller cannot increase this bound.
pub const RAW_POSTING_SCAN_BUDGET_V1: usize = 256;
/// Maximum caller-selected distinct-session depth for one literal.
pub const MAX_PER_SOURCE_DEPTH_V1: usize = 100;
/// Maximum number of fused sessions returned by one call.
pub const MAX_FINAL_LIMIT_V1: usize = 100;

const MAX_LITERALS_V1: usize = 5;
const MAX_LITERAL_BYTES_V1: usize = 500;
const MAX_WORKSPACE_FILTERS_V1: usize = 32;
const MAX_SURFACE_FILTERS_V1: usize = 32;
const MAX_SESSION_FILTERS_V1: usize = 128;
const MAX_SESSION_SEQ_BOUNDS_V1: usize = 128;

/// One synchronous, single-snapshot storage query.
///
/// Request IDs, deadlines, admission, and cancellation belong to the later service
/// wrapper. This type contains only fields evaluated by the Phase 1A storage core.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchBatchV1 {
    /// Already-normalized literal phrases. The cardinality is strictly 1 through 5.
    pub literals: Vec<String>,
    /// Maximum distinct sessions retained for each literal.
    pub per_source_depth: usize,
    /// Maximum fused sessions returned.
    pub final_limit: usize,
    /// Authorized primitive filters. Scope terms are opaque to this crate.
    pub filters: SearchFiltersV1,
    /// Fail closed if the transaction snapshot has not reached this watermark.
    pub minimum_source_watermark: Option<u64>,
}

/// Primitive, policy-neutral filters applied within every literal query.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchFiltersV1 {
    /// Nonempty opaque terms intersected inside FTS `MATCH`.
    pub authorized_scope_terms: Vec<String>,
    /// Optional defense-in-depth workspace allow list; empty means unrestricted.
    pub workspace_ids: Vec<String>,
    /// Optional defense-in-depth surface allow list; empty means unrestricted.
    pub surface_allow_list: Vec<String>,
    /// Optional session allow list; empty means unrestricted.
    pub include_session_ids: Vec<String>,
    /// Session deny list, applied in addition to any allow list.
    pub exclude_session_ids: Vec<String>,
    pub not_before_event_time_unix_ms: Option<i64>,
    pub not_after_event_time_unix_ms: Option<i64>,
    /// Bounds apply to their named session; sessions not named here are unaffected.
    pub session_seq_bounds: Vec<SessionSeqBoundV1>,
}

/// Optional inclusive sequence bounds for one session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionSeqBoundV1 {
    pub session_id: String,
    pub not_before_seq: Option<u64>,
    pub not_after_seq: Option<u64>,
}

/// Metadata for the one WAL snapshot used by a response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchSnapshotV1 {
    pub generation: u64,
    pub source_watermark: u64,
    /// Phase 1A has no source clock from which to derive lag.
    pub source_lag_ms: Option<u64>,
}

/// Complete synchronous V1 result.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchBatchResponseV1 {
    pub snapshot: SearchSnapshotV1,
    pub sources: Vec<SearchSourceV1>,
    pub fused: Vec<FusedSessionV1>,
    pub fused_truncated: bool,
}

/// Why scanning one literal stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceTruncationReasonV1 {
    /// The SQLite row stream ended before either fixed bound was reached.
    Exhausted,
    /// The caller's bounded distinct-session depth was reached.
    SourceDepth,
    /// The fixed, caller-unraiseable raw row budget was consumed.
    PostingBudget,
}

/// Ranked per-literal output. Literal text is deliberately not reflected here.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchSourceV1 {
    pub query_ordinal: usize,
    pub truncated: bool,
    pub truncation_reason: SourceTruncationReasonV1,
    pub raw_postings_scanned: usize,
    pub ranked: Vec<RankedSessionV1>,
}

/// The best authorized event row for one session in one literal source.
#[derive(Clone, Debug, PartialEq)]
pub struct RankedSessionV1 {
    /// One-based rank after deterministic source tie-breaking.
    pub rank: usize,
    pub session_id: String,
    /// Negated SQLite FTS5 `bm25`; meaningful only inside this source.
    pub score: f64,
    pub evidence: VerificationPointerV1,
}

/// Stable coordinates needed for a later exact visible-text verification.
///
/// Body text is never returned. Phase 1A also emits no snippets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerificationPointerV1 {
    pub document_key: String,
    pub seq: u64,
    pub event_time_unix_ms: i64,
    pub event_type: String,
    pub surface: String,
    pub snippet: Option<String>,
}

/// One deterministic reciprocal-rank-fused session.
#[derive(Clone, Debug, PartialEq)]
pub struct FusedSessionV1 {
    pub rank: usize,
    pub session_id: String,
    pub rrf_score: f64,
    pub contributions: Vec<RrfContributionV1>,
}

/// One source's contribution and exact-verification coordinate.
#[derive(Clone, Debug, PartialEq)]
pub struct RrfContributionV1 {
    pub query_ordinal: usize,
    pub source_rank: usize,
    pub contribution: f64,
    pub document_key: String,
    pub seq: u64,
    pub snippet: Option<String>,
}

#[derive(Debug)]
struct FusedAccumulator {
    session_id: String,
    score: f64,
    contributions: Vec<RrfContributionV1>,
}

pub(crate) fn search_batch_v1_on_connection(
    connection: &mut Connection,
    request: &SearchBatchV1,
) -> Result<SearchBatchResponseV1, IndexError> {
    validate_search(request)?;

    // Deferred is intentional: the metadata read below establishes the WAL snapshot,
    // and every literal is then evaluated through this same transaction/connection.
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let metadata = read_metadata_tx(&transaction)?;
    if let Some(minimum) = request.minimum_source_watermark
        && metadata.source_watermark < minimum
    {
        return Err(IndexError::SourceWatermarkUnavailable {
            minimum,
            available: metadata.source_watermark,
            generation: metadata.generation,
        });
    }

    let scope_expression = fts_scope_expression(&request.filters.authorized_scope_terms)?;
    let mut sources = Vec::with_capacity(request.literals.len());
    for (query_ordinal, literal) in request.literals.iter().enumerate() {
        sources.push(search_one_literal(
            &transaction,
            query_ordinal,
            literal,
            &scope_expression,
            request.per_source_depth,
            &request.filters,
        )?);
    }

    let (fused, fused_truncated) = fuse_sources(&sources, request.final_limit);
    transaction.commit()?;
    Ok(SearchBatchResponseV1 {
        snapshot: SearchSnapshotV1 {
            generation: metadata.generation,
            source_watermark: metadata.source_watermark,
            source_lag_ms: None,
        },
        sources,
        fused,
        fused_truncated,
    })
}

fn search_one_literal(
    transaction: &rusqlite::Transaction<'_>,
    query_ordinal: usize,
    literal: &str,
    scope_expression: &str,
    per_source_depth: usize,
    filters: &SearchFiltersV1,
) -> Result<SearchSourceV1, IndexError> {
    let match_expression = format!(
        "body : {} AND scope_terms : ({scope_expression})",
        quoted_fts_phrase(literal)
    );
    let mut sql = String::from(
        "SELECT d.session_id, d.seq, d.event_time_unix_ms, d.event_type, \
         d.surface, d.fingerprint, bm25(documents_fts, 1.0, 0.0) \
         FROM documents_fts JOIN documents AS d ON d.doc_id = documents_fts.rowid \
         WHERE documents_fts MATCH ?",
    );
    let mut bindings = vec![Value::Text(match_expression)];

    append_text_list_filter(
        &mut sql,
        &mut bindings,
        "d.workspace_id",
        &filters.workspace_ids,
        false,
    );
    append_text_list_filter(
        &mut sql,
        &mut bindings,
        "d.surface",
        &filters.surface_allow_list,
        false,
    );
    append_text_list_filter(
        &mut sql,
        &mut bindings,
        "d.session_id",
        &filters.include_session_ids,
        false,
    );
    append_text_list_filter(
        &mut sql,
        &mut bindings,
        "d.session_id",
        &filters.exclude_session_ids,
        true,
    );
    if let Some(not_before) = filters.not_before_event_time_unix_ms {
        sql.push_str(" AND d.event_time_unix_ms >= ?");
        bindings.push(Value::Integer(not_before));
    }
    if let Some(not_after) = filters.not_after_event_time_unix_ms {
        sql.push_str(" AND d.event_time_unix_ms <= ?");
        bindings.push(Value::Integer(not_after));
    }
    for bound in &filters.session_seq_bounds {
        if let Some(not_before) = bound.not_before_seq {
            sql.push_str(" AND NOT (d.session_id = ? AND d.seq < ?)");
            bindings.push(Value::Text(bound.session_id.clone()));
            bindings.push(Value::Integer(u64_to_i64(not_before, "not-before seq")?));
        }
        if let Some(not_after) = bound.not_after_seq {
            sql.push_str(" AND NOT (d.session_id = ? AND d.seq > ?)");
            bindings.push(Value::Text(bound.session_id.clone()));
            bindings.push(Value::Integer(u64_to_i64(not_after, "not-after seq")?));
        }
    }

    // SQLite can retain a bounded top-N working set for this LIMIT. Rust consumes the
    // rows one at a time and never groups or materializes all textual matches.
    write!(
        sql,
        " ORDER BY bm25(documents_fts, 1.0, 0.0) ASC, \
         d.session_id COLLATE BINARY ASC, d.seq ASC \
         LIMIT {RAW_POSTING_SCAN_BUDGET_V1}"
    )
    .expect("writing SQL into a String cannot fail");

    let mut statement = transaction.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(bindings.iter()))?;
    let mut seen_sessions = BTreeSet::new();
    let mut ranked = Vec::with_capacity(per_source_depth);
    let mut raw_postings_scanned = 0usize;
    let truncation_reason = loop {
        let Some(row) = rows.next()? else {
            break SourceTruncationReasonV1::Exhausted;
        };
        raw_postings_scanned += 1;
        let session_id: String = row.get(0)?;
        if seen_sessions.insert(session_id.clone()) {
            let seq = i64_to_u64(row.get(1)?, "search result seq")?;
            let fingerprint: String = row.get(5)?;
            let engine_score: f64 = row.get(6)?;
            ranked.push(RankedSessionV1 {
                rank: ranked.len() + 1,
                session_id: session_id.clone(),
                score: -engine_score,
                evidence: VerificationPointerV1 {
                    document_key: stable_document_key(&session_id, seq, &fingerprint),
                    seq,
                    event_time_unix_ms: row.get(2)?,
                    event_type: row.get(3)?,
                    surface: row.get(4)?,
                    snippet: None,
                },
            });
            if ranked.len() == per_source_depth {
                break SourceTruncationReasonV1::SourceDepth;
            }
        }
        if raw_postings_scanned == RAW_POSTING_SCAN_BUDGET_V1 {
            break SourceTruncationReasonV1::PostingBudget;
        }
    };

    Ok(SearchSourceV1 {
        query_ordinal,
        truncated: truncation_reason != SourceTruncationReasonV1::Exhausted,
        truncation_reason,
        raw_postings_scanned,
        ranked,
    })
}

fn append_text_list_filter(
    sql: &mut String,
    bindings: &mut Vec<Value>,
    column: &str,
    values: &[String],
    negated: bool,
) {
    if values.is_empty() {
        return;
    }
    if negated {
        sql.push_str(" AND ");
        sql.push_str(column);
        sql.push_str(" NOT IN (");
    } else {
        sql.push_str(" AND ");
        sql.push_str(column);
        sql.push_str(" IN (");
    }
    for (index, value) in values.iter().enumerate() {
        if index != 0 {
            sql.push(',');
        }
        sql.push('?');
        bindings.push(Value::Text(value.clone()));
    }
    sql.push(')');
}

fn fts_scope_expression(scope_terms: &[String]) -> Result<String, IndexError> {
    // Canonicalization validates cardinality and every opaque token.
    let canonical = canonical_scope_terms(scope_terms)?;
    Ok(canonical
        .split(' ')
        .map(quoted_fts_phrase)
        .collect::<Vec<_>>()
        .join(" OR "))
}

fn stable_document_key(session_id: &str, seq: u64, fingerprint: &str) -> String {
    // The byte length makes this unambiguous even when IDs contain separators.
    format!(
        "document-v1:{}:{session_id}:{seq}:{fingerprint}",
        session_id.len()
    )
}

fn fuse_sources(sources: &[SearchSourceV1], final_limit: usize) -> (Vec<FusedSessionV1>, bool) {
    let mut accumulators: BTreeMap<String, FusedAccumulator> = BTreeMap::new();
    for source in sources {
        for hit in &source.ranked {
            let contribution = 1.0 / (f64::from(RRF_K_V1) + hit.rank as f64);
            let accumulator = accumulators
                .entry(hit.session_id.clone())
                .or_insert_with(|| FusedAccumulator {
                    session_id: hit.session_id.clone(),
                    score: 0.0,
                    contributions: Vec::with_capacity(sources.len()),
                });
            accumulator.score += contribution;
            accumulator.contributions.push(RrfContributionV1 {
                query_ordinal: source.query_ordinal,
                source_rank: hit.rank,
                contribution,
                document_key: hit.evidence.document_key.clone(),
                seq: hit.evidence.seq,
                snippet: hit.evidence.snippet.clone(),
            });
        }
    }

    let fused_truncated = accumulators.len() > final_limit;
    let mut ordered: Vec<_> = accumulators.into_values().collect();
    ordered.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.session_id.as_bytes().cmp(right.session_id.as_bytes()))
    });
    ordered.truncate(final_limit);
    let fused = ordered
        .into_iter()
        .enumerate()
        .map(|(index, accumulator)| FusedSessionV1 {
            rank: index + 1,
            session_id: accumulator.session_id,
            rrf_score: accumulator.score,
            contributions: accumulator.contributions,
        })
        .collect();
    (fused, fused_truncated)
}

fn validate_search(request: &SearchBatchV1) -> Result<(), IndexError> {
    if request.literals.is_empty() || request.literals.len() > MAX_LITERALS_V1 {
        return invalid_search(format!("literal count must be 1..={MAX_LITERALS_V1}"));
    }
    for literal in &request.literals {
        validate_search_text("literal", literal, MAX_LITERAL_BYTES_V1)?;
        if literal.trim().is_empty() {
            return invalid_search("literal must contain non-whitespace text");
        }
    }
    if !(1..=MAX_PER_SOURCE_DEPTH_V1).contains(&request.per_source_depth) {
        return invalid_search(format!(
            "per-source depth must be 1..={MAX_PER_SOURCE_DEPTH_V1}"
        ));
    }
    if !(1..=MAX_FINAL_LIMIT_V1).contains(&request.final_limit) {
        return invalid_search(format!("final limit must be 1..={MAX_FINAL_LIMIT_V1}"));
    }

    validate_scope_filter(&request.filters.authorized_scope_terms)?;
    validate_text_filter(
        "workspace filter",
        &request.filters.workspace_ids,
        MAX_WORKSPACE_FILTERS_V1,
        MAX_WORKSPACE_BYTES,
    )?;
    validate_text_filter(
        "surface filter",
        &request.filters.surface_allow_list,
        MAX_SURFACE_FILTERS_V1,
        MAX_SURFACE_BYTES,
    )?;
    validate_text_filter(
        "included session",
        &request.filters.include_session_ids,
        MAX_SESSION_FILTERS_V1,
        MAX_SESSION_ID_BYTES,
    )?;
    validate_text_filter(
        "excluded session",
        &request.filters.exclude_session_ids,
        MAX_SESSION_FILTERS_V1,
        MAX_SESSION_ID_BYTES,
    )?;
    if let (Some(not_before), Some(not_after)) = (
        request.filters.not_before_event_time_unix_ms,
        request.filters.not_after_event_time_unix_ms,
    ) && not_before > not_after
    {
        return invalid_search("event-time lower bound exceeds upper bound");
    }
    validate_seq_bounds(&request.filters.session_seq_bounds)?;
    Ok(())
}

fn validate_scope_filter(scope_terms: &[String]) -> Result<(), IndexError> {
    if scope_terms.is_empty() || scope_terms.len() > MAX_SCOPE_TOKENS {
        return invalid_search(format!(
            "authorized scope term count must be 1..={MAX_SCOPE_TOKENS}"
        ));
    }
    let mut unique = BTreeSet::new();
    for term in scope_terms {
        if term.len() > MAX_SCOPE_TOKEN_BYTES || validate_scope_token(term).is_err() {
            return invalid_search(format!(
                "authorized scope terms must be 1..={MAX_SCOPE_TOKEN_BYTES} lowercase ASCII alphanumeric bytes"
            ));
        }
        if !unique.insert(term) {
            return invalid_search("authorized scope terms must not contain duplicates");
        }
    }
    Ok(())
}

fn validate_text_filter(
    name: &str,
    values: &[String],
    maximum_count: usize,
    maximum_bytes: usize,
) -> Result<(), IndexError> {
    if values.len() > maximum_count {
        return invalid_search(format!("{name} count must be 0..={maximum_count}"));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        validate_search_text(name, value, maximum_bytes)?;
        if !unique.insert(value) {
            return invalid_search(format!("{name} values must not contain duplicates"));
        }
    }
    Ok(())
}

fn validate_seq_bounds(bounds: &[SessionSeqBoundV1]) -> Result<(), IndexError> {
    if bounds.len() > MAX_SESSION_SEQ_BOUNDS_V1 {
        return invalid_search(format!(
            "session sequence-bound count must be 0..={MAX_SESSION_SEQ_BOUNDS_V1}"
        ));
    }
    let mut sessions = BTreeSet::new();
    for bound in bounds {
        validate_search_text(
            "sequence-bound session id",
            &bound.session_id,
            MAX_SESSION_ID_BYTES,
        )?;
        if !sessions.insert(&bound.session_id) {
            return invalid_search("session sequence bounds must name each session at most once");
        }
        if bound.not_before_seq.is_none() && bound.not_after_seq.is_none() {
            return invalid_search("a session sequence bound must specify at least one endpoint");
        }
        if let (Some(not_before), Some(not_after)) = (bound.not_before_seq, bound.not_after_seq)
            && not_before > not_after
        {
            return invalid_search("session sequence lower bound exceeds upper bound");
        }
        if bound
            .not_before_seq
            .is_some_and(|value| value > i64::MAX as u64)
            || bound
                .not_after_seq
                .is_some_and(|value| value > i64::MAX as u64)
        {
            return invalid_search("session sequence bound exceeds SQLite integer range");
        }
    }
    Ok(())
}

fn validate_search_text(name: &str, value: &str, maximum_bytes: usize) -> Result<(), IndexError> {
    validate_text(name, value, 1, maximum_bytes).map_err(|_| {
        IndexError::InvalidSearch(format!(
            "{name} must contain 1..={maximum_bytes} UTF-8 bytes and no NUL"
        ))
    })
}

fn invalid_search<T>(message: impl Into<String>) -> Result<T, IndexError> {
    Err(IndexError::InvalidSearch(message.into()))
}
