import {
  VIEW_MODULE_ABI_VERSION,
  deepFreeze,
  defineViewModuleV1,
  exactObject,
  integer,
  plainObject,
  stringList,
  text,
  toWireAuthority,
  validatePublicQueryEnvelope,
} from "./registry.mjs";

export const CONVERSATION_VIEW_ID = "qq.session.conversation";
export const CONVERSATION_VIEW_VERSION = 1;
export const CONVERSATION_ACCESS = "literal-session-search";

const manifest = deepFreeze({
  id: CONVERSATION_VIEW_ID,
  version: CONVERSATION_VIEW_VERSION,
  digest: "sha256:d0b9747489491459e3f7c2cabe2c31d032d8be93ccec1519803d8a512de7b4a5",
  buildId: "conversation-v1-physical-1",
  sourceContract: "dsh-v0.1.2-alpha.4/observeSession",
  sourceStateVersion: "qq-session-conversation-projection-v1",
  partitionKey: "sessionId",
  rowSchema: "qq-session-conversation-row-v1",
  authorizationContract: "workspace-token-set/v1",
  maximumPartitionRows: 1_024,
  maximumPartitionBytes: 900 * 1_024,
  physicalSchema: "qq-session-conversation-sqlite-v1",
  testOnly: false,
  accesses: [{
    name: CONVERSATION_ACCESS,
    maximumResults: 100,
    maximumWorkUnits: 1_280,
    authorization: "workspace-token-set/v1:pre-rank",
  }],
});

export const conversationViewV1 = defineViewModuleV1({
  abiVersion: VIEW_MODULE_ABI_VERSION,
  manifest,
  prepareQuery(request, { deriveWorkspaceScopeToken } = {}) {
    validatePublicQueryEnvelope(request, {
      id: CONVERSATION_VIEW_ID,
      version: CONVERSATION_VIEW_VERSION,
      access: CONVERSATION_ACCESS,
    });
    validateParams(request.params);
    return deepFreeze({
      version: request.version,
      view: structuredClone(request.view),
      access: request.access,
      params: structuredClone(request.params),
      authority: toWireAuthority(request.authority.workspaceIds, deriveWorkspaceScopeToken),
      freshness: structuredClone(request.freshness),
    });
  },
  validateResult(request, response) {
    plainObject(response.result, "conversation result");
    exactObject(response.result, ["sessions", "truncated"], [], "conversation result");
    if (!Array.isArray(response.result.sessions) || response.result.sessions.length > request.params.limit) {
      throw new TypeError("conversation result sessions exceed requested limit");
    }
    if (typeof response.result.truncated !== "boolean") throw new TypeError("conversation result truncated must be boolean");
    for (const [index, session] of response.result.sessions.entries()) validateSession(session, index, request.params.literals.length);
    return deepFreeze(structuredClone(response));
  },
});

