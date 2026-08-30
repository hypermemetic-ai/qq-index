import { createConnection } from "node:net";
import { isAbsolute } from "node:path";

export const SESSION_INDEX_PROTOCOL_VERSION = "qq-session-index-protocol-v1";
export const SESSION_INDEX_MUTATION_VERSION = "mutation-batch-v1";
export const SESSION_INDEX_SEARCH_VERSION = "search-batch-v1";
export const SESSION_INDEX_MAX_FRAME_BYTES = 1024 * 1024;

const HEALTH_RESPONSE_VERSION = "health-response-v1";
const COMMIT_RECEIPT_VERSION = "commit-receipt-v1";
const SEARCH_RESPONSE_VERSION = "search-batch-response-v1";
const SHUTDOWN_RESPONSE_VERSION = "shutdown-response-v1";
const SCHEMA_FINGERPRINT = "qq-session-index-schema-v1";
const PROJECTION_VERSION = "qq-session-projection-v1";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_REQUEST_ID_BYTES = 128;
const MAX_DOCUMENTS = 1_024;
const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;
const MAX_U64 = 18_446_744_073_709_551_615n;
const TERMINAL_ERROR_CODES = new Set([
  "protocol_error",
  "unsupported_version",
  "invalid_request",
  "deadline_exceeded",
  "forbidden",
  "source_watermark_unavailable",
  "watermark_conflict",
  "idempotency_conflict",
  "mutation_conflict",
  "storage_error",
]);

export class SessionIndexClientError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "SessionIndexClientError";
    this.code = options.code ?? "client_error";
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
  }
}

/** Connect to qq-session-indexd over a private absolute Unix-socket path. */
export async function connectSessionIndexClient(options) {
  exactObject(options, ["socketPath"], ["timeoutMs", "deadlineUnixMs", "signal"], "options");
  boundedString(options.socketPath, "socketPath", 1, 4_096);
  if (!isAbsolute(options.socketPath)) {
    invalid("socketPath must be absolute");
  }
  const defaultTimeoutMs = options.timeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS
    : timeout(options.timeoutMs, "timeoutMs");
  const boundary = makeBoundary(options, defaultTimeoutMs);
  ensureBoundary(boundary);

  const socket = createConnection({ path: options.socketPath });
  const connected = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  try {
    await raceBoundary(connected, boundary, (error) => socket.destroy(error));
  } catch (error) {
    socket.destroy();
    throw normalizeSocketError(error, "connecting to session-index daemon");
  }
  return new SessionIndexClient(socket, defaultTimeoutMs);
}

class SessionIndexClient {
  #socket;
  #defaultTimeoutMs;
  #buffer = Buffer.alloc(0);
  #pending = null;
  #tail = Promise.resolve();
  #counter = 0;
  #terminalError = null;
  #closed = false;

