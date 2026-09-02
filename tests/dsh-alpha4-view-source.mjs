import assert from "node:assert/strict";

import { createDshAlpha4ViewSource } from "@hypermemetic-ai/qq-index/dsh-alpha4-view-source";

const view = { id: "qq.session.conversation", version: 1 };
const calls = [];
const observed = [];
const disposed = [];
const states = new Map([
  ["unchanged", {
    partitionKey: "unchanged", sourceIdentity: "source-unchanged",
    durableRevision: "revision-unchanged", nextCursor: "1", generation: "1",
  }],
]);
let listener;
let clock = 1_000;

const client = {
  async viewPartitionState({ partitionKeys }) {
    calls.push({ kind: "state", partitionKeys });
    return { partitions: partitionKeys.flatMap((key) => states.has(key) ? [states.get(key)] : []) };
  },
  async mutateView(mutation) {
    calls.push({ kind: "mutation", mutation });
    if (mutation.kind === "replacePartition") {
      states.set(mutation.partitionKey, {
        partitionKey: mutation.partitionKey,
        sourceIdentity: mutation.source.sourceIdentity,
        durableRevision: mutation.source.durableRevision,
        nextCursor: mutation.source.nextCursor,
        generation: "2",
      });
    } else if (mutation.kind === "deletePartition") {
      states.delete(mutation.partitionKey);
    }
    return {};
  },
  async setViewLifecycle(request) {
    calls.push({ kind: "lifecycle", request });
    return {};
  },
};

const sessionQuery = {
  async listSessions() { throw new Error("custom revision listing should be used"); },
  async observeSession(sessionId, options) {
    assert.equal(options.projectionMode, "all");
    observed.push(sessionId);
    return {
      source: "prepared",
      header: { id: sessionId },
      events: [{ type: "generated" }],
      inheritedEventCount: 0,
      cursor: 0,
      revision: `revision-${sessionId}`,
      [Symbol.dispose]() { disposed.push(sessionId); },
    };
  },
};

const source = createDshAlpha4ViewSource({
  sessionQuery,
  async subscribe(receive) {
    calls.push({ kind: "subscribe" });
    listener = receive;
    return () => calls.push({ kind: "unsubscribe" });
  },
  async listSourceRecords() {
    calls.push({ kind: "list" });
    // This change occurs after subscription and before the backfill list fence.
    listener({ sessionId: "buffered", source: { id: "buffered" } });
    return [
      {
        sessionId: "unchanged",
        record: { header: { id: "unchanged" } },
        durableRevision: "revision-unchanged",
        nextCursor: "1",
      },
      { sessionId: "changed", record: { header: { id: "changed" } } },
    ];
  },
  client,
  view,
  sourceIdentity(value) { return `source-${value.header?.id ?? value.id}`; },
  async projectObservation(observation) {
    return {
      rows: [{ generated: observation.header.id }],
      // Prepared observations can use their stock alpha.4 durable revision.
    };
  },
  now() { clock += 1; return clock; },
});

const ready = await source.start();
assert.equal(ready.phase, "live");
assert.equal(calls[0].kind, "subscribe");
assert.equal(calls[1].kind, "list");
assert.deepEqual(observed.sort(), ["buffered", "changed"]);
assert.equal(observed.includes("unchanged"), false, "matching durable revision/cursor must skip observation");
assert.deepEqual(disposed.sort(), ["buffered", "changed"]);
assert.equal(ready.recordsListed, 2);
assert.equal(ready.partitionsSkipped, 1);
assert.equal(ready.partitionsObserved, 2);
assert.equal(ready.partitionsCommitted, 2);
assert.equal(calls.at(-1).kind, "lifecycle");
assert.equal(calls.at(-1).request.state, "ready");
assert.equal(Object.isFrozen(ready), true);
const timingText = JSON.stringify(ready.timings);
assert.equal(timingText.includes("source-changed"), false);
assert.equal(timingText.includes("buffered"), false);
assert.equal(timingText.includes("generated"), false);
assert.match(timingText, /startup-reconciliation/u);

listener({ kind: "delete", sessionId: "changed" });
await waitFor(() => source.status().partitionsDeleted === 1, "live partition delete");
assert.equal(states.has("changed"), false);
await source.close();
assert.equal(source.status().phase, "disposed");
assert.equal(calls.some(({ kind }) => kind === "unsubscribe"), true);

