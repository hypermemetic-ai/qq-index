import assert from "node:assert/strict";
import { createConversationViewShadowAdapter } from "@hypermemetic-ai/qq-index/session-index-shadow-adapter";

const observations = [];
let clock = 10;
const oracleResult = { verifiedCandidates: [{ sessionId: "a" }, { sessionId: "b" }], secret: "oracle content" };
const adapter = createConversationViewShadowAdapter({
  viewService: {
    async queryView() { return { result: { sessions: [{ sessionId: "a" }, { sessionId: "b" }] } }; },
  },
  async referenceOracle() { return oracleResult; },
  observe(record) { observations.push(record); },
  now() { clock += 2; return clock; },
});
const matched = await adapter.run({ viewRequest: { secret: "literal" }, oracleRequest: { secret: "literal" } });
assert.equal(matched.oracleResult, oracleResult, "legacy oracle remains the returned authority");
assert.deepEqual(matched.shadow, {
  operation: "conversation-view-shadow", outcome: "parity", elapsedMs: 2,
  oracleCount: 2, viewCount: 2, parity: true, viewStatus: "ok",
});
assert.equal(Object.isFrozen(matched), true);
assert.equal(JSON.stringify(observations).includes("literal"), false);
assert.equal(JSON.stringify(observations).includes("oracle content"), false);
assert.equal(JSON.stringify(observations).includes('"a"'), false);

const viewFailure = new Error("generated view document content");
viewFailure.code = "view_building";
const failing = createConversationViewShadowAdapter({
  viewService: { async queryView() { throw viewFailure; } },
  async referenceOracle() { return oracleResult; },
});
const retained = await failing.run({ viewRequest: {}, oracleRequest: {} });
assert.equal(retained.oracleResult, oracleResult);
assert.equal(retained.shadow.outcome, "view-error");
assert.equal(retained.shadow.viewStatus, "view_building");

const oracleFailure = new Error("oracle failed");
const unavailable = createConversationViewShadowAdapter({
  viewService: { async queryView() { return { result: { sessions: [] } }; } },
  async referenceOracle() { throw oracleFailure; },
});
await assert.rejects(unavailable.run({ viewRequest: {}, oracleRequest: {} }), (error) => error === oracleFailure);

console.log("conversation view shadow adapter: ok");
