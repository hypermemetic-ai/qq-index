/**
 * Shadow-only bridge for qq-core migration.
 *
 * The legacy exact verifier remains the returned reference oracle. The compiled
 * view runs beside it and contributes only bounded parity/performance evidence.
 */
export function createConversationViewShadowAdapter(options) {
  exactObject(options, ["viewService", "referenceOracle"], [
    "observe", "selectOracleSessionIds", "selectViewSessionIds", "now",
  ], "shadow adapter options");
  object(options.viewService, "viewService");
  callable(options.viewService.queryView, "viewService.queryView");
  callable(options.referenceOracle, "referenceOracle");
  const observe = options.observe ?? (() => {});
  const selectOracle = options.selectOracleSessionIds ?? defaultOracleIds;
  const selectView = options.selectViewSessionIds ?? defaultViewIds;
  const now = options.now ?? (() => performance.now());
  for (const [value, name] of [[observe, "observe"], [selectOracle, "selectOracleSessionIds"], [selectView, "selectViewSessionIds"], [now, "now"]]) callable(value, name);

  return Object.freeze({
    async run(request, operationOptions = {}) {
      exactObject(request, ["viewRequest", "oracleRequest"], [], "shadow request");
      const started = now();
      const [oracle, view] = await Promise.allSettled([
        options.referenceOracle(request.oracleRequest, operationOptions),
        options.viewService.queryView(request.viewRequest, operationOptions),
      ]);
      const elapsedMs = boundedDuration(now() - started);
      if (oracle.status === "rejected") {
        observe(deepFreeze({
          operation: "conversation-view-shadow",
          outcome: "oracle-error",
          elapsedMs,
          oracleCount: 0,
          viewCount: view.status === "fulfilled" ? boundedIds(selectView(view.value)).length : 0,
          parity: false,
          viewStatus: view.status === "fulfilled" ? "ok" : codeOf(view.reason),
        }));
        throw oracle.reason;
      }
      const oracleIds = boundedIds(selectOracle(oracle.value));
      if (view.status === "rejected") {
        const evidence = deepFreeze({
          operation: "conversation-view-shadow",
          outcome: "view-error",
          elapsedMs,
          oracleCount: oracleIds.length,
          viewCount: 0,
          parity: false,
          viewStatus: codeOf(view.reason),
        });
        observe(evidence);
        return deepFreeze({ oracleResult: oracle.value, shadow: evidence });
      }
      const viewIds = boundedIds(selectView(view.value));
      const parity = oracleIds.length === viewIds.length
        && oracleIds.every((sessionId, index) => sessionId === viewIds[index]);
      const evidence = deepFreeze({
        operation: "conversation-view-shadow",
        outcome: parity ? "parity" : "mismatch",
        elapsedMs,
        oracleCount: oracleIds.length,
        viewCount: viewIds.length,
        parity,
        viewStatus: "ok",
      });
      observe(evidence);
      return deepFreeze({ oracleResult: oracle.value, shadow: evidence });
    },
  });
}

function defaultOracleIds(value) {
  if (Array.isArray(value?.verifiedCandidates)) return value.verifiedCandidates.map(({ sessionId }) => sessionId);
  if (Array.isArray(value?.fused)) return value.fused.map(({ sessionId }) => sessionId);
  throw new TypeError("reference oracle result has no supported session list");
}

function defaultViewIds(value) {
  if (!Array.isArray(value?.result?.sessions)) throw new TypeError("view result has no sessions");
  return value.result.sessions.map(({ sessionId }) => sessionId);
}

function boundedIds(value) {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError("shadow session ids exceed bound");
  return value.map((sessionId) => {
    if (typeof sessionId !== "string" || sessionId.length === 0 || Buffer.byteLength(sessionId, "utf8") > 128) {
      throw new TypeError("shadow session id is invalid");
    }
    return sessionId;
  });
}

function boundedDuration(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, value) : 0;
}

function codeOf(error) {
  if (typeof error?.code !== "string" || error.code.length === 0) return "shadow_error";
  return error.code.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/gu, "_");
}

function exactObject(value, required, optional, name) {
  object(value, name);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${name}.${key} is required`);
}
function object(value, name) { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`); }
function callable(value, name) { if (typeof value !== "function") throw new TypeError(`${name} must be a function`); }
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