  constructor(socket, defaultTimeoutMs) {
    this.#socket = socket;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => this.#terminate(normalizeSocketError(error, "session-index socket")));
    socket.on("end", () => this.#terminate(new SessionIndexClientError(
      "session-index daemon closed the socket",
      { code: "socket_closed", retryable: true },
    )));
    socket.on("close", () => {
      if (!this.#closed && !this.#terminalError) {
        this.#terminate(new SessionIndexClientError(
          "session-index socket closed",
          { code: "socket_closed", retryable: true },
        ));
      }
    });
  }

  health(options = {}) {
    return this.#enqueue({ type: "health" }, validateHealthResponse, options);
  }

  applyBatch(batch, options = {}) {
    validateMutationBatch(batch);
    const wireBatch = structuredClone(batch);
    validateMutationBatch(wireBatch);
    return this.#enqueue(
      { type: "applyBatch", version: SESSION_INDEX_MUTATION_VERSION, batch: wireBatch },
      validateCommitReceipt,
      options,
    );
  }

  searchBatch(request, options = {}) {
    validateSearchRequest(request);
    const wireRequest = structuredClone(request);
    validateSearchRequest(wireRequest);
    const operation = { type: "searchBatch", ...wireRequest };
    return this.#enqueue(
      operation,
      (response) => validateSearchResponse(response, wireRequest),
      options,
    );
  }

  async shutdown(options = {}) {
    const response = await this.#enqueue(
      { type: "shutdown" },
      validateShutdownResponse,
      options,
    );
    await this.close();
    return response;
  }

  async close(options = {}) {
    exactObject(options, [], [], "close options");
    if (this.#closed) return;
    this.#closed = true;
    const closed = new Promise((resolve) => {
      if (this.#socket.destroyed) resolve();
      else this.#socket.once("close", resolve);
    });
    if (this.#pending) {
      this.#pending.reject(new SessionIndexClientError(
        "session-index client closed with a request pending",
        { code: "client_closed" },
      ));
      this.#pending = null;
    }
    this.#socket.end();
    const timer = setTimeout(() => this.#socket.destroy(), 1_000);
    timer.unref?.();
    await closed;
    clearTimeout(timer);
  }

  #enqueue(operation, validator, options) {
    exactObject(options, [], ["timeoutMs", "deadlineUnixMs", "signal"], "request options");
    const boundary = makeBoundary(options, this.#defaultTimeoutMs);
    const previous = this.#tail;
    const job = previous.then(() => {
      ensureBoundary(boundary);
      if (this.#closed) {
        throw new SessionIndexClientError("session-index client is closed", {
          code: "client_closed",
        });
      }
      if (this.#terminalError) throw this.#terminalError;
      return this.#roundTrip(operation, validator, boundary);
    });
    this.#tail = job.catch(() => {});
    // This outer race rejects promptly while a call is queued. The reserved job
    // remains in the serial tail and checks the same boundary before any write.
    return raceBoundary(job, boundary);
  }

  #roundTrip(operation, validator, boundary) {
    if (this.#pending) {
      throw new SessionIndexClientError("protocol invariant violated: concurrent request", {
        code: "protocol_violation",
      });
    }
    const requestId = `${process.pid}-${Date.now().toString(36)}-${++this.#counter}`;
    identifier(requestId, "requestId");
    const envelope = {
      protocolVersion: SESSION_INDEX_PROTOCOL_VERSION,
      requestId,
      deadlineUnixMs: boundary.deadlineUnixMs,
      operation,
    };
    const encoded = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
    if (encoded.length - 1 > SESSION_INDEX_MAX_FRAME_BYTES) {
      invalid(`request frame exceeds ${SESSION_INDEX_MAX_FRAME_BYTES} bytes`);
    }

    const response = new Promise((resolve, reject) => {
      this.#pending = { requestId, validator, resolve, reject };
      this.#socket.write(encoded, (error) => {
        if (error && this.#pending?.requestId === requestId) {
          this.#terminate(normalizeSocketError(error, "writing session-index request"));
        }
      });
    });
    return raceBoundary(response, boundary, (error) => {
      // Disconnecting ends the client's wait, but does not claim or imply that
      // an already-running SQLite operation was interrupted in the daemon.
      this.#terminate(error);
    });
  }

  #onData(chunk) {
    if (this.#terminalError || this.#closed) return;
    if (this.#buffer.length + chunk.length > SESSION_INDEX_MAX_FRAME_BYTES + 1
        && !chunk.includes(0x0a)) {
      this.#terminate(new SessionIndexClientError(
        `response frame exceeds ${SESSION_INDEX_MAX_FRAME_BYTES} bytes`,
        { code: "protocol_violation" },
      ));
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline === -1) {
        if (this.#buffer.length > SESSION_INDEX_MAX_FRAME_BYTES) {
          this.#terminate(new SessionIndexClientError(
            `response frame exceeds ${SESSION_INDEX_MAX_FRAME_BYTES} bytes`,
            { code: "protocol_violation" },
          ));
        }
        return;
      }
      if (newline > SESSION_INDEX_MAX_FRAME_BYTES) {
        this.#terminate(new SessionIndexClientError(
          `response frame exceeds ${SESSION_INDEX_MAX_FRAME_BYTES} bytes`,
          { code: "protocol_violation" },
        ));
        return;
      }
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#handleFrame(frame);
      if (this.#terminalError) return;
    }
  }

  #handleFrame(frame) {
    if (!this.#pending) {
      this.#terminate(new SessionIndexClientError(
        "daemon sent a response with no pending request",
        { code: "protocol_violation" },
      ));
      return;
    }
    const pending = this.#pending;
    let envelope;
    try {
      envelope = JSON.parse(frame.toString("utf8"));
      validateEnvelope(envelope, pending.requestId);
      this.#pending = null;
      if (!envelope.ok) {
        const terminal = daemonError(envelope.error, pending.requestId);
        pending.reject(terminal);
        return;
      }
      pending.validator(envelope.response);
      pending.resolve(envelope.response);
    } catch (cause) {
      const error = cause instanceof SessionIndexClientError
        ? cause
        : new SessionIndexClientError("invalid response from session-index daemon", {
          code: "protocol_violation",
          cause,
        });
      pending.reject(error);
      this.#terminate(error);
    }
  }

  #terminate(error) {
    if (this.#terminalError) return;
    this.#terminalError = error instanceof SessionIndexClientError
      ? error
      : normalizeSocketError(error, "session-index socket");
    if (this.#pending) {
      this.#pending.reject(this.#terminalError);
      this.#pending = null;
    }
    this.#socket.destroy();
  }
}

