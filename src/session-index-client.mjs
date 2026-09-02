import { createConnection } from "node:net";
import { isAbsolute } from "node:path";

export const SESSION_INDEX_PROTOCOL_VERSION = "qq-session-index-protocol-v1";
export const SESSION_INDEX_MUTATION_VERSION = "mutation-batch-v1";
export const SESSION_INDEX_SEARCH_VERSION = "search-batch-v1";
export const SESSION_INDEX_SOURCE_STATE_VERSION = "source-state-v1";
export const SESSION_INDEX_CANCEL_VERSION = "cancel-v1";
export const SESSION_INDEX_VIEW_DESCRIBE_VERSION = "qq-index-view-describe/v1";
export const SESSION_INDEX_VIEW_MUTATION_VERSION = "qq-index-view-mutation/v1";
export const SESSION_INDEX_VIEW_LIFECYCLE_VERSION = "qq-index-view-lifecycle/v1";
export const SESSION_INDEX_VIEW_PARTITION_STATE_VERSION = "qq-index-view-partition-state/v1";
export const SESSION_INDEX_VIEW_QUERY_VERSION = "qq-index-query/v1";
export const SESSION_INDEX_MAX_FRAME_BYTES = 1024 * 1024;

const HEALTH_RESPONSE_VERSION = "health-response-v1";
const COMMIT_RECEIPT_VERSION = "commit-receipt-v1";
const SEARCH_RESPONSE_VERSION = "search-batch-response-v1";
const SHUTDOWN_RESPONSE_VERSION = "shutdown-response-v1";
const SOURCE_STATE_RESPONSE_VERSION = "source-state-response-v1";
const CANCEL_RESPONSE_VERSION = "cancel-response-v1";
const VIEW_DESCRIBE_RESPONSE_VERSION = "qq-index-view-describe-response/v1";
const VIEW_RESPONSE_VERSION = "qq-index-view-response/v1";
const SCHEMA_FINGERPRINT = "qq-session-index-schema-v1";
const PROJECTION_VERSION = "qq-session-projection-v1";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_REQUEST_ID_BYTES = 128;
const MAX_DOCUMENTS = 1_024;
const MAX_SOURCE_STATE_SESSIONS = 32;
const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;
const MAX_U64 = 18_446_744_073_709_551_615n;
const CANCELLATION_GRACE_MS = 250;
let controlCounter = 0;
let clientCounter = 0;
const TERMINAL_ERROR_CODES = new Set([
  "protocol_error",
  "unsupported_version",
  "invalid_request",
  "deadline_exceeded",
  "cancelled",
  "admission_rejected",
  "forbidden",
  "source_watermark_unavailable",
  "watermark_conflict",
  "idempotency_conflict",
  "mutation_conflict",
  "unsupported_view",
  "unsupported_access",
  "view_building",
  "view_failed",
  "freshness_unavailable",
  "authorization_required",
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
  exactObject(
    options,
    ["socketPath"],
    ["timeoutMs", "deadlineUnixMs", "signal", "activeCancellation"],
    "options",
  );
  if (options.activeCancellation !== undefined) {
    boolean(options.activeCancellation, "activeCancellation");
  }
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
  const client = new SessionIndexClient(
    socket,
    options.socketPath,
    defaultTimeoutMs,
    options.activeCancellation !== false,
  );
  if (options.activeCancellation !== false) {
    try {
      await client.health({
        deadlineUnixMs: boundary.deadlineUnixMs,
        signal: boundary.signal,
      });
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  return client;
}

class SessionIndexClient {
  #socket;
  #socketPath;
  #defaultTimeoutMs;
  #activeCancellation;
  #buffer = Buffer.alloc(0);
  #pending = null;
  #tail = Promise.resolve();
  #counter = 0;
  #clientId;
  #terminalError = null;
  #closed = false;

  constructor(socket, socketPath, defaultTimeoutMs, activeCancellation) {
    this.#socket = socket;
    this.#socketPath = socketPath;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    this.#activeCancellation = activeCancellation;
    this.#clientId = ++clientCounter;
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

  sourceState(request, options = {}) {
    exactObject(request, ["sessionIds"], [], "sourceState request");
    stringList(request.sessionIds, "sourceState sessionIds", MAX_SOURCE_STATE_SESSIONS, 128);
    const wireRequest = structuredClone(request);
    stringList(wireRequest.sessionIds, "sourceState sessionIds", MAX_SOURCE_STATE_SESSIONS, 128);
    return this.#enqueue(
      {
        type: "sourceState",
        version: SESSION_INDEX_SOURCE_STATE_VERSION,
        sessionIds: wireRequest.sessionIds,
      },
      (response) => validateSourceStateResponse(response, wireRequest.sessionIds),
      options,
    );
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

  describeViews(options = {}) {
    return this.#enqueue(
      { type: "describeViews", version: SESSION_INDEX_VIEW_DESCRIBE_VERSION },
      validateDescribeViewsResponse,
      options,
    );
  }

  viewPartitionState(request, options = {}) {
    exactObject(request, ["view", "partitionKeys"], [], "view partition state request");
    validateViewIdentity(request.view);
    stringList(request.partitionKeys, "partitionKeys", 64, 256);
    if (request.partitionKeys.length === 0) invalid("partitionKeys must not be empty");
    if (new Set(request.partitionKeys).size !== request.partitionKeys.length) invalid("partitionKeys must be unique");
    const detached = structuredClone(request);
    return this.#enqueue(
      { type: "viewPartitionState", version: SESSION_INDEX_VIEW_PARTITION_STATE_VERSION, ...detached },
      (response) => validateViewPartitionStateResponse(response, detached),
      options,
    );
  }

  mutateView(mutation, options = {}) {
    validateViewMutation(mutation);
    const detached = structuredClone(mutation);
    validateViewMutation(detached);
    return this.#enqueue(
      { type: "mutateView", version: SESSION_INDEX_VIEW_MUTATION_VERSION, mutation: detached },
      validateViewReceipt,
      options,
    );
  }

  setViewLifecycle(request, options = {}) {
    validateViewLifecycle(request);
    const detached = structuredClone(request);
    validateViewLifecycle(detached);
    return this.#enqueue(
      { type: "setViewLifecycle", version: SESSION_INDEX_VIEW_LIFECYCLE_VERSION, ...detached },
      validateViewReceipt,
      options,
    );
  }

  execute(request, options = {}) {
    validateViewExecuteRequest(request);
    const detached = structuredClone(request);
    validateViewExecuteRequest(detached);
    return this.#enqueue(
      { type: "execute", ...detached },
      (response) => validateViewQueryResponse(response, detached),
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
    if (this.#pending && this.#activeCancellation) {
      const pending = this.#pending;
      // A disconnect request uses the same independent control path. Keep the
      // primary socket readable until the target emits its terminal frame.
      Promise.resolve(sendCancellationControl(
        this.#socketPath,
        pending.requestId,
        "disconnect",
      )).catch(() => {});
      await Promise.race([
        pending.terminal,
        new Promise((resolveWait) => {
          const grace = setTimeout(resolveWait, CANCELLATION_GRACE_MS);
          grace.unref?.();
        }),
      ]);
      if (this.#pending?.requestId === pending.requestId) {
        this.#terminate(new SessionIndexClientError(
          "session-index disconnect cancellation was not acknowledged",
          { code: "cancellation_unacknowledged", retryable: true },
        ));
      }
    } else if (this.#pending) {
      this.#pending.reject(new SessionIndexClientError(
        "session-index client closed with a request pending",
        { code: "client_closed" },
      ));
      this.#pending.terminalResolve();
      this.#pending = null;
    }
    this.#closed = true;
    const closed = new Promise((resolve) => {
      if (this.#socket.destroyed) resolve();
      else this.#socket.once("close", resolve);
    });
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
    let started = false;
    const job = previous.then(() => {
      ensureBoundary(boundary);
      if (this.#closed) {
        throw new SessionIndexClientError("session-index client is closed", {
          code: "client_closed",
        });
      }
      if (this.#terminalError) throw this.#terminalError;
      started = true;
      return this.#roundTrip(operation, validator, boundary);
    });
    this.#tail = job.catch(() => {});
    // A queued call rejects without writing. Once started, the round trip owns
    // its boundary and waits for a daemon terminal cancellation response.
    return raceQueuedBoundary(job, boundary, () => started);
  }

  #roundTrip(operation, validator, boundary) {
    if (this.#pending) {
      throw new SessionIndexClientError("protocol invariant violated: concurrent request", {
        code: "protocol_violation",
      });
    }
    const requestId = `${process.pid}-${this.#clientId}-${++this.#counter}`;
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

    let terminalResolve;
    const terminal = new Promise((resolveTerminal) => { terminalResolve = resolveTerminal; });
    const response = new Promise((resolve, reject) => {
      this.#pending = {
        requestId,
        validator,
        resolve,
        reject,
        terminal,
        terminalResolve,
      };
      this.#socket.write(encoded, (error) => {
        if (error && this.#pending?.requestId === requestId) {
          this.#terminate(normalizeSocketError(error, "writing session-index request"));
        }
      });
    });
    if (!this.#activeCancellation) {
      return raceBoundary(response, boundary, (error) => this.#terminate(error));
    }
    return activeCancellationBoundary(
      response,
      boundary,
      async (reason) => sendCancellationControl(
        this.#socketPath,
        requestId,
        reason,
      ),
      (error) => this.#terminate(error),
    );
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
      pending.terminalResolve();
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
      this.#pending.terminalResolve();
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
    "cancelRequestVersion",
    "cancelResponseVersion",
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
  equal(response.cancelRequestVersion, SESSION_INDEX_CANCEL_VERSION, "cancel request version");
  equal(response.cancelResponseVersion, CANCEL_RESPONSE_VERSION, "cancel response version");
  unsignedString(response.generation, "generation", MAX_SQLITE_INTEGER);
  unsignedString(response.sourceWatermark, "sourceWatermark", MAX_SQLITE_INTEGER);
  exactObject(response.capabilities, [
    "localUnixSocket",
    "serializedRequests",
    "serializedWriter",
    "activeSqliteInterrupt",
    "progressDeadlineSupport",
    "readerCount",
    "queueCapacity",
    "readerRetirements",
    "activeReaders",
    "peakActiveReaders",
    "maxFrameBytes",
  ], [], "health capabilities");
  equal(response.capabilities.localUnixSocket, true, "localUnixSocket capability");
  equal(response.capabilities.serializedRequests, false, "serializedRequests capability");
  equal(response.capabilities.serializedWriter, true, "serializedWriter capability");
  equal(response.capabilities.activeSqliteInterrupt, true, "activeSqliteInterrupt capability");
  equal(response.capabilities.progressDeadlineSupport, true, "progressDeadlineSupport capability");
  boundedInteger(response.capabilities.readerCount, "readerCount", 1, 16);
  boundedInteger(response.capabilities.queueCapacity, "queueCapacity", 1, 1_024);
  safeInteger(response.capabilities.readerRetirements, "readerRetirements");
  if (response.capabilities.readerRetirements < 0) invalid("readerRetirements must be nonnegative");
  boundedInteger(response.capabilities.activeReaders, "activeReaders", 0, 16);
  boundedInteger(response.capabilities.peakActiveReaders, "peakActiveReaders", 0, 16);
  if (response.capabilities.peakActiveReaders < response.capabilities.activeReaders) {
    invalid("peakActiveReaders must cover activeReaders", "protocol_violation");
  }
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
  boundedString(document.body, `${name}.body`, 0, 1_048_576);
  boundedString(document.fingerprint, `${name}.fingerprint`, 1, 256);
  boundedString(document.sourceRevision, `${name}.sourceRevision`, 1, 256);
}

