import assert from "node:assert/strict";

import {
  createSessionIndexRuntime,
  validateSessionIndexConfig,
} from "@hypermemetic-ai/qq-index/session-index-runtime";

assert.deepEqual(validateSessionIndexConfig({}), { enabled: false });
assert.deepEqual(validateSessionIndexConfig({ sessionIndex: { enabled: false, socketPath: "ignored" } }), {
  enabled: false,
});
assert.throws(
  () => validateSessionIndexConfig({ sessionIndex: { enabled: true, socketPath: "relative.sock" } }),
  /absolute/u,
);
assert.throws(
  () => validateSessionIndexConfig({
    sessionIndex: { enabled: true, socketPath: "/generated.sock", monitorIntervalMs: 99 },
  }),
  /100/u,
);
assert.throws(
  () => validateSessionIndexConfig({
    sessionIndex: { enabled: true, socketPath: "/generated.sock", unknown: true },
  }),
  /unknown/u,
);

let inertCalls = 0;
const inert = createSessionIndexRuntime({}, {
  connectClient() {
    inertCalls += 1;
    throw new Error("disabled runtime performed I/O");
  },
  createSource() {
    inertCalls += 1;
    throw new Error("disabled runtime touched the corpus");
  },
});
assert.equal(Object.isFrozen(inert.service), true);
assert.deepEqual(Object.keys(inert.service).sort(), ["capabilities", "deriveWorkspaceScopeToken", "health", "queryView", "ready", "restart", "searchBatch", "status", "verifyDshSearchCandidates"]);
assert.deepEqual(inert.service.status(), {
  enabled: false,
  phase: "disabled",
  ready: false,
  capabilityValidated: false,
  health: null,
  source: null,
  restarts: 0,
  consecutiveFailures: 0,
  activeClients: 0,
  lastError: null,
});
assert.equal(Object.isFrozen(inert.service.status()), true);
assert.equal(inert.service.ready(), false);
await assert.rejects(inert.service.health(), (error) => error.code === "disabled");
await assert.rejects(inert.service.searchBatch({}), (error) => error.code === "disabled");
await assert.rejects(inert.service.restart(), (error) => error.code === "disabled");
await inert.dispose();
assert.equal(inertCalls, 0, "disabled mode must not create a client/source/timer side effect");

let forbiddenViewSourceCalls = 0;
let viewExecuteCalls = 0;
const viewOnlyRuntime = createSessionIndexRuntime({
  sessionIndex: { enabled: true, socketPath: "/generated/runtime/view-only.sock" },
}, {
  async connectClient() {
    return {
      async execute(request) {
        viewExecuteCalls += 1;
        assert.equal(request.authority.kind, "workspace-token-set/v1");
        assert.equal(request.authority.scopeTokens.length, 1);
        assert.equal(JSON.stringify(request).includes("/generated/workspace"), false);
        return {
          type: "execute", version: "qq-index-view-response/v1", view: request.view,
          buildId: "conversation-v1-physical-1", access: request.access,
          snapshot: { generation: "3", sourceFence: "fence-3", lagMs: "0" },
          result: {
            sessions: [{
              rank: 1, sessionId: "view-session", score: 0.1, matchingLiteralOrdinals: [0],
              title: "View title", sessionUpdatedAtUnixMs: 2_000,
              evidence: { rowKey: "view-session:0", seq: "0", eventTimeUnixMs: 1_000,
                eventType: "message/generated", surface: "current" },
            }], truncated: false,
          },
          telemetry: { operation: "execute", outcome: "ok", elapsedMicros: "9",
            phasesMicros: { indexedPlan: "7" }, counts: { results: "1" } },
        };
      },
      async close() {},
    };
  },
  createSource() {
    forbiddenViewSourceCalls += 1;
    throw new Error("view query touched DSH source");
  },
});
assert.equal(viewOnlyRuntime.service.capabilities().length, 2);
assert.equal(Object.isFrozen(viewOnlyRuntime.service.capabilities()), true);
const viewOnlyResult = await viewOnlyRuntime.service.queryView({
  version: "qq-index-query/v1",
  view: { id: "qq.session.conversation", version: 1 },
  access: "literal-session-search",
  params: { literals: ["generated literal"], limit: 5 },
  authority: { kind: "workspace-set/v1", workspaceIds: ["/generated/workspace"] },
  freshness: { mode: "caught-up", maxLagMs: 1_000 },
});
assert.equal(viewOnlyResult.result.sessions[0].sessionId, "view-session");
assert.equal(viewExecuteCalls, 1);
assert.equal(forbiddenViewSourceCalls, 0, "queryView must perform zero DSH/source calls");
assert.equal(viewOnlyRuntime.service.status().phase, "waiting-session-query");
await viewOnlyRuntime.dispose();