function validateEnvelope(envelope, requestId) {
  plainObject(envelope, "response envelope");
  if (envelope.ok === true) {
    exactObject(
      envelope,
      ["protocolVersion", "requestId", "ok", "response"],
      [],
      "response envelope",
    );
  } else if (envelope.ok === false) {
    exactObject(
      envelope,
      ["protocolVersion", "requestId", "ok", "error"],
      [],
      "response envelope",
    );
  } else {
    invalid("response envelope ok must be boolean", "protocol_violation");
  }
  if (envelope.protocolVersion !== SESSION_INDEX_PROTOCOL_VERSION) {
    invalid("response protocolVersion is unsupported", "protocol_violation");
  }
  identifier(envelope.requestId, "response requestId");
  if (envelope.requestId !== requestId) {
    invalid("response requestId does not match the pending request", "protocol_violation");
  }
}

function daemonError(error, requestId) {
  exactObject(error, ["code", "message", "retryable"], [], "daemon error");
  if (!TERMINAL_ERROR_CODES.has(error.code)) {
    invalid("daemon returned an unknown terminal error code", "protocol_violation");
  }
  boundedString(error.message, "daemon error message", 1, 4_096);
  boolean(error.retryable, "daemon error retryable");
  return new SessionIndexClientError(error.message, {
    code: error.code,
    retryable: error.retryable,
    requestId,
  });
}

function validateHealthResponse(response) {
  exactObject(response, [
    "type",
    "version",
    "protocolVersion",
    "schemaVersion",
    "schemaFingerprint",
    "projectionVersion",
    "searchRequestVersion",
    "searchResponseVersion",
    "generation",
    "sourceWatermark",
    "capabilities",
  ], [], "health response");
  equal(response.type, "health", "health response type");
  equal(response.version, HEALTH_RESPONSE_VERSION, "health response version");
  equal(response.protocolVersion, SESSION_INDEX_PROTOCOL_VERSION, "health protocol version");
  equal(response.schemaVersion, 1, "schema version");
  equal(response.schemaFingerprint, SCHEMA_FINGERPRINT, "schema fingerprint");
  equal(response.projectionVersion, PROJECTION_VERSION, "projection version");
  equal(response.searchRequestVersion, SESSION_INDEX_SEARCH_VERSION, "search request version");
  equal(response.searchResponseVersion, SEARCH_RESPONSE_VERSION, "search response version");
  unsignedString(response.generation, "generation", MAX_SQLITE_INTEGER);
  unsignedString(response.sourceWatermark, "sourceWatermark", MAX_SQLITE_INTEGER);
  exactObject(response.capabilities, [
    "localUnixSocket",
    "serializedRequests",
    "activeSqliteInterrupt",
    "maxFrameBytes",
  ], [], "health capabilities");
  equal(response.capabilities.localUnixSocket, true, "localUnixSocket capability");
  equal(response.capabilities.serializedRequests, true, "serializedRequests capability");
  equal(response.capabilities.activeSqliteInterrupt, false, "activeSqliteInterrupt capability");
  equal(response.capabilities.maxFrameBytes, SESSION_INDEX_MAX_FRAME_BYTES, "maxFrameBytes");
}