function validateSourceStateResponse(response, requestedSessionIds) {
  exactObject(response, [
    "type",
    "version",
    "generation",
    "sourceWatermark",
    "sessions",
  ], [], "sourceState response");
  equal(response.type, "sourceState", "sourceState response type");
  equal(response.version, SOURCE_STATE_RESPONSE_VERSION, "sourceState response version");
  unsignedString(response.generation, "sourceState generation", MAX_SQLITE_INTEGER);
  unsignedString(response.sourceWatermark, "sourceState sourceWatermark", MAX_SQLITE_INTEGER);
  boundedArray(response.sessions, "sourceState sessions", 0, requestedSessionIds.length);
  const requested = new Set(requestedSessionIds);
  const received = new Set();
  for (const [index, session] of response.sessions.entries()) {
    const name = `sourceState sessions[${index}]`;
    exactObject(session, [
      "sessionId",
      "nextSeq",
      "workspaceId",
      "headerRevision",
    ], [], name);
    boundedString(session.sessionId, `${name}.sessionId`, 1, 128);
    if (!requested.has(session.sessionId) || received.has(session.sessionId)) {
      invalid(`${name}.sessionId was not uniquely requested`, "protocol_violation");
    }
    received.add(session.sessionId);
    unsignedString(session.nextSeq, `${name}.nextSeq`, MAX_SQLITE_INTEGER);
    boundedString(session.workspaceId, `${name}.workspaceId`, 1, 4_096);
    boundedString(session.headerRevision, `${name}.headerRevision`, 1, 256);
  }
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
    "eventTypeAllowList",
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
  stringList(filters.eventTypeAllowList, "filters.eventTypeAllowList", 32, 96);
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


function validateViewIdentity(view, name = "view") {
  exactObject(view, ["id", "version"], [], name);
  boundedString(view.id, `${name}.id`, 1, 128);
  boundedInteger(view.version, `${name}.version`, 1, 0xffff_ffff);
}

function validateViewMutation(mutation) {
  plainObject(mutation, "view mutation");
  const common = ["kind", "view", "partitionKey"];
  if (mutation.kind === "replacePartition") {
    exactObject(mutation, [...common, "source", "rows"], [], "view mutation");
    validateViewSource(mutation.source, "view mutation source");
    boundedArray(mutation.rows, "view mutation rows", 0, MAX_DOCUMENTS);
    validateJsonPayload(mutation.rows, "view mutation rows");
  } else if (mutation.kind === "applyDelta") {
    exactObject(mutation, [...common, "expectedCursor", "source", "upserts", "deletes"], [], "view mutation");
    unsignedString(mutation.expectedCursor, "expectedCursor", MAX_SQLITE_INTEGER);
    validateViewSource(mutation.source, "view mutation source");
    boundedArray(mutation.upserts, "view mutation upserts", 0, MAX_DOCUMENTS);
    stringList(mutation.deletes, "view mutation deletes", MAX_DOCUMENTS, 256);
    validateJsonPayload(mutation.upserts, "view mutation upserts");
  } else if (mutation.kind === "deletePartition") {
    exactObject(mutation, [...common, "expectedCursor", "sourceIdentity", "sourceFence", "lagMs"], [], "view mutation");
    unsignedString(mutation.expectedCursor, "expectedCursor", MAX_SQLITE_INTEGER);
    boundedString(mutation.sourceIdentity, "sourceIdentity", 1, 4_096);
    boundedString(mutation.sourceFence, "sourceFence", 1, 4_096);
    nonnegativeSafeInteger(mutation.lagMs, "lagMs");
  } else {
    invalid("view mutation kind is unsupported");
  }
  validateViewIdentity(mutation.view);
  boundedString(mutation.partitionKey, "partitionKey", 1, 256);
}

function validateViewSource(source, name) {
  exactObject(source, ["sourceIdentity", "durableRevision", "nextCursor", "sourceFence", "lagMs"], [], name);
  boundedString(source.sourceIdentity, `${name}.sourceIdentity`, 1, 4_096);
  boundedString(source.durableRevision, `${name}.durableRevision`, 1, 4_096);
  unsignedString(source.nextCursor, `${name}.nextCursor`, MAX_SQLITE_INTEGER);
  boundedString(source.sourceFence, `${name}.sourceFence`, 1, 4_096);
  nonnegativeSafeInteger(source.lagMs, `${name}.lagMs`);
}

function validateViewLifecycle(request) {
  exactObject(request, ["view", "state", "sourceFence", "lagMs"], [], "view lifecycle request");
  validateViewIdentity(request.view);
  if (!["ready", "building", "failed"].includes(request.state)) invalid("view lifecycle state is unsupported");
  boundedString(request.sourceFence, "sourceFence", 1, 4_096);
  nonnegativeSafeInteger(request.lagMs, "lagMs");
}

function validateViewExecuteRequest(request) {
  exactObject(request, ["version", "view", "access", "params", "authority", "freshness"], [], "view execute request");
  equal(request.version, SESSION_INDEX_VIEW_QUERY_VERSION, "view query version");
  validateViewIdentity(request.view);
  boundedString(request.access, "view access", 1, 128);
  plainObject(request.params, "view params");
  validateJsonPayload(request.params, "view params");
  exactObject(request.authority, ["kind", "scopeTokens"], [], "view authority");
  equal(request.authority.kind, "workspace-token-set/v1", "view authority kind");
  stringList(request.authority.scopeTokens, "scopeTokens", 16, 64);
  if (request.authority.scopeTokens.length === 0) invalid("scopeTokens must not be empty");
  for (const token of request.authority.scopeTokens) {
    if (!/^[a-z0-9]+$/u.test(token)) invalid("scopeTokens must be lowercase ASCII alphanumeric");
  }
  exactObject(request.freshness, ["mode", "maxLagMs"], [], "view freshness");
  equal(request.freshness.mode, "caught-up", "view freshness mode");
  nonnegativeSafeInteger(request.freshness.maxLagMs, "maxLagMs");
}

function validateDescribeViewsResponse(response) {
  exactObject(response, ["type", "version", "views"], [], "describe views response");
  equal(response.type, "describeViews", "describe views response type");
  equal(response.version, VIEW_DESCRIBE_RESPONSE_VERSION, "describe views response version");
  boundedArray(response.views, "described views", 1, 64);
  for (const [index, entry] of response.views.entries()) validateViewDescription(entry, `views[${index}]`);
}

function validateViewDescription(entry, name) {
  exactObject(entry, ["manifest", "state", "snapshot"], [], name);
  const manifest = entry.manifest;
  exactObject(manifest, [
    "id", "version", "digest", "buildId", "sourceContract", "sourceStateVersion",
    "partitionKey", "rowSchema", "authorizationContract", "physicalSchema",
    "maximumPartitionRows", "maximumPartitionBytes", "testOnly", "accesses",
  ], [], `${name}.manifest`);
  validateViewIdentity({ id: manifest.id, version: manifest.version }, `${name}.manifest identity`);
  for (const key of ["digest", "buildId", "sourceContract", "sourceStateVersion", "partitionKey", "rowSchema", "authorizationContract", "physicalSchema"]) {
    boundedString(manifest[key], `${name}.manifest.${key}`, 1, 256);
  }
  boundedInteger(manifest.maximumPartitionRows, `${name}.manifest.maximumPartitionRows`, 1, MAX_DOCUMENTS);
  boundedInteger(manifest.maximumPartitionBytes, `${name}.manifest.maximumPartitionBytes`, 1_024, 900 * 1_024);
  boolean(manifest.testOnly, `${name}.manifest.testOnly`);
  boundedArray(manifest.accesses, `${name}.manifest.accesses`, 1, 32);
  for (const access of manifest.accesses) {
    exactObject(access, ["name", "maximumResults", "maximumWorkUnits", "authorization"], [], `${name}.manifest.access`);
    boundedString(access.name, `${name}.manifest.access.name`, 1, 128);
    boundedInteger(access.maximumResults, `${name}.manifest.access.maximumResults`, 1, 10_000);
    boundedInteger(access.maximumWorkUnits, `${name}.manifest.access.maximumWorkUnits`, 1, 1_000_000);
    boundedString(access.authorization, `${name}.manifest.access.authorization`, 1, 128);
  }
  validateViewState(entry.state, `${name}.state`);
  validateViewSnapshot(entry.snapshot, `${name}.snapshot`);
}

function validateViewPartitionStateResponse(response, request) {
  exactObject(response, ["type", "version", "view", "buildId", "snapshot", "partitions"], [], "view partition state response");
  equal(response.type, "viewPartitionState", "view partition state response type");
  equal(response.version, SESSION_INDEX_VIEW_PARTITION_STATE_VERSION, "view partition state response version");
  validateViewIdentity(response.view);
  equal(response.view.id, request.view.id, "partition state view id");
  equal(response.view.version, request.view.version, "partition state view version");
  boundedString(response.buildId, "partition state buildId", 1, 256);
  validateViewSnapshot(response.snapshot, "partition state snapshot");
  boundedArray(response.partitions, "partition states", 0, request.partitionKeys.length);
  const requested = new Set(request.partitionKeys);
  const seen = new Set();
  for (const partition of response.partitions) {
    exactObject(partition, ["partitionKey", "sourceIdentity", "durableRevision", "nextCursor", "generation"], [], "partition state");
    boundedString(partition.partitionKey, "partition state partitionKey", 1, 256);
    if (!requested.has(partition.partitionKey) || seen.has(partition.partitionKey)) invalid("partition state contains unexpected or duplicate partition", "protocol_violation");
    seen.add(partition.partitionKey);
    boundedString(partition.sourceIdentity, "partition state sourceIdentity", 1, 4_096);
    boundedString(partition.durableRevision, "partition state durableRevision", 1, 4_096);
    unsignedString(partition.nextCursor, "partition state nextCursor", MAX_SQLITE_INTEGER);
    unsignedString(partition.generation, "partition state generation", MAX_SQLITE_INTEGER);
  }
}

function validateViewReceipt(response) {
  exactObject(response, [
    "type", "version", "view", "buildId", "state", "snapshot", "partitionKey",
    "nextCursor", "affectedRows", "telemetry",
  ], [], "view mutation response");
  equal(response.type, "mutateView", "view mutation response type");
  equal(response.version, VIEW_RESPONSE_VERSION, "view mutation response version");
  validateViewIdentity(response.view);
  boundedString(response.buildId, "buildId", 1, 256);
  validateViewState(response.state, "view state");
  validateViewSnapshot(response.snapshot, "view snapshot");
  if (response.partitionKey !== null) boundedString(response.partitionKey, "partitionKey", 1, 256);
  if (response.nextCursor !== null) unsignedString(response.nextCursor, "nextCursor", MAX_SQLITE_INTEGER);
  boundedInteger(response.affectedRows, "affectedRows", 0, 2 * MAX_DOCUMENTS);
  validateViewTelemetry(response.telemetry);
}

function validateViewQueryResponse(response, request) {
  exactObject(response, [
    "type", "version", "view", "buildId", "access", "snapshot", "result", "telemetry",
  ], [], "view query response");
  equal(response.type, "execute", "view query response type");
  equal(response.version, VIEW_RESPONSE_VERSION, "view query response version");
  validateViewIdentity(response.view);
  equal(response.view.id, request.view.id, "view response id");
  equal(response.view.version, request.view.version, "view response version identity");
  equal(response.access, request.access, "view response access");
  boundedString(response.buildId, "buildId", 1, 256);
  validateViewSnapshot(response.snapshot, "view snapshot");
  plainObject(response.result, "view result");
  validateJsonPayload(response.result, "view result");
  validateViewTelemetry(response.telemetry);
}

function validateViewState(state, name) {
  if (!["ready", "building", "failed"].includes(state)) invalid(`${name} is unsupported`, "protocol_violation");
}

function validateViewSnapshot(snapshot, name) {
  exactObject(snapshot, ["generation", "sourceFence", "lagMs"], [], name);
  unsignedString(snapshot.generation, `${name}.generation`, MAX_SQLITE_INTEGER);
  boundedString(snapshot.sourceFence, `${name}.sourceFence`, 1, 4_096);
  unsignedString(snapshot.lagMs, `${name}.lagMs`, MAX_SQLITE_INTEGER);
}

function validateViewTelemetry(telemetry) {
  exactObject(telemetry, ["operation", "outcome", "elapsedMicros", "phasesMicros", "counts"], [], "view telemetry");
  boundedString(telemetry.operation, "view telemetry operation", 1, 64);
  if (!["ok", "error"].includes(telemetry.outcome)) invalid("view telemetry outcome is unsupported", "protocol_violation");
  unsignedString(telemetry.elapsedMicros, "view telemetry elapsedMicros");
  validateUnsignedMap(telemetry.phasesMicros, "view telemetry phasesMicros");
  validateUnsignedMap(telemetry.counts, "view telemetry counts");
}

function validateUnsignedMap(value, name) {
  plainObject(value, name);
  if (Object.keys(value).length > 32) invalid(`${name} exceeds field bound`, "protocol_violation");
  for (const [key, entry] of Object.entries(value)) {
    identifier(key, `${name} key`);
    unsignedString(entry, `${name}.${key}`);
  }
}

function validateJsonPayload(value, name) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch (cause) { invalid(`${name} must be JSON serializable`, "invalid_argument", cause); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 900 * 1_024) {
    invalid(`${name} exceeds JSON payload bound`);
  }
}