const state = {
  daemonUp: true,
  daemonEpoch: 1,
  connectCalls: [],
  operationCalls: [],
  opened: 0,
  closed: 0,
  sourcesCreated: 0,
  sourcesClosed: 0,
  subscriptions: 0,
  unsubscriptions: 0,
  listCalls: 0,
  activeSearches: 0,
  maximumSearches: 0,
  searchBarrier: null,
  healthBarrier: null,
  currentSource: null,
};

function healthResponse() {
  return {
    type: "health",
    version: "health-response-v1",
    generation: String(state.daemonEpoch),
    sourceWatermark: "7",
    capabilities: {
      readerCount: 4,
      queueCapacity: 64,
      readerRetirements: 0,
      activeReaders: state.activeSearches,
      peakActiveReaders: state.maximumSearches,
    },
  };
}

async function connectClient(options) {
  state.connectCalls.push(options);
  if (!state.daemonUp) throw coded("socket_error", "generated /private/socket query-session-secret");
  state.opened += 1;
  const epoch = state.daemonEpoch;
  let closed = false;
  return {
    async health(operation = {}) {
      state.operationCalls.push({ kind: "health", operation });
      await state.healthBarrier?.promise;
      if (!state.daemonUp || epoch !== state.daemonEpoch) {
        throw coded("socket_closed", "old generated socket /private/session-index.sock");
      }
      return healthResponse();
    },
    async searchBatch(request, operation = {}) {
      state.operationCalls.push({ kind: "search", request, operation });
      if (!state.daemonUp || epoch !== state.daemonEpoch) throw coded("socket_closed", "stale daemon");
      state.activeSearches += 1;
      state.maximumSearches = Math.max(state.maximumSearches, state.activeSearches);
      try {
        await state.searchBarrier?.promise;
        return { requestMarker: request.marker, epoch };
      } finally {
        state.activeSearches -= 1;
      }
    },
    async sourceState() {
      return { sourceWatermark: "7", sessions: [] };
    },
    async applyBatch() {
      return { sourceWatermark: "7" };
    },
    async close() {
      if (closed) return;
      closed = true;
      state.closed += 1;
    },
  };
}

function createSource(options) {
  state.sourcesCreated += 1;
  let phase = "idle";
  let writer;
  let unsubscribe;
  const source = {
    status() {
      return {
        phase,
        sessionsScanned: phase === "live" ? 1 : 0,
        eventsCommitted: 2,
        documentsCommitted: 2,
        bufferedSessions: 0,
        watermark: "7",
        lastError: phase === "error"
          ? { name: "GeneratedCorpusError", code: "generated_source_failed" }
          : null,
        forbiddenSessionId: "query-session-secret",
        forbiddenPath: "/generated/corpus/path",
      };
    },
    async start() {
      phase = "subscribing";
      writer = await options.clientFactory();
      unsubscribe = await options.subscribe(() => {});
      assert.equal(state.subscriptions > 0, true, "subscription must precede list fence");
      phase = "listing";
      await options.sessionQuery.listSessions(new AbortController().signal);
      phase = "live";
      return source.status();
    },
    async health(operation) {
      if (phase !== "live") throw coded("source_error", "generated corpus failure query-session-secret");
      return writer.health(operation);
    },
    fail() {
      phase = "error";
    },
    async close() {
      if (phase === "closed") return;
      phase = "closed";
      state.sourcesClosed += 1;
      await unsubscribe?.();
      await writer?.close();
    },
  };
  state.currentSource = source;
  return source;
}

