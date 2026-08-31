import assert from "node:assert/strict";

import {
  deriveWorkspaceScopeToken,
  verifyDshSearchCandidates,
} from "@hypermemetic-ai/qq-index/session-index-dsh-source";
import { createSessionIndexRuntime } from "@hypermemetic-ai/qq-index/session-index-runtime";

const runtime = createSessionIndexRuntime();
const service = runtime.service;
assert.equal(Object.isFrozen(service), true);
assert.deepEqual(Object.keys(service).sort(), [
  "deriveWorkspaceScopeToken",
  "health",
  "ready",
  "restart",
  "searchBatch",
  "status",
  "verifyDshSearchCandidates",
]);
assert.equal(service.deriveWorkspaceScopeToken, deriveWorkspaceScopeToken);
assert.equal(service.verifyDshSearchCandidates, verifyDshSearchCandidates);
assert.equal(
  service.deriveWorkspaceScopeToken("/generated/canonical/workspace"),
  deriveWorkspaceScopeToken("/generated/canonical/workspace"),
);
assert.equal(service.status().phase, "disabled");
await assert.rejects(service.searchBatch({}), (error) => error.code === "disabled");

const canonicalResponse = responseFor(["good", "failed"]);
const canonicalReads = new Map([
  ["good:0", document("good", "canonical literal")],
]);
const direct = await verifyDshSearchCandidates({
  ...verificationOptions(canonicalResponse),
  sessionQuery: queryFor(canonicalReads, { fail: new Set(["failed:0"]) }),
});
const delegated = await service.verifyDshSearchCandidates({
  ...verificationOptions(canonicalResponse),
  sessionQuery: queryFor(canonicalReads, { fail: new Set(["failed:0"]) }),
});
assert.deepEqual(delegated, direct, "service verification must be the canonical exported verifier");
assert.deepEqual(delegated.verifiedCandidates.map(({ sessionId }) => sessionId), ["good"]);
assert.equal(Object.isFrozen(delegated), true);
assert.equal(Object.isFrozen(delegated.verifiedCandidates), true);
assert.equal(Object.isFrozen(delegated.verifiedEvidence), true);

// rc.7 filterEvents has exactly two positional parameters and no cancellation
// control. The verifier must stop at its own bound once current reads settle.
const midAbortController = new AbortController();
const midAbortReason = new Error("generated mid-verification abort");
const midAbortResponse = responseFor(["mid-0", "mid-1", "mid-2", "mid-3", "mid-4"]);
const readsStarted = deferred();
const releaseReads = deferred();
let midReads = 0;
let midActive = 0;
let midPeak = 0;
const midVerification = service.verifyDshSearchCandidates({
  ...verificationOptions(midAbortResponse),
  signal: midAbortController.signal,
  maxConcurrency: 2,
  sessionQuery: {
    async filterEvents(...args) {
      assert.equal(args.length, 2, "filterEvents positional semantics must remain unchanged");
      const [sessionId, filters] = args;
      assert.deepEqual(filters, [{ kind: "seq", from: 0, to: 0 }]);
      midReads += 1;
      midActive += 1;
      midPeak = Math.max(midPeak, midActive);
      if (midReads === 2) readsStarted.resolve();
      try {
        await releaseReads.promise;
        return [document(sessionId, "canonical literal")];
      } finally {
        midActive -= 1;
      }
    },
  },
});
await readsStarted.promise;
midAbortController.abort(midAbortReason);
releaseReads.resolve();
await assert.rejects(midVerification, (error) => error === midAbortReason);
assert.equal(midReads, 2, "abort must stop exact-read fanout after in-flight bounded reads");
assert.equal(midPeak, 2);
assert.equal(midActive, 0, "unsupported reads must settle before cancellation rejects");

const preAbortController = new AbortController();
const preAbortReason = new Error("generated pre-abort");
preAbortController.abort(preAbortReason);
let preAbortReads = 0;
await assert.rejects(service.verifyDshSearchCandidates({
  ...verificationOptions(responseFor(["never-read"])),
  signal: preAbortController.signal,
  sessionQuery: {
    async filterEvents() {
      preAbortReads += 1;
      return [];
    },
  },
}), (error) => error === preAbortReason);
assert.equal(preAbortReads, 0);