function validateMutationBatch(batch) {
  exactObject(batch, [
    "idempotencyKey",
    "payloadFingerprint",
    "sourceWatermark",
    "documents",
  ], [], "mutation batch");
  boundedString(batch.idempotencyKey, "idempotencyKey", 1, 256);
  boundedString(batch.payloadFingerprint, "payloadFingerprint", 1, 256);
  unsignedString(batch.sourceWatermark, "sourceWatermark", MAX_SQLITE_INTEGER, true);
  boundedArray(batch.documents, "documents", 1, MAX_DOCUMENTS);
  for (const [index, document] of batch.documents.entries()) {
    validateDocument(document, `documents[${index}]`);
  }
}

function validateDocument(document, name) {
  exactObject(document, [
    "sessionId",
    "seq",
    "eventTimeUnixMs",
    "eventType",
    "surface",
    "workspaceId",
    "scopeTokens",
    "body",
    "fingerprint",
    "sourceRevision",
  ], [], name);
  boundedString(document.sessionId, `${name}.sessionId`, 1, 128);
  unsignedString(document.seq, `${name}.seq`, MAX_SQLITE_INTEGER);
  safeInteger(document.eventTimeUnixMs, `${name}.eventTimeUnixMs`);
  boundedString(document.eventType, `${name}.eventType`, 1, 96);
  boundedString(document.surface, `${name}.surface`, 1, 64);
  boundedString(document.workspaceId, `${name}.workspaceId`, 1, 4_096);
  scopeTokens(document.scopeTokens, `${name}.scopeTokens`);
  boundedString(document.body, `${name}.body`, 1, 1_048_576);
  boundedString(document.fingerprint, `${name}.fingerprint`, 1, 256);
  boundedString(document.sourceRevision, `${name}.sourceRevision`, 1, 256);
}

function validateCommitReceipt(response) {
  exactObject(response, [
    "type",
    "version",
    "generation",
    "sourceWatermark",
    "insertedDocuments",
    "replayedDocuments",
    "batchReplayed",
  ], [], "applyBatch response");
  equal(response.type, "applyBatch", "applyBatch response type");
  equal(response.version, COMMIT_RECEIPT_VERSION, "applyBatch response version");
  unsignedString(response.generation, "generation", MAX_SQLITE_INTEGER);
  unsignedString(response.sourceWatermark, "sourceWatermark", MAX_SQLITE_INTEGER);
  boundedInteger(response.insertedDocuments, "insertedDocuments", 0, MAX_DOCUMENTS);
  boundedInteger(response.replayedDocuments, "replayedDocuments", 0, MAX_DOCUMENTS);
  boolean(response.batchReplayed, "batchReplayed");
}

function validateSearchRequest(request) {
  exactObject(request, [
    "version",
    "literals",
    "perSourceDepth",
    "finalLimit",
    "filters",
  ], ["minimumSourceWatermark"], "search request");
  equal(request.version, SESSION_INDEX_SEARCH_VERSION, "search request version");
  boundedArray(request.literals, "literals", 1, 5);
  for (const [index, literal] of request.literals.entries()) {
    boundedString(literal, `literals[${index}]`, 1, 500);
    if (literal.trim().length === 0) invalid(`literals[${index}] must contain non-whitespace text`);
  }
  boundedInteger(request.perSourceDepth, "perSourceDepth", 1, 100);
  boundedInteger(request.finalLimit, "finalLimit", 1, 100);
  validateFilters(request.filters);
  if (request.minimumSourceWatermark !== undefined) {
    unsignedString(
      request.minimumSourceWatermark,
      "minimumSourceWatermark",
      MAX_SQLITE_INTEGER,
    );
  }
}