const listeners = new Map();
const lifecycle = {
  on(topic, listener) {
    const topicListeners = listeners.get(topic) ?? new Set();
    topicListeners.add(listener);
    listeners.set(topic, topicListeners);
    state.subscriptions += 1;
    return () => {
      if (topicListeners.delete(listener)) {
        state.unsubscriptions += 1;
        state.subscriptions -= 1;
      }
    };
  },
};
const sessionQuery = {
  async listSessions(signal) {
    assert.equal(signal.aborted, false);
    assert.equal(state.subscriptions, 3, "all three live listeners must exist before listSessions");
    state.listCalls += 1;
    return [{ header: { version: 1, id: "generated-session", createdAt: 1, cwd: "/generated/cwd" } }];
  },
  async readSession() {
    throw new Error("generated source does not need a read in this runtime unit test");
  },
};

const supervisionTimers = new Set();
let maximumSupervisionTimers = 0;
function trackedSetTimeout(callback, milliseconds) {
  let handle;
  handle = setTimeout(() => {
    supervisionTimers.delete(handle);
    callback();
  }, milliseconds);
  supervisionTimers.add(handle);
  maximumSupervisionTimers = Math.max(maximumSupervisionTimers, supervisionTimers.size);
  return handle;
}
function trackedClearTimeout(handle) {
  supervisionTimers.delete(handle);
  clearTimeout(handle);
}

const runtime = createSessionIndexRuntime({
  sessionIndex: {
    enabled: true,
    socketPath: "/generated/runtime/session-index.sock",
    connectTimeoutMs: 100,
    requestTimeoutMs: 200,
    monitorIntervalMs: 100,
    restartInitialBackoffMs: 20,
    restartMaxBackoffMs: 40,
  },
}, {
  connectClient,
  createSource,
  setTimeout: trackedSetTimeout,
  clearTimeout: trackedClearTimeout,
});
const service = runtime.service;
assert.equal(Object.isFrozen(service), true);
assert.equal(service.ready(), false);
assert.equal(service.status().phase, "waiting-session-query");
await assert.rejects(service.health(), (error) => error.code === "session_query_unavailable");

const binding = runtime.bind(sessionQuery, lifecycle);
assert.notEqual(binding, null);
await waitFor(() => service.ready(), "initial source readiness");
assert.equal(service.status().phase, "live");
assert.equal(service.status().capabilityValidated, true);
assert.equal(service.status().source.phase, "live");
assert.equal(service.status().source.sessionsScanned, 1);
assert.equal(state.listCalls, 1);
assert.equal(state.subscriptions, 3);
assert.equal(JSON.stringify(service.status()).includes("query-session-secret"), false);
assert.equal(JSON.stringify(service.status()).includes("/generated/corpus/path"), false);
assert.equal(JSON.stringify(service.status()).includes("session-index.sock"), false);

// health() is a separate, always-closed client and returns validated daemon state.
const beforeHealthOpened = state.opened;
const publicHealth = await service.health({ timeoutMs: 77 });
assert.equal(publicHealth.generation, "1");
assert.equal(Object.isFrozen(publicHealth), true);
assert.equal(state.opened, beforeHealthOpened + 1);
assert.equal(state.opened, state.closed + 1, "only the dedicated writer remains open");

// Each search gets its own connection, so two authorized callers can overlap
// while the source remains live on its independent writer connection.
state.searchBarrier = deferred();
const controller = new AbortController();
const deadlineUnixMs = Date.now() + 5_000;
const first = service.searchBatch({ marker: "first" }, {
  timeoutMs: 111,
  deadlineUnixMs,
  signal: controller.signal,
});
const second = service.searchBatch({ marker: "second" }, { timeoutMs: 112 });
await waitFor(() => state.activeSearches === 2, "overlapping short-lived searches");
assert.equal(service.ready(), true, "source must remain live while searches overlap");
assert.equal(service.status().activeClients, 2);
assert.equal(state.maximumSearches, 2);
state.searchBarrier.resolve();
assert.deepEqual(await Promise.all([first, second]), [
  { requestMarker: "first", epoch: 1 },
  { requestMarker: "second", epoch: 1 },
]);
state.searchBarrier = null;
assert.equal(service.status().activeClients, 0);
assert.equal(state.opened, state.closed + 1);
const forwarded = state.operationCalls.find(({ kind, request }) => kind === "search" && request.marker === "first");
assert.equal(forwarded.operation.signal, controller.signal);
assert.equal(forwarded.operation.deadlineUnixMs, deadlineUnixMs);
assert.equal(forwarded.operation.timeoutMs, 111);
assert.equal(state.connectCalls.some((options) => options.signal === controller.signal), true);

