use qq_session_index_core::{
    CommitReceipt, FusedSessionV1, IndexError, IndexMetadata, MutationBatch, ProjectedDocument,
    RrfContributionV1, SCHEMA_FINGERPRINT, SCHEMA_VERSION, SEARCH_BATCH_RESPONSE_VERSION_V1,
    SEARCH_BATCH_VERSION_V1, SearchBatchResponseV1, SearchBatchV1, SearchFiltersV1, SearchSourceV1,
    SessionSeqBoundV1, SourceStateV1, SourceTruncationReasonV1, VerificationPointerV1,
};
use serde::Deserialize;
use serde_json::{Value, json};
use thiserror::Error;

pub const PROTOCOL_VERSION: &str = "qq-session-index-protocol-v1";
pub const MUTATION_BATCH_VERSION: &str = "mutation-batch-v1";
pub const COMMIT_RECEIPT_VERSION: &str = "commit-receipt-v1";
pub const HEALTH_RESPONSE_VERSION: &str = "health-response-v1";
pub const SHUTDOWN_RESPONSE_VERSION: &str = "shutdown-response-v1";
pub const SOURCE_STATE_VERSION_V1: &str = "source-state-v1";
pub const SOURCE_STATE_RESPONSE_VERSION_V1: &str = "source-state-response-v1";
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_WIRE_DOCUMENTS: usize = 1024;
const MAX_ERROR_MESSAGE_BYTES: usize = 4096;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RequestEnvelope {
    pub protocol_version: String,
    pub request_id: String,
    pub deadline_unix_ms: u64,
    pub operation: WireOperation,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum WireOperation {
    Health,
    SourceState {
        version: String,
        session_ids: Vec<String>,
    },
    ApplyBatch {
        version: String,
        batch: WireMutationBatch,
    },
    SearchBatch {
        version: String,
        literals: Vec<String>,
        per_source_depth: usize,
        final_limit: usize,
        filters: WireSearchFilters,
        #[serde(default)]
        minimum_source_watermark: Option<String>,
    },
    Shutdown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WireMutationBatch {
    idempotency_key: String,
    payload_fingerprint: String,
    source_watermark: String,
    documents: Vec<WireProjectedDocument>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireProjectedDocument {
    session_id: String,
    seq: String,
    event_time_unix_ms: i64,
    event_type: String,
    surface: String,
    workspace_id: String,
    scope_tokens: Vec<String>,
    body: String,
    fingerprint: String,
    source_revision: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WireSearchFilters {
    authorized_scope_tokens: Vec<String>,
    workspace_ids: Vec<String>,
    surface_allow_list: Vec<String>,
    event_type_allow_list: Vec<String>,
    #[serde(default)]
    include_session_ids: Vec<String>,
    #[serde(default)]
    exclude_session_ids: Vec<String>,
    #[serde(default)]
    not_before_event_time_unix_ms: Option<i64>,
    #[serde(default)]
    not_after_event_time_unix_ms: Option<i64>,
    #[serde(default)]
    session_seq_bounds: Vec<WireSessionSeqBound>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireSessionSeqBound {
    session_id: String,
    #[serde(default)]
    not_before_seq: Option<String>,
    #[serde(default)]
    not_after_seq: Option<String>,
}

#[derive(Debug, Error)]
pub(crate) enum ProtocolError {
    #[error("malformed request: {0}")]
    Malformed(String),
    #[error("unsupported protocol or operation version: {0}")]
    UnsupportedVersion(String),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("request deadline exceeded")]
    DeadlineExceeded,
    #[error("shutdown is restricted to a client running as the daemon owner")]
    Forbidden,
    #[error(transparent)]
    Core(#[from] IndexError),
}

impl ProtocolError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Malformed(_) => "protocol_error",
            Self::UnsupportedVersion(_) => "unsupported_version",
            Self::InvalidRequest(_) => "invalid_request",
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::Forbidden => "forbidden",
            Self::Core(error) => match error {
                IndexError::InvalidMutation(_) | IndexError::InvalidSearch(_) => "invalid_request",
                IndexError::SourceWatermarkUnavailable { .. } => "source_watermark_unavailable",
                IndexError::NonMonotonicWatermark { .. } => "watermark_conflict",
                IndexError::IdempotencyConflict { .. } => "idempotency_conflict",
                IndexError::SequenceGap { .. }
                | IndexError::DocumentConflict { .. }
                | IndexError::WorkspaceConflict { .. } => "mutation_conflict",
                _ => "storage_error",
            },
        }
    }

    pub(crate) fn retryable(&self) -> bool {
        matches!(
            self,
            Self::DeadlineExceeded
                | Self::Core(IndexError::SourceWatermarkUnavailable { .. })
                | Self::Core(IndexError::Sqlite(_))
        )
    }
}

pub(crate) fn parse_request(frame: &[u8]) -> Result<RequestEnvelope, ProtocolError> {
    let request: RequestEnvelope = serde_json::from_slice(frame)
        .map_err(|error| ProtocolError::Malformed(error.to_string()))?;
    validate_operation_keys(frame, &request.operation)?;
    validate_request_id(&request.request_id)?;
    if request.deadline_unix_ms == 0 {
        return Err(ProtocolError::InvalidRequest(
            "deadlineUnixMs must be a positive integer".to_owned(),
        ));
    }
    Ok(request)
}

fn validate_operation_keys(frame: &[u8], operation: &WireOperation) -> Result<(), ProtocolError> {
    let value: Value = serde_json::from_slice(frame)
        .map_err(|error| ProtocolError::Malformed(error.to_string()))?;
    let fields = value
        .get("operation")
        .and_then(Value::as_object)
        .ok_or_else(|| ProtocolError::Malformed("operation must be an object".to_owned()))?;
    let allowed: &[&str] = match operation {
        WireOperation::Health | WireOperation::Shutdown => &["type"],
        WireOperation::SourceState { .. } => &["type", "version", "sessionIds"],
        WireOperation::ApplyBatch { .. } => &["type", "version", "batch"],
        WireOperation::SearchBatch { .. } => &[
            "type",
            "version",
            "literals",
            "perSourceDepth",
            "finalLimit",
            "filters",
            "minimumSourceWatermark",
        ],
    };
    if let Some(unknown) = fields
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(ProtocolError::Malformed(format!(
            "unknown operation field {unknown:?}"
        )));
    }
    Ok(())
}

fn validate_request_id(request_id: &str) -> Result<(), ProtocolError> {
    if request_id.is_empty()
        || request_id.len() > MAX_REQUEST_ID_BYTES
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
    {
        return Err(ProtocolError::InvalidRequest(format!(
            "requestId must contain 1..={MAX_REQUEST_ID_BYTES} ASCII identifier bytes"
        )));
    }
    Ok(())
}

pub(crate) fn require_protocol_version(version: &str) -> Result<(), ProtocolError> {
    if version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion(format!(
            "expected {PROTOCOL_VERSION:?}, received {version:?}"
        )));
    }
    Ok(())
}