// Changes delivered while ready activation is awaited must cross the live handoff.
let handoffListener;
let lifecycleEntered = false;
let releaseLifecycle;
const lifecycleGate = new Promise((resolve) => { releaseLifecycle = resolve; });
const handoffObserved = [];
const handoffMutations = [];
const handoffStates = new Map([
  ["during-ready-delete", {
    partitionKey: "during-ready-delete",
    sourceIdentity: "source-during-ready-delete",
    durableRevision: "revision-during-ready-delete",
    nextCursor: "1",
    generation: "1",
  }],
]);
const handoffSource = createDshAlpha4ViewSource({
  sessionQuery: {
    async listSessions() { return []; },
    async observeSession(sessionId) {
      handoffObserved.push(sessionId);
      return {
        source: "prepared",
        header: { id: sessionId },
        events: [{ type: "generated" }],
        inheritedEventCount: 0,
        cursor: 0,
        revision: `revision-${sessionId}`,
        [Symbol.dispose]() {},
      };
    },
  },
  async subscribe(receive) { handoffListener = receive; return () => {}; },
  async listSourceRecords() { return []; },
  client: {
    async viewPartitionState({ partitionKeys }) {
      return { partitions: partitionKeys.flatMap((key) => handoffStates.has(key) ? [handoffStates.get(key)] : []) };
    },
    async mutateView(mutation) {
      handoffMutations.push(mutation);
    },
    async setViewLifecycle(request) {
      if (request.state === "ready") {
        lifecycleEntered = true;
        await lifecycleGate;
      }
    },
  },
  view,
  sourceIdentity(value) { return `source-${value.header?.id ?? value.id}`; },
  async projectObservation(observation) { return { rows: [{ generated: observation.header.id }] }; },
});
const handoffStart = handoffSource.start();
await waitFor(() => lifecycleEntered, "ready lifecycle entry");
handoffListener({ sessionId: "during-ready-upsert", source: { id: "during-ready-upsert" } });
handoffListener({ kind: "delete", sessionId: "during-ready-delete" });
assert.equal(handoffSource.status().phase, "catching-up");
assert.equal(handoffSource.status().bufferedPartitions, 2);
releaseLifecycle();
assert.equal((await handoffStart).phase, "live");
await waitFor(
  () => handoffSource.status().partitionsCommitted === 1 && handoffSource.status().partitionsDeleted === 1,
  "ready handoff reconciliation",
);
assert.deepEqual(handoffObserved, ["during-ready-upsert"]);
assert.deepEqual(handoffMutations.map(({ kind }) => kind), ["replacePartition", "deletePartition"]);
assert.equal(handoffSource.status().bufferedPartitions, 0);
await handoffSource.close();

// Intentional close during startup must not poison a previously committed view.
const startupCloseLifecycle = [];
let startupCloseEntered;
const startupCloseGate = new Promise((resolve) => { startupCloseEntered = resolve; });
const startupCloseClient = intactViewClient(startupCloseLifecycle);
const startupCloseSource = createDshAlpha4ViewSource({
  sessionQuery: unusedSessionQuery(),
  async subscribe() { return () => {}; },
  async listSourceRecords(signal) {
    startupCloseEntered();
    await rejectOnAbort(signal);
    assert.fail("aborted startup listing unexpectedly resumed");
  },
  client: startupCloseClient,
  view,
  sourceIdentity(value) { return `source-${value.header?.id ?? value.id}`; },
  async projectObservation() { assert.fail("startup close must not project"); },
});
const interruptedStart = startupCloseSource.start();
await startupCloseGate;
await startupCloseSource.close();
await assert.rejects(interruptedStart, (error) => error?.code === "source_disposed");
assert.equal(startupCloseSource.status().phase, "disposed");
assert.deepEqual(startupCloseLifecycle, [], "startup close must not mark an intact view failed");
assert.deepEqual(startupCloseClient.queryCommitted("kept"), { value: "committed-before-close" });

// Intentional close during live projection must dispose the lease without poisoning the view.
const liveCloseLifecycle = [];
let liveCloseListener;
let liveProjectionEntered;
const liveProjectionGate = new Promise((resolve) => { liveProjectionEntered = resolve; });
let liveObservationDisposals = 0;
const liveCloseClient = intactViewClient(liveCloseLifecycle);
const liveCloseSource = createDshAlpha4ViewSource({
  sessionQuery: {
    async listSessions() { return []; },
    async observeSession(sessionId) {
      return observationFor(sessionId, () => { liveObservationDisposals += 1; });
    },
  },
  async subscribe(receive) { liveCloseListener = receive; return () => {}; },
  async listSourceRecords() { return []; },
  client: liveCloseClient,
  view,
  sourceIdentity(value) { return `source-${value.header?.id ?? value.id}`; },
  async projectObservation(_observation, { signal }) {
    liveProjectionEntered();
    await rejectOnAbort(signal);
    assert.fail("aborted live projection unexpectedly resumed");
  },
});
await liveCloseSource.start();
liveCloseListener({ sessionId: "closing-live", source: { id: "closing-live" } });
await liveProjectionGate;
await liveCloseSource.close();
assert.equal(liveCloseSource.status().phase, "disposed");
assert.equal(liveObservationDisposals, 1, "close must dispose the in-flight alpha.4 observation lease");
assert.deepEqual(liveCloseLifecycle.map(({ state }) => state), ["ready"], "live close must not mark an intact view failed");
assert.deepEqual(liveCloseClient.queryCommitted("kept"), { value: "committed-before-close" });