// Explicit restarts serialize to one health/source attachment.
state.healthBarrier = deferred();
const sourcesBeforeRestart = state.sourcesCreated;
const restartA = service.restart();
const restartB = service.restart();
assert.equal(restartA, restartB, "concurrent restart callers must share one promise");
state.healthBarrier.resolve();
await restartA;
state.healthBarrier = null;
assert.equal(state.sourcesCreated, sourcesBeforeRestart + 1);
assert.equal(service.ready(), true);

// Replacing the injected service while an old restart is blocked must not lose
// the new generation's immediate attachment behind restart serialization.
state.healthBarrier = deferred();
const replacedRestart = service.restart();
await waitFor(() => !service.ready() && service.status().phase === "starting", "blocked replacement restart");
const replacementBinding = runtime.bind(sessionQuery, lifecycle);
assert.notEqual(replacementBinding, binding);
state.healthBarrier.resolve();
await assert.rejects(replacedRestart, (error) => error.code === "binding_replaced");
state.healthBarrier = null;
await waitFor(() => service.ready(), "replacement service generation readiness");
assert.equal(state.subscriptions, 3);

// A daemon replacement leaves the source writer on the old epoch. The monitor
// must detect that socket death, fail closed, and reattach without host restart.
const sourcesBeforeDaemonRestart = state.sourcesCreated;
state.daemonEpoch += 1;
await waitFor(() => !service.ready() && service.status().phase === "recovering", "daemon outage detection", 1_000);
await waitFor(() => service.ready(), "automatic daemon reattachment", 1_000);
assert.equal(state.sourcesCreated, sourcesBeforeDaemonRestart + 1);
assert.equal(service.status().health.generation, "2");

// A source-only failure is also detected and recovered automatically even while
// new daemon connections continue to work.
const sourcesBeforeSourceFailure = state.sourcesCreated;
state.currentSource.fail();
await waitFor(() => !service.ready(), "source failure detection", 1_000);
await assert.rejects(service.searchBatch({ marker: "closed" }), (error) => error.code === "not_ready");
await waitFor(() => service.ready(), "automatic source recovery", 1_000);
assert.equal(state.sourcesCreated, sourcesBeforeSourceFailure + 1);

// Redacted failures expose class/code only, never paths, ids, messages, or stacks.
state.daemonUp = false;
state.daemonEpoch += 1;
await waitFor(() => !service.ready(), "second daemon outage", 1_000);
await delay(25);
const degraded = JSON.stringify(service.status());
assert.match(degraded, /socket_(?:closed|error)/u);
assert.equal(degraded.includes("query-session-secret"), false);
assert.equal(degraded.includes("/private/"), false);
assert.equal(degraded.includes("generated corpus failure"), false);
state.daemonUp = true;
await service.restart();

const callsBeforeDispose = state.connectCalls.length;
await runtime.dispose();
assert.equal(service.ready(), false);
assert.equal(service.status().phase, "disposed");
assert.equal(service.status().activeClients, 0);
assert.equal(state.subscriptions, 0);
assert.equal(state.unsubscriptions % 3, 0);
assert.equal(state.opened, state.closed);
assert.ok(maximumSupervisionTimers <= 1, `runtime owned ${maximumSupervisionTimers} supervision timers`);
assert.equal(supervisionTimers.size, 0);
await delay(150);
assert.equal(state.connectCalls.length, callsBeforeDispose, "dispose must cancel the monitor timer");
assert.equal(supervisionTimers.size, 0);
await assert.rejects(service.restart(), (error) => error.code === "disposing");

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, description, timeoutMs = 750) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail(`${description} timed out: ${JSON.stringify(service.status())}`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

console.log("session-index runtime: ok");