function validateFilters(filters) {
  exactObject(filters, [
    "authorizedScopeTokens",
    "workspaceIds",
    "surfaceAllowList",
  ], [
    "includeSessionIds",
    "excludeSessionIds",
    "notBeforeEventTimeUnixMs",
    "notAfterEventTimeUnixMs",
    "sessionSeqBounds",
  ], "filters");
  scopeTokens(filters.authorizedScopeTokens, "filters.authorizedScopeTokens");
  stringList(filters.workspaceIds, "filters.workspaceIds", 32, 4_096);
  stringList(filters.surfaceAllowList, "filters.surfaceAllowList", 32, 64);
  if (filters.includeSessionIds !== undefined) {
    stringList(filters.includeSessionIds, "filters.includeSessionIds", 128, 128);
  }
  if (filters.excludeSessionIds !== undefined) {
    stringList(filters.excludeSessionIds, "filters.excludeSessionIds", 128, 128);
  }
  if (filters.notBeforeEventTimeUnixMs !== undefined) {
    safeInteger(filters.notBeforeEventTimeUnixMs, "filters.notBeforeEventTimeUnixMs");
  }
  if (filters.notAfterEventTimeUnixMs !== undefined) {
    safeInteger(filters.notAfterEventTimeUnixMs, "filters.notAfterEventTimeUnixMs");
  }
  if (filters.notBeforeEventTimeUnixMs !== undefined
      && filters.notAfterEventTimeUnixMs !== undefined
      && filters.notBeforeEventTimeUnixMs > filters.notAfterEventTimeUnixMs) {
    invalid("event-time lower bound exceeds upper bound");
  }
  if (filters.sessionSeqBounds !== undefined) {
    boundedArray(filters.sessionSeqBounds, "filters.sessionSeqBounds", 0, 128);
    const sessions = new Set();
    for (const [index, bound] of filters.sessionSeqBounds.entries()) {
      const name = `filters.sessionSeqBounds[${index}]`;
      exactObject(bound, ["sessionId"], ["notBeforeSeq", "notAfterSeq"], name);
      boundedString(bound.sessionId, `${name}.sessionId`, 1, 128);
      if (sessions.has(bound.sessionId)) invalid("sessionSeqBounds contains a duplicate sessionId");
      sessions.add(bound.sessionId);
      if (bound.notBeforeSeq === undefined && bound.notAfterSeq === undefined) {
        invalid(`${name} must specify at least one endpoint`);
      }
      if (bound.notBeforeSeq !== undefined) {
        unsignedString(bound.notBeforeSeq, `${name}.notBeforeSeq`, MAX_SQLITE_INTEGER);
      }
      if (bound.notAfterSeq !== undefined) {
        unsignedString(bound.notAfterSeq, `${name}.notAfterSeq`, MAX_SQLITE_INTEGER);
      }
      if (bound.notBeforeSeq !== undefined && bound.notAfterSeq !== undefined
          && BigInt(bound.notBeforeSeq) > BigInt(bound.notAfterSeq)) {
        invalid(`${name} lower bound exceeds upper bound`);
      }
    }
  }
}

function validateSearchResponse(response, request) {
  exactObject(response, [
    "type",
    "version",
    "snapshot",
    "sources",
    "fused",
    "fusedTruncated",
  ], [], "search response");
  equal(response.type, "searchBatch", "search response type");
  equal(response.version, SEARCH_RESPONSE_VERSION, "search response version");
  exactObject(response.snapshot, [
    "generation",
    "sourceWatermark",
    "sourceLagMs",
  ], [], "search snapshot");
  unsignedString(response.snapshot.generation, "snapshot.generation", MAX_SQLITE_INTEGER);
  unsignedString(
    response.snapshot.sourceWatermark,
    "snapshot.sourceWatermark",
    MAX_SQLITE_INTEGER,
  );
  if (response.snapshot.sourceLagMs !== null) {
    boundedInteger(response.snapshot.sourceLagMs, "snapshot.sourceLagMs", 0, Number.MAX_SAFE_INTEGER);
  }
  boundedArray(response.sources, "sources", request.literals.length, request.literals.length);
  for (const [index, source] of response.sources.entries()) {
    validateSource(source, index, request.perSourceDepth);
  }
  boundedArray(response.fused, "fused", 0, request.finalLimit);
  for (const [index, fused] of response.fused.entries()) validateFused(fused, index);
  boolean(response.fusedTruncated, "fusedTruncated");
}