// A genuine live reconciliation error must still fail closed.
const liveFailureLifecycle = [];
let liveFailureListener;
let liveFailureEntered;
let releaseLiveFailure;
const liveFailureEnteredGate = new Promise((resolve) => { liveFailureEntered = resolve; });
const liveFailureReleaseGate = new Promise((resolve) => { releaseLiveFailure = resolve; });
const liveFailureClient = intactViewClient(liveFailureLifecycle, {
  async onFailed() {
    liveFailureEntered();
    await liveFailureReleaseGate;
  },
});
const liveFailureSource = createDshAlpha4ViewSource({
  sessionQuery: {
    async listSessions() { return []; },
    async observeSession(sessionId) { return observationFor(sessionId); },
  },
  async subscribe(receive) { liveFailureListener = receive; return () => {}; },
  async listSourceRecords() { return []; },
  client: liveFailureClient,
  view,
  sourceIdentity(value) { return `source-${value.header?.id ?? value.id}`; },
  async projectObservation() { throw new Error("generated live projection failure"); },
});
await liveFailureSource.start();
liveFailureListener({ sessionId: "failing-live", source: { id: "failing-live" } });
await liveFailureEnteredGate;
assert.equal(liveFailureSource.status().phase, "failed");
assert.deepEqual(liveFailureLifecycle.map(({ state }) => state), ["ready", "failed"]);
assert.throws(() => liveFailureClient.queryCommitted("kept"), /view is failed/u);
const closeFailedSource = liveFailureSource.close();
releaseLiveFailure();
await closeFailedSource;

// A malformed observation fails closed, marks the view failed, and never activates.
const failureCalls = [];
let failureListener;
const failedSource = createDshAlpha4ViewSource({
  sessionQuery: {
    async listSessions() { return []; },
    async observeSession() {
      return {
        source: "prepared", header: { id: "bad" }, events: [], cursor: 0,
        revision: "revision-bad", [Symbol.dispose]() {},
      };
    },
  },
  async subscribe(receive) { failureListener = receive; return () => {}; },
  async listSourceRecords() { return [{ sessionId: "bad", record: { header: { id: "bad" } } }]; },
  client: {
    async viewPartitionState() { return { partitions: [] }; },
    async mutateView() { failureCalls.push("mutate"); },
    async setViewLifecycle(request) { failureCalls.push(request.state); },
  },
  view,
  sourceIdentity() { return "source-bad"; },
  async projectObservation() { return { rows: [], durableRevision: "revision-bad" }; },
});
assert.equal(typeof failureListener, "undefined");
await assert.rejects(failedSource.start(), /cursor\/events/u);
assert.equal(failedSource.status().phase, "failed");
assert.deepEqual(failureCalls, ["failed"]);
assert.equal(failureCalls.includes("ready"), false);
await failedSource.close();

function observationFor(sessionId, dispose = () => {}) {
  return {
    source: "prepared",
    header: { id: sessionId },
    events: [{ type: "generated" }],
    inheritedEventCount: 0,
    cursor: 0,
    revision: `revision-${sessionId}`,
    [Symbol.dispose]: dispose,
  };
}

function unusedSessionQuery() {
  return {
    async listSessions() { return []; },
    async observeSession() { assert.fail("observeSession must not be called"); },
  };
}

function intactViewClient(lifecycleCalls, { onFailed = async () => {} } = {}) {
  let lifecycleState = "ready";
  const committed = new Map([["kept", { value: "committed-before-close" }]]);
  return {
    async viewPartitionState() { return { partitions: [] }; },
    async mutateView() { assert.fail("close regression must not mutate committed rows"); },
    async setViewLifecycle(request) {
      lifecycleCalls.push(request);
      lifecycleState = request.state;
      if (request.state === "failed") await onFailed();
    },
    queryCommitted(rowKey) {
      if (lifecycleState === "failed") throw new Error("view is failed");
      return committed.get(rowKey);
    },
  };
}

function rejectOnAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`${description} timed out`);
}

console.log("alpha.4 compiled-view source: ok");