function validateParams(params) {
  exactObject(params, ["literals", "limit"], ["afterUnixMs", "beforeUnixMs", "eventTypes", "surfaces"], "conversation params");
  stringList(params.literals, "conversation literals", 1, 5, 512);
  if (params.literals.some((literal) => literal.trim() === "")) throw new TypeError("conversation literals must not be blank");
  integer(params.limit, "conversation limit", 1, 100);
  for (const key of ["afterUnixMs", "beforeUnixMs"]) {
    if (params[key] !== undefined) integer(params[key], `conversation ${key}`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  }
  if (params.afterUnixMs !== undefined && params.beforeUnixMs !== undefined && params.afterUnixMs > params.beforeUnixMs) {
    throw new TypeError("conversation afterUnixMs must not exceed beforeUnixMs");
  }
  for (const [key, maximumBytes] of [["eventTypes", 96], ["surfaces", 64]]) {
    if (params[key] !== undefined) {
      stringList(params[key], `conversation ${key}`, 0, 32, maximumBytes);
      if (new Set(params[key]).size !== params[key].length) throw new TypeError(`conversation ${key} must be unique`);
    }
  }
}

function validateSession(session, index, literalCount) {
  exactObject(session, [
    "rank", "sessionId", "score", "matchingLiteralOrdinals", "title",
    "sessionUpdatedAtUnixMs", "evidence",
  ], [], `conversation sessions[${index}]`);
  integer(session.rank, "conversation rank", index + 1, index + 1);
  text(session.sessionId, "conversation sessionId", 1, 128);
  if (typeof session.score !== "number" || !Number.isFinite(session.score)) throw new TypeError("conversation score must be finite");
  if (!Array.isArray(session.matchingLiteralOrdinals) || session.matchingLiteralOrdinals.length === 0 || session.matchingLiteralOrdinals.length > literalCount) {
    throw new TypeError("conversation matchingLiteralOrdinals are invalid");
  }
  for (const ordinal of session.matchingLiteralOrdinals) integer(ordinal, "conversation literal ordinal", 0, literalCount - 1);
  text(session.title, "conversation title", 0, 4_096);
  integer(session.sessionUpdatedAtUnixMs, "conversation sessionUpdatedAtUnixMs", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  exactObject(session.evidence, ["rowKey", "seq", "eventTimeUnixMs", "eventType", "surface"], [], "conversation evidence");
  text(session.evidence.rowKey, "conversation evidence rowKey", 1, 256);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(session.evidence.seq)) throw new TypeError("conversation evidence seq must be unsigned decimal");
  integer(session.evidence.eventTimeUnixMs, "conversation evidence eventTimeUnixMs", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  text(session.evidence.eventType, "conversation evidence eventType", 1, 96);
  text(session.evidence.surface, "conversation evidence surface", 1, 64);
}

/**
 * Close one alpha.4 immutable observation into conversation-v1 rows.
 * Canonical DSH extraction/folds are injected; this compiled view owns all row,
 * coordinate, identity, title-cut, workspace-token and bound validation.
 */
export function createConversationProjectorV1(dependencies) {
  exactObject(dependencies, [
    "deriveWorkspaceScopeToken", "workspaceIdForHeader", "projectEvent",
    "titleForObservation", "revisionForObservation",
  ], [], "conversation projector dependencies");
  for (const key of Object.keys(dependencies)) {
    if (typeof dependencies[key] !== "function") throw new TypeError(`conversation projector ${key} must be a function`);
  }
  return async function projectConversationObservation(observation, { sessionId, signal } = {}) {
    if (signal?.aborted) throw signal.reason ?? new Error("conversation projection aborted");
    plainObjectLike(observation, "conversation observation");
    plainObjectLike(observation.header, "conversation observation header");
    text(sessionId, "conversation projection sessionId", 1, 128);
    const headerId = observation.header.id ?? observation.header.sessionId;
    text(headerId, "conversation observation header id", 1, 128);
    if (headerId !== sessionId) throw new TypeError("conversation observation header id mismatch");
    if (!Array.isArray(observation.events) || !Number.isSafeInteger(observation.cursor)
      || observation.cursor < -1 || observation.cursor + 1 !== observation.events.length) {
      throw new TypeError("conversation observation events/cursor are invalid");
    }
    const workspaceId = await dependencies.workspaceIdForHeader(observation.header);
    text(workspaceId, "conversation workspaceId", 1, 4_096);
    const workspaceScopeToken = dependencies.deriveWorkspaceScopeToken(workspaceId);
    text(workspaceScopeToken, "conversation workspaceScopeToken", 1, 64);
    if (!/^[a-z0-9]+$/u.test(workspaceScopeToken)) throw new TypeError("conversation workspaceScopeToken is malformed");
    const sessionTitle = await dependencies.titleForObservation(observation);
    text(sessionTitle, "conversation sessionTitle", 0, 4_096);
    const durableRevision = await dependencies.revisionForObservation(observation);
    text(durableRevision, "conversation durableRevision", 1, 4_096);
    const rows = [];
    for (const [index, event] of observation.events.entries()) {
      if (signal?.aborted) throw signal.reason ?? new Error("conversation projection aborted");
      plainObjectLike(event, `conversation event[${index}]`);
      const seq = event.seq ?? index;
      integer(seq, `conversation event[${index}].seq`, 0, Number.MAX_SAFE_INTEGER);
      if (seq !== index) throw new TypeError("conversation observation event seq must be contiguous from zero");
      const projected = await dependencies.projectEvent(event, {
        observation,
        index,
        signal,
      });
      if (projected === null) continue;
      exactObject(projected, [
        "body", "eventTimeUnixMs", "eventType", "surface", "fingerprint",
      ], [], `conversation projected event[${index}]`);
      text(projected.body, "conversation body", 0, 1_048_576);
      integer(projected.eventTimeUnixMs, "conversation eventTimeUnixMs", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      text(projected.eventType, "conversation eventType", 1, 96);
      text(projected.surface, "conversation surface", 1, 64);
      text(projected.fingerprint, "conversation fingerprint", 1, 256);
      rows.push({
        rowKey: `conversation-v1:${Buffer.byteLength(sessionId, "utf8")}:${sessionId}:${seq}`,
        sessionId,
        seq,
        eventTimeUnixMs: projected.eventTimeUnixMs,
        eventType: projected.eventType,
        surface: projected.surface,
        workspaceScopeToken,
        body: projected.body,
        fingerprint: projected.fingerprint,
        sessionTitle,
        sessionUpdatedAtUnixMs: projected.eventTimeUnixMs,
      });
      if (rows.length > 1_024) throw new TypeError("conversation observation exceeds 1024-row mutation bound");
    }
    const sessionUpdatedAtUnixMs = rows.reduce(
      (latest, row) => Math.max(latest, row.eventTimeUnixMs),
      Number.MIN_SAFE_INTEGER,
    );
    for (const row of rows) {
      row.sessionUpdatedAtUnixMs = rows.length === 0 ? 0 : sessionUpdatedAtUnixMs;
    }
    return deepFreeze({ rows, durableRevision });
  };
}

function plainObjectLike(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}