pub(crate) fn require_operation_version(actual: &str, expected: &str) -> Result<(), ProtocolError> {
    if actual != expected {
        return Err(ProtocolError::UnsupportedVersion(format!(
            "expected {expected:?}, received {actual:?}"
        )));
    }
    Ok(())
}

impl WireMutationBatch {
    pub(crate) fn into_core(self) -> Result<MutationBatch, ProtocolError> {
        if self.documents.is_empty() || self.documents.len() > MAX_WIRE_DOCUMENTS {
            return Err(ProtocolError::InvalidRequest(format!(
                "documents length must be 1..={MAX_WIRE_DOCUMENTS}"
            )));
        }
        let documents = self
            .documents
            .into_iter()
            .map(WireProjectedDocument::into_core)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(MutationBatch {
            idempotency_key: self.idempotency_key,
            payload_fingerprint: self.payload_fingerprint,
            source_watermark: parse_u64("sourceWatermark", &self.source_watermark)?,
            documents,
        })
    }
}

impl WireProjectedDocument {
    fn into_core(self) -> Result<ProjectedDocument, ProtocolError> {
        Ok(ProjectedDocument {
            session_id: self.session_id,
            seq: parse_u64("document seq", &self.seq)?,
            event_time_unix_ms: self.event_time_unix_ms,
            event_type: self.event_type,
            surface: self.surface,
            workspace_id: self.workspace_id,
            scope_tokens: self.scope_tokens,
            body: self.body,
            fingerprint: self.fingerprint,
            source_revision: self.source_revision,
        })
    }
}

