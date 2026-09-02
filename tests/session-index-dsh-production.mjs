import assert from "node:assert/strict";

import {
  buildSessionEventRecords,
  buildSessionEventSearchDocuments,
  extractSessionEventText,
} from "@deepseek-ai/dsh-session-query";
import {
  createDshSessionIndexSource,
  projectDshSessionLog,
  verifyDshSearchCandidates,
} from "@hypermemetic-ai/qq-index/session-index-dsh-source";

const helpers = {
  buildSessionEventRecords,
  buildSessionEventSearchDocuments,
  extractSessionEventText,
};
const scopedId = "generated-production-scoped";
const unscopedId = "generated-production-unscoped";
const scoped = {
  session: { version: 1, id: scopedId, createdAt: 1, cwd: "/generated/production/workspace" },
  events: [
    raw(0, "user/message", "generated production amber"),
    raw(1, "turn/start"),
    raw(2, "assistant/message", "generated production blue"),
  ],
};
const unscoped = {
  session: { version: 1, id: unscopedId, createdAt: 2 },
  events: [raw(0, "user/message", "must remain unindexed")],
};

const first = await projectDshSessionLog({ sessionId: scopedId, sessionLog: scoped, projectionHelpers: helpers });
const second = await projectDshSessionLog({ sessionId: scopedId, sessionLog: scoped, projectionHelpers: helpers });
assert.deepEqual(first, second, "production fingerprints must be deterministic");
assert.deepEqual(first.map(({ seq, eventType, surface, body }) => [seq, eventType, surface, body]), [
  ["0", "user/message", "current", "generated production amber"],
  ["1", "turn/start", "log-only", ""],
  ["2", "assistant/message", "current", "generated production blue"],
]);
assert.deepEqual(await projectDshSessionLog({
  sessionId: unscopedId,
  sessionLog: unscoped,
  projectionHelpers: helpers,
}), []);
await assert.rejects(projectDshSessionLog({
  sessionId: scopedId,
  sessionLog: { ...scoped, events: [raw(1, "turn/start")] },
  projectionHelpers: helpers,
}), /contiguous/u);

const logs = new Map([[scopedId, scoped], [unscopedId, unscoped]]);
const listeners = new Set();
const durable = new Map();
const batches = [];
let watermark = 0;
let subscribedBeforeList = false;
const sessionQuery = {
  async listSessions(signal) {
    assert.equal(signal.aborted, false);
    subscribedBeforeList = listeners.size > 0;
    return [...logs.values()].map(({ session }) => ({
      header: structuredClone(session),
      live: true,
      persisted: false,
    }));
  },
  async readSession(sessionId) {
    return structuredClone(logs.get(sessionId));
  },
};
const client = {
  async sourceState({ sessionIds }) {
    return {
      sourceWatermark: String(watermark),
      sessions: sessionIds.flatMap((sessionId) => durable.has(sessionId)
        ? [{ sessionId, nextSeq: String(durable.get(sessionId).nextSeq), workspaceId: durable.get(sessionId).workspaceId }]
        : []),
    };
  },
  async applyBatch(batch) {
    batches.push(structuredClone(batch));
    for (const document of batch.documents) {
      const current = durable.get(document.sessionId) ?? { nextSeq: 0, workspaceId: document.workspaceId };
      assert.equal(Number(document.seq), current.nextSeq);
      current.nextSeq += 1;
      durable.set(document.sessionId, current);
    }
    watermark = Number(batch.sourceWatermark);
    return {
      sourceWatermark: String(watermark),
      generation: String(watermark),
      insertedDocuments: batch.documents.length,
      replayedDocuments: 0,
      batchReplayed: false,
    };
  },
};
const source = createDshSessionIndexSource({
  sessionQuery,
  projectionHelpers: helpers,
  client,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  maxBatchDocuments: 2,
});
await source.start();
assert.equal(subscribedBeforeList, true);
assert.equal(source.status().phase, "live");
assert.equal(source.status().sessionsScanned, 2);
assert.equal(durable.get(scopedId).nextSeq, 3);
assert.equal(durable.has(unscopedId), false, "unscoped production session must have no durable cursor/documents");
assert.equal(batches.flatMap(({ documents }) => documents).length, 3);

logs.get(scopedId).events.push(raw(3, "user/message", "generated live production green"));
for (const listener of [...listeners]) listener("session/event", { id: scopedId });
await waitFor(() => durable.get(scopedId).nextSeq === 4, "production live append");
assert.deepEqual(batches.at(-1).documents.map(({ seq }) => seq), ["3"]);
await source.close();
assert.equal(listeners.size, 0);
assert.equal(source.status().phase, "closed");

const documents = new Map([
  ["good:0", { sessionId: "good", seq: 0, type: "user/message", time: 1, surface: "current", text: "exact production literal" }],
  ["wrong-type:0", { sessionId: "wrong-type", seq: 0, type: "tool/result", time: 1, surface: "current", text: "exact production literal" }],
  ["wrong-surface:0", { sessionId: "wrong-surface", seq: 0, type: "user/message", time: 1, surface: "shadowed", text: "exact production literal" }],
  ["stale-text:0", { sessionId: "stale-text", seq: 0, type: "user/message", time: 1, surface: "current", text: "changed source text" }],
]);
let active = 0;
let peak = 0;
const verification = await verifyDshSearchCandidates({
  searchResponse: {
    sources: [{
      queryOrdinal: 0,
      ranked: ["good", "wrong-type", "wrong-surface", "stale-text", "missing"].map((sessionId, index) => ({
        rank: index + 1,
        sessionId,
        evidence: {
          sessionId,
          seq: "0",
          eventType: "user/message",
          surface: "current",
          documentKey: `generated:${sessionId}:0`,
        },
      })),
    }],
    fused: ["good", "wrong-type", "wrong-surface", "stale-text", "missing"].map((sessionId, index) => ({
      rank: index + 1,
      sessionId,
      rrfScore: 0.1,
      contributions: [{
        queryOrdinal: 0,
        sourceRank: index + 1,
        contribution: 0.1,
        documentKey: `generated:${sessionId}:0`,
        seq: "0",
        snippet: null,
      }],
    })),
  },
  sessionQuery: {
    async filterEvents(sessionId, filters) {
      assert.deepEqual(filters, [{ kind: "seq", from: 0, to: 0 }]);
      active += 1;
      peak = Math.max(peak, active);
      try {
        await delay(5);
        return documents.has(`${sessionId}:0`) ? [documents.get(`${sessionId}:0`)] : [];
      } finally {
        active -= 1;
      }
    },
    async readEvent() {
      assert.fail("production exact verification must prefer filterEvents");
    },
  },
  literals: ["exact production literal"],
  eventTypeAllowList: ["user/message"],
  surfaceAllowList: ["current"],
  maxConcurrency: 2,
});
assert.deepEqual(verification.verifiedCandidates.map(({ sessionId }) => sessionId), ["good"]);
assert.equal(verification.verifiedEvidence.length, 1);
assert.ok(peak > 1 && peak <= 2);

function raw(seq, type, text) {
  const base = { seq, time: 1_700_000_000_000 + seq, type };
  if (type === "turn/start") return { ...base, data: { turn: 0 } };
  if (type === "user/message") {
    return {
      ...base,
      surfaceOp: "append",
      data: { role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
    };
  }
  return {
    ...base,
    surfaceOp: "append",
    data: {
      turn: 0,
      step: 0,
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  };
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(`${description} timed out`);
}
function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

console.log("session-index DSH production shapes: ok");