function validateSource(source, ordinal, perSourceDepth) {
  exactObject(source, [
    "queryOrdinal",
    "truncated",
    "truncationReason",
    "rawPostingsScanned",
    "ranked",
  ], [], `sources[${ordinal}]`);
  equal(source.queryOrdinal, ordinal, `sources[${ordinal}].queryOrdinal`);
  boolean(source.truncated, `sources[${ordinal}].truncated`);
  if (!["exhausted", "source-depth", "posting-budget"].includes(source.truncationReason)) {
    invalid(`sources[${ordinal}].truncationReason is invalid`, "protocol_violation");
  }
  boundedInteger(source.rawPostingsScanned, `sources[${ordinal}].rawPostingsScanned`, 0, 256);
  boundedArray(source.ranked, `sources[${ordinal}].ranked`, 0, perSourceDepth);
  for (const [index, ranked] of source.ranked.entries()) {
    exactObject(ranked, ["rank", "sessionId", "score", "evidence"], [], "ranked result");
    equal(ranked.rank, index + 1, "ranked result rank");
    boundedString(ranked.sessionId, "ranked sessionId", 1, 128);
    finiteNumber(ranked.score, "ranked score");
    validateVerification(ranked.evidence);
    equal(ranked.evidence.sessionId, ranked.sessionId, "evidence sessionId");
  }
}

function validateVerification(pointer) {
  exactObject(pointer, [
    "sessionId",
    "documentKey",
    "seq",
    "eventTimeUnixMs",
    "eventType",
    "surface",
    "snippet",
  ], [], "verification pointer");
  boundedString(pointer.sessionId, "verification sessionId", 1, 128);
  boundedString(pointer.documentKey, "verification documentKey", 1, 512);
  unsignedString(pointer.seq, "verification seq", MAX_SQLITE_INTEGER);
  safeInteger(pointer.eventTimeUnixMs, "verification eventTimeUnixMs");
  boundedString(pointer.eventType, "verification eventType", 1, 96);
  boundedString(pointer.surface, "verification surface", 1, 64);
  nullableSnippet(pointer.snippet, "verification snippet");
}

function validateFused(fused, index) {
  exactObject(fused, [
    "rank",
    "sessionId",
    "rrfScore",
    "contributions",
  ], [], `fused[${index}]`);
  equal(fused.rank, index + 1, `fused[${index}].rank`);
  boundedString(fused.sessionId, `fused[${index}].sessionId`, 1, 128);
  finiteNumber(fused.rrfScore, `fused[${index}].rrfScore`);
  boundedArray(fused.contributions, `fused[${index}].contributions`, 1, 5);
  for (const contribution of fused.contributions) {
    exactObject(contribution, [
      "queryOrdinal",
      "sourceRank",
      "contribution",
      "documentKey",
      "seq",
      "snippet",
    ], [], "RRF contribution");
    boundedInteger(contribution.queryOrdinal, "contribution queryOrdinal", 0, 4);
    boundedInteger(contribution.sourceRank, "contribution sourceRank", 1, 100);
    finiteNumber(contribution.contribution, "contribution score");
    boundedString(contribution.documentKey, "contribution documentKey", 1, 512);
    unsignedString(contribution.seq, "contribution seq", MAX_SQLITE_INTEGER);
    nullableSnippet(contribution.snippet, "contribution snippet");
  }
}

function validateShutdownResponse(response) {
  exactObject(response, ["type", "version"], [], "shutdown response");
  equal(response.type, "shutdown", "shutdown response type");
  equal(response.version, SHUTDOWN_RESPONSE_VERSION, "shutdown response version");
}

function makeBoundary(options, defaultTimeoutMs) {
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    invalid("signal must be an AbortSignal");
  }
  let deadlineUnixMs;
  if (options.deadlineUnixMs !== undefined) {
    safeInteger(options.deadlineUnixMs, "deadlineUnixMs");
    if (options.deadlineUnixMs <= 0) invalid("deadlineUnixMs must be positive");
    deadlineUnixMs = options.deadlineUnixMs;
  }
  const timeoutMs = options.timeoutMs === undefined
    ? defaultTimeoutMs
    : timeout(options.timeoutMs, "timeoutMs");
  const timeoutDeadline = Date.now() + timeoutMs;
  deadlineUnixMs = deadlineUnixMs === undefined
    ? timeoutDeadline
    : Math.min(deadlineUnixMs, timeoutDeadline);
  return { deadlineUnixMs, signal: options.signal };
}

function ensureBoundary(boundary) {
  if (boundary.signal?.aborted) throw abortError(boundary.signal.reason);
  if (Date.now() >= boundary.deadlineUnixMs) throw deadlineError();
}