pub(crate) fn into_core_search(
    literals: Vec<String>,
    per_source_depth: usize,
    final_limit: usize,
    filters: WireSearchFilters,
    minimum_source_watermark: Option<String>,
) -> Result<SearchBatchV1, ProtocolError> {
    let session_seq_bounds = filters
        .session_seq_bounds
        .into_iter()
        .map(|bound| {
            Ok(SessionSeqBoundV1 {
                session_id: bound.session_id,
                not_before_seq: bound
                    .not_before_seq
                    .map(|value| parse_u64("notBeforeSeq", &value))
                    .transpose()?,
                not_after_seq: bound
                    .not_after_seq
                    .map(|value| parse_u64("notAfterSeq", &value))
                    .transpose()?,
            })
        })
        .collect::<Result<Vec<_>, ProtocolError>>()?;
    Ok(SearchBatchV1 {
        literals,
        per_source_depth,
        final_limit,
        filters: SearchFiltersV1 {
            authorized_scope_terms: filters.authorized_scope_tokens,
            workspace_ids: filters.workspace_ids,
            surface_allow_list: filters.surface_allow_list,
            event_type_allow_list: filters.event_type_allow_list,
            include_session_ids: filters.include_session_ids,
            exclude_session_ids: filters.exclude_session_ids,
            not_before_event_time_unix_ms: filters.not_before_event_time_unix_ms,
            not_after_event_time_unix_ms: filters.not_after_event_time_unix_ms,
            session_seq_bounds,
        },
        minimum_source_watermark: minimum_source_watermark
            .map(|value| parse_u64("minimumSourceWatermark", &value))
            .transpose()?,
    })
}

fn parse_u64(name: &str, value: &str) -> Result<u64, ProtocolError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ProtocolError::InvalidRequest(format!(
            "{name} must be a canonical unsigned decimal string"
        )));
    }
    value.parse().map_err(|_| {
        ProtocolError::InvalidRequest(format!("{name} exceeds the unsigned 64-bit range"))
    })
}

pub(crate) fn success_envelope(request_id: &str, response: Value) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": true,
        "response": response,
    })
}

pub(crate) fn error_envelope(request_id: &str, error: &ProtocolError) -> Value {
    let mut message = error.to_string();
    if message.len() > MAX_ERROR_MESSAGE_BYTES {
        let mut boundary = MAX_ERROR_MESSAGE_BYTES;
        while !message.is_char_boundary(boundary) {
            boundary -= 1;
        }
        message.truncate(boundary);
    }
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": false,
        "error": {
            "code": error.code(),
            "message": message,
            "retryable": error.retryable(),
        },
    })
}

pub(crate) fn health_response(metadata: &IndexMetadata) -> Value {
    json!({
        "type": "health",
        "version": HEALTH_RESPONSE_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "schemaVersion": SCHEMA_VERSION,
        "schemaFingerprint": SCHEMA_FINGERPRINT,
        "projectionVersion": metadata.projection_version,
        "searchRequestVersion": SEARCH_BATCH_VERSION_V1,
        "searchResponseVersion": SEARCH_BATCH_RESPONSE_VERSION_V1,
        "generation": metadata.generation.to_string(),
        "sourceWatermark": metadata.source_watermark.to_string(),
        "capabilities": {
            "localUnixSocket": true,
            "serializedRequests": true,
            "activeSqliteInterrupt": false,
            "maxFrameBytes": MAX_FRAME_BYTES,
        },
    })
}

pub(crate) fn source_state_response(state: &SourceStateV1) -> Value {
    json!({
        "type": "sourceState",
        "version": SOURCE_STATE_RESPONSE_VERSION_V1,
        "generation": state.generation.to_string(),
        "sourceWatermark": state.source_watermark.to_string(),
        "sessions": state.sessions.iter().map(|session| json!({
            "sessionId": session.session_id,
            "nextSeq": session.next_seq.to_string(),
            "workspaceId": session.workspace_id,
            "headerRevision": session.header_revision,
        })).collect::<Vec<_>>(),
    })
}

pub(crate) fn receipt_response(receipt: &CommitReceipt) -> Value {
    json!({
        "type": "applyBatch",
        "version": COMMIT_RECEIPT_VERSION,
        "generation": receipt.generation.to_string(),
        "sourceWatermark": receipt.source_watermark.to_string(),
        "insertedDocuments": receipt.inserted_documents,
        "replayedDocuments": receipt.replayed_documents,
        "batchReplayed": receipt.batch_replayed,
    })
}