for (const signal of [null, {}, { aborted: false }, {
  aborted: false,
  throwIfAborted() {},
  addEventListener() {},
}]) {
  let malformedReads = 0;
  await assert.rejects(service.verifyDshSearchCandidates({
    ...verificationOptions(responseFor(["never-read"])),
    signal,
    sessionQuery: {
      async filterEvents() {
        malformedReads += 1;
        return [];
      },
    },
  }), /signal must be an AbortSignal/u);
  assert.equal(malformedReads, 0, "malformed signals must reject before exact reads");
}

// rc.7 readEvent(request, signal?) supports cancellation as its second argument.
const readEventController = new AbortController();
let readEventCalls = 0;
const readEventResult = await service.verifyDshSearchCandidates({
  ...verificationOptions(responseFor(["read-event"])),
  signal: readEventController.signal,
  sessionQuery: {
    async readEvent(request, signal) {
      readEventCalls += 1;
      assert.deepEqual(request, {
        sessionId: "read-event",
        seq: 0,
        before: 0,
        after: 0,
      });
      assert.equal(signal, readEventController.signal);
      return { target: document("read-event", "canonical literal") };
    },
  },
});
assert.equal(readEventCalls, 1);
assert.deepEqual(readEventResult.verifiedCandidates.map(({ sessionId }) => sessionId), ["read-event"]);

const readAbort = new Error("generated DSH cancellation");
readAbort.name = "AbortError";
await assert.rejects(service.verifyDshSearchCandidates({
  ...verificationOptions(responseFor(["dsh-abort"])),
  sessionQuery: {
    async filterEvents() {
      throw readAbort;
    },
  },
}), (error) => error === readAbort);

// Ordinary source failures remain fail-closed, while candidate reads remain
// deduplicated, capped, and constrained by maxConcurrency.
const boundedIds = Array.from({ length: 20 }, (_, index) => `bounded-${index}`);
const boundedResponse = responseFor(boundedIds, { duplicateFirst: true });
let boundedReads = 0;
let boundedActive = 0;
let boundedPeak = 0;
const bounded = await service.verifyDshSearchCandidates({
  ...verificationOptions(boundedResponse),
  maxCandidates: 7,
  maxConcurrency: 3,
  sessionQuery: {
    async filterEvents() {
      boundedReads += 1;
      boundedActive += 1;
      boundedPeak = Math.max(boundedPeak, boundedActive);
      try {
        await delay(2);
        throw new Error("generated ordinary exact-read failure");
      } finally {
        boundedActive -= 1;
      }
    },
  },
});
assert.deepEqual(bounded, { verifiedCandidates: [], verifiedEvidence: [] });
assert.equal(boundedReads, 6, "seven pointers including one duplicate must perform six reads");
assert.ok(boundedPeak > 1 && boundedPeak <= 3, `observed exact-read concurrency ${boundedPeak}`);

await runtime.dispose();
console.log("session-index canonical capabilities: ok");

function verificationOptions(searchResponse) {
  return {
    searchResponse,
    literals: ["canonical literal"],
    eventTypeAllowList: ["user/message"],
    surfaceAllowList: ["current"],
    maxConcurrency: 2,
    maxCandidates: 256,
  };
}

function responseFor(sessionIds, { duplicateFirst = false } = {}) {
  const ranked = sessionIds.map((sessionId) => ({
    sessionId,
    evidence: pointer(sessionId),
  }));
  if (duplicateFirst && ranked.length > 0) ranked.splice(1, 0, structuredClone(ranked[0]));
  return {
    sources: [{ queryOrdinal: 0, ranked }],
    fused: sessionIds.slice(0, 100).map((sessionId) => ({
      rank: 1,
      sessionId,
      rrfScore: 0.1,
      contributions: [],
    })),
  };
}

function pointer(sessionId) {
  return {
    sessionId,
    seq: "0",
    eventType: "user/message",
    surface: "current",
    documentKey: `generated:${sessionId}:0`,
  };
}

function document(sessionId, text) {
  return {
    sessionId,
    seq: 0,
    type: "user/message",
    time: 1,
    surface: "current",
    text,
  };
}

function queryFor(documents, { fail = new Set() } = {}) {
  return {
    async filterEvents(sessionId, filters) {
      assert.deepEqual(filters, [{ kind: "seq", from: 0, to: 0 }]);
      const key = `${sessionId}:0`;
      if (fail.has(key)) throw new Error("generated source unavailable");
      return documents.has(key) ? [documents.get(key)] : [];
    },
  };
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

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