function raceBoundary(promise, boundary, onBoundary = undefined) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      boundary.signal?.removeEventListener("abort", aborted);
      callback(value);
    };
    const fail = (error) => {
      try {
        onBoundary?.(error);
      } finally {
        finish(reject, error);
      }
    };
    const aborted = () => fail(abortError(boundary.signal?.reason));
    const delay = Math.max(0, boundary.deadlineUnixMs - Date.now());
    const timer = setTimeout(() => fail(deadlineError()), delay);
    timer.unref?.();
    boundary.signal?.addEventListener("abort", aborted, { once: true });
    if (boundary.signal?.aborted) aborted();
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function deadlineError() {
  return new SessionIndexClientError("session-index request deadline exceeded", {
    code: "deadline_exceeded",
    retryable: true,
  });
}

function abortError(reason) {
  const error = new SessionIndexClientError("session-index operation aborted", {
    code: "aborted",
    cause: reason instanceof Error ? reason : undefined,
  });
  error.name = "AbortError";
  return error;
}

function normalizeSocketError(error, action) {
  if (error instanceof SessionIndexClientError) return error;
  return new SessionIndexClientError(`${action}: ${error?.message ?? String(error)}`, {
    code: "socket_error",
    retryable: true,
    cause: error instanceof Error ? error : undefined,
  });
}

function scopeTokens(values, name) {
  boundedArray(values, name, 1, 16);
  const unique = new Set();
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || !/^[a-z0-9]{1,64}$/u.test(value)) {
      invalid(`${name}[${index}] must be 1..64 lowercase ASCII alphanumeric bytes`);
    }
    if (unique.has(value)) invalid(`${name} must not contain duplicates`);
    unique.add(value);
  }
}

function stringList(values, name, maximumCount, maximumBytes) {
  boundedArray(values, name, 0, maximumCount);
  const unique = new Set();
  for (const [index, value] of values.entries()) {
    boundedString(value, `${name}[${index}]`, 1, maximumBytes);
    if (unique.has(value)) invalid(`${name} must not contain duplicates`);
    unique.add(value);
  }
}

function exactObject(value, required, optional, name) {
  plainObject(value, name);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${name} contains unknown field ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`${name} is missing ${key}`);
  }
}

function plainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype
          && Object.getPrototypeOf(value) !== null)) {
    invalid(`${name} must be an object`);
  }
}

function boundedArray(value, name, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    invalid(`${name} length must be ${minimum}..${maximum}`);
  }
}

function boundedString(value, name, minimumBytes, maximumBytes) {
  if (typeof value !== "string" || value.includes("\0")) {
    invalid(`${name} must be a NUL-free string`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > maximumBytes) {
    invalid(`${name} must contain ${minimumBytes}..${maximumBytes} UTF-8 bytes`);
  }
}

function identifier(value, name) {
  boundedString(value, name, 1, MAX_REQUEST_ID_BYTES);
  if (!/^[A-Za-z0-9_.:-]+$/u.test(value)) invalid(`${name} contains invalid bytes`);
}

function unsignedString(value, name, maximum = MAX_U64, positive = false) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    invalid(`${name} must be a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > maximum || (positive && parsed === 0n)) {
    invalid(`${name} is outside its supported range`);
  }
}

function safeInteger(value, name) {
  if (!Number.isSafeInteger(value)) invalid(`${name} must be a safe integer`);
}

function boundedInteger(value, name, minimum, maximum) {
  safeInteger(value, name);
  if (value < minimum || value > maximum) invalid(`${name} must be ${minimum}..${maximum}`);
}

function timeout(value, name) {
  boundedInteger(value, name, 1, MAX_TIMEOUT_MS);
  return value;
}

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${name} must be finite`);
}

function boolean(value, name) {
  if (typeof value !== "boolean") invalid(`${name} must be boolean`);
}

function nullableSnippet(value, name) {
  if (value !== null) boundedString(value, name, 0, 1_024);
}

function equal(actual, expected, name) {
  if (actual !== expected) invalid(`${name} is unsupported`, "protocol_violation");
}

function invalid(message, code = "invalid_argument") {
  throw new SessionIndexClientError(message, { code });
}