pub(crate) fn search_response(response: &SearchBatchResponseV1) -> Value {
    json!({
        "type": "searchBatch",
        "version": SEARCH_BATCH_RESPONSE_VERSION_V1,
        "snapshot": {
            "generation": response.snapshot.generation.to_string(),
            "sourceWatermark": response.snapshot.source_watermark.to_string(),
            "sourceLagMs": response.snapshot.source_lag_ms,
        },
        "sources": response.sources.iter().map(source_value).collect::<Vec<_>>(),
        "fused": response.fused.iter().map(fused_value).collect::<Vec<_>>(),
        "fusedTruncated": response.fused_truncated,
    })
}

fn source_value(source: &SearchSourceV1) -> Value {
    let reason = match source.truncation_reason {
        SourceTruncationReasonV1::Exhausted => "exhausted",
        SourceTruncationReasonV1::SourceDepth => "source-depth",
        SourceTruncationReasonV1::PostingBudget => "posting-budget",
    };
    json!({
        "queryOrdinal": source.query_ordinal,
        "truncated": source.truncated,
        "truncationReason": reason,
        "rawPostingsScanned": source.raw_postings_scanned,
        "ranked": source.ranked.iter().map(|ranked| json!({
            "rank": ranked.rank,
            "sessionId": ranked.session_id,
            "score": ranked.score,
            "evidence": verification_value(&ranked.evidence),
        })).collect::<Vec<_>>(),
    })
}

fn verification_value(pointer: &VerificationPointerV1) -> Value {
    json!({
        "sessionId": pointer.session_id,
        "documentKey": pointer.document_key,
        "seq": pointer.seq.to_string(),
        "eventTimeUnixMs": pointer.event_time_unix_ms,
        "eventType": pointer.event_type,
        "surface": pointer.surface,
        "snippet": pointer.snippet,
    })
}

fn fused_value(fused: &FusedSessionV1) -> Value {
    json!({
        "rank": fused.rank,
        "sessionId": fused.session_id,
        "rrfScore": fused.rrf_score,
        "contributions": fused.contributions.iter().map(contribution_value).collect::<Vec<_>>(),
    })
}

fn contribution_value(contribution: &RrfContributionV1) -> Value {
    json!({
        "queryOrdinal": contribution.query_ordinal,
        "sourceRank": contribution.source_rank,
        "contribution": contribution.contribution,
        "documentKey": contribution.document_key,
        "seq": contribution.seq.to_string(),
        "snippet": contribution.snippet,
    })
}

pub(crate) fn shutdown_response() -> Value {
    json!({
        "type": "shutdown",
        "version": SHUTDOWN_RESPONSE_VERSION,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(operation: &str) -> String {
        format!(
            r#"{{"protocolVersion":"{PROTOCOL_VERSION}","requestId":"test-1","deadlineUnixMs":9999999999999,"operation":{operation}}}"#
        )
    }

    #[test]
    fn malformed_invalid_operations_and_types_fail_closed() {
        assert!(matches!(
            parse_request(br#"{"#),
            Err(ProtocolError::Malformed(_))
        ));
        assert!(matches!(
            parse_request(envelope(r#"{"type":"notAnOperation"}"#).as_bytes()),
            Err(ProtocolError::Malformed(_))
        ));
        assert!(matches!(
            parse_request(envelope(r#"{"type":"health","extra":true}"#).as_bytes()),
            Err(ProtocolError::Malformed(_))
        ));
        assert!(matches!(
            parse_request(envelope(r#"{"type":"applyBatch","version":7,"batch":{}}"#).as_bytes()),
            Err(ProtocolError::Malformed(_))
        ));
    }

    #[test]
    fn long_unicode_error_messages_are_truncated_on_a_character_boundary() {
        let error = ProtocolError::UnsupportedVersion("é".repeat(MAX_ERROR_MESSAGE_BYTES));
        let envelope = error_envelope("test-1", &error);
        let message = envelope["error"]["message"]
            .as_str()
            .expect("error message string");
        assert!(message.len() <= MAX_ERROR_MESSAGE_BYTES);
        assert!(message.ends_with('é'));
    }

    #[test]
    fn conversion_rejects_noncanonical_and_overflowing_unsigned_values() {
        for value in ["", "01", "-1", "+1", "1.0", "18446744073709551616"] {
            assert!(parse_u64("test", value).is_err(), "accepted {value:?}");
        }
        assert_eq!(parse_u64("test", "0").expect("zero"), 0);
        assert_eq!(
            parse_u64("test", "18446744073709551615").expect("u64 max"),
            u64::MAX
        );
    }
}