function validateShutdownResponse(response) {
  exactObject(response, ["type", "version"], [], "shutdown response");
  equal(response.type, "shutdown", "shutdown response type");
  equal(response.version, SHUTDOWN_RESPONSE_VERSION, "shutdown response version");
}

function raceQueuedBoundary(promise, boundary, started) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      boundary.signal?.removeEventListener("abort", aborted);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const failIfQueued = (error) => {
      if (started()) {
        cleanup();
        return;
      }
      finish(reject, error);
    };
    const aborted = () => failIfQueued(abortError(boundary.signal?.reason));
    const timer = setTimeout(
      () => failIfQueued(deadlineError()),
      Math.max(0, boundary.deadlineUnixMs - Date.now()),
    );
    timer.unref?.();
    boundary.signal?.addEventListener("abort", aborted, { once: true });
    if (boundary.signal?.aborted) aborted();
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function activeCancellationBoundary(response, boundary, sendCancel, onUnacknowledged) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelling = false;
    let deadlineTimer;
    let graceTimer;
    const cleanup = () => {
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      boundary.signal?.removeEventListener("abort", aborted);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const beginCancellation = (reason, boundaryError) => {
      if (settled || cancelling) return;
      cancelling = true;
      clearTimeout(deadlineTimer);
      boundary.signal?.removeEventListener("abort", aborted);
      // The control exchange is deliberately independent of the primary socket.
      // Its response is useful validation, but only the target terminal frame is
      // cancellation acknowledgement.
      Promise.resolve(sendCancel(reason)).catch(() => {});
      graceTimer = setTimeout(() => {
        const error = new SessionIndexClientError(
          "session-index daemon did not acknowledge active cancellation within the bounded grace",
          {
            code: "cancellation_unacknowledged",
            retryable: true,
            cause: boundaryError,
          },
        );
        onUnacknowledged(error);
        finish(reject, error);
      }, CANCELLATION_GRACE_MS);
      graceTimer.unref?.();
    };
    const aborted = () => beginCancellation("caller", abortError(boundary.signal?.reason));
    deadlineTimer = setTimeout(
      () => beginCancellation("deadline", deadlineError()),
      Math.max(0, boundary.deadlineUnixMs - Date.now()),
    );
    deadlineTimer.unref?.();
    boundary.signal?.addEventListener("abort", aborted, { once: true });
    if (boundary.signal?.aborted) aborted();
    Promise.resolve(response).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function sendCancellationControl(socketPath, targetRequestId, reason) {
  const requestId = `cancel-${process.pid}-${Date.now().toString(36)}-${++controlCounter}`;
  identifier(requestId, "cancel requestId");
  const deadlineUnixMs = Date.now() + CANCELLATION_GRACE_MS;
  const envelope = {
    protocolVersion: SESSION_INDEX_PROTOCOL_VERSION,
    requestId,
    deadlineUnixMs,
    operation: {
      type: "cancel",
      version: SESSION_INDEX_CANCEL_VERSION,
      targetRequestId,
      reason,
    },
  };
  const response = await oneShotControlRoundTrip(socketPath, envelope, CANCELLATION_GRACE_MS);
  validateEnvelope(response, requestId);
  if (!response.ok) throw daemonError(response.error, requestId);
  validateCancelResponse(response.response, targetRequestId);
  return response.response;
}

function oneShotControlRoundTrip(socketPath, envelope, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    const timer = setTimeout(() => finish(
      reject,
      new SessionIndexClientError("session-index cancellation control timed out", {
        code: "cancellation_control_timeout",
        retryable: true,
      }),
    ), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => socket.write(`${JSON.stringify(envelope)}\n`));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        if (buffer.length > SESSION_INDEX_MAX_FRAME_BYTES) {
          finish(reject, new SessionIndexClientError(
            "session-index cancellation response exceeded frame bound",
            { code: "protocol_violation" },
          ));
        }
        return;
      }
      if (newline > SESSION_INDEX_MAX_FRAME_BYTES) {
        finish(reject, new SessionIndexClientError(
          "session-index cancellation response exceeded frame bound",
          { code: "protocol_violation" },
        ));
        return;
      }
      try {
        finish(resolve, JSON.parse(buffer.subarray(0, newline).toString("utf8")));
      } catch (cause) {
        finish(reject, new SessionIndexClientError(
          "invalid cancellation response from session-index daemon",
          { code: "protocol_violation", cause },
        ));
      }
    });
    socket.once("error", (error) => finish(
      reject,
      normalizeSocketError(error, "session-index cancellation control socket"),
    ));
    socket.once("end", () => finish(
      reject,
      new SessionIndexClientError("session-index cancellation control socket closed", {
        code: "socket_closed",
        retryable: true,
      }),
    ));
  });
}

function validateCancelResponse(response, targetRequestId) {
  exactObject(response, [
    "type",
    "version",
    "targetRequestId",
    "state",
    "cancellationRequested",
  ], [], "cancel response");
  equal(response.type, "cancel", "cancel response type");
  equal(response.version, CANCEL_RESPONSE_VERSION, "cancel response version");
  equal(response.targetRequestId, targetRequestId, "cancel targetRequestId");
  if (!["queued", "active", "terminal", "not-found"].includes(response.state)) {
    invalid("cancel response state is unsupported", "protocol_violation");
  }
  boolean(response.cancellationRequested, "cancel response cancellationRequested");
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

function nonnegativeSafeInteger(value, name) {
  safeInteger(value, name);
  if (value < 0) invalid(`${name} must be nonnegative`);
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
