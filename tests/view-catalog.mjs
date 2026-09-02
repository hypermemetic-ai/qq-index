import assert from "node:assert/strict";

import { compiledViewCapabilities, compiledViewRegistry } from "@hypermemetic-ai/qq-index/views/catalog";
import { VIEW_MODULE_ABI_VERSION, defineViewModuleV1 } from "@hypermemetic-ai/qq-index/views/registry";
import { deriveWorkspaceScopeToken } from "@hypermemetic-ai/qq-index/session-index-dsh-source";

assert.equal(Object.isFrozen(compiledViewCapabilities), true);
assert.deepEqual(compiledViewCapabilities.map(({ id, version, testOnly }) => ({ id, version, testOnly })), [
  { id: "qq.session.conversation", version: 1, testOnly: false },
  { id: "qq.test.exact-range", version: 1, testOnly: true },
]);
assert.equal(Object.isFrozen(compiledViewCapabilities[0]), true);
assert.throws(() => { compiledViewCapabilities[0].id = "changed"; }, TypeError);
assert.throws(() => defineViewModuleV1({
  abiVersion: VIEW_MODULE_ABI_VERSION,
  manifest: { ...structuredClone(compiledViewCapabilities[0]), buildId: "tampered-build" },
  prepareQuery() {},
  validateResult() {},
}), /digest mismatch/u);

const request = {
  version: "qq-index-query/v1",
  view: { id: "qq.session.conversation", version: 1 },
  access: "literal-session-search",
  params: { literals: ["generated literal"], limit: 5 },
  authority: { kind: "workspace-set/v1", workspaceIds: ["/generated/workspace"] },
  freshness: { mode: "caught-up", maxLagMs: 1_000 },
};
const prepared = compiledViewRegistry.prepareQuery(request, { deriveWorkspaceScopeToken });
assert.equal(Object.isFrozen(prepared), true);
assert.deepEqual(prepared.authority, {
  kind: "workspace-token-set/v1",
  scopeTokens: [deriveWorkspaceScopeToken("/generated/workspace")],
});
assert.equal(JSON.stringify(prepared).includes("/generated/workspace"), false);
assert.throws(() => compiledViewRegistry.prepareQuery({
  ...request, view: { id: "unknown.view", version: 1 },
}, { deriveWorkspaceScopeToken }), (error) => error.code === "unsupported_view");
assert.throws(() => compiledViewRegistry.prepareQuery({
  ...request, access: "runtime-sql",
}, { deriveWorkspaceScopeToken }), /access/u);
assert.throws(() => compiledViewRegistry.prepareQuery({
  ...request, params: { ...request.params, sql: "SELECT *" },
}, { deriveWorkspaceScopeToken }), /unknown field sql/u);
assert.throws(() => compiledViewRegistry.prepareQuery({
  ...request, authority: { kind: "workspace-set/v1", workspaceIds: [] },
}, { deriveWorkspaceScopeToken }), /1\.\.16/u);

const validated = compiledViewRegistry.validateResult(request, {
  type: "execute",
  version: "qq-index-view-response/v1",
  view: request.view,
  buildId: "conversation-v1-physical-1",
  access: request.access,
  snapshot: { generation: "7", sourceFence: "fence-7", lagMs: "2" },
  result: {
    sessions: [{
      rank: 1,
      sessionId: "generated-session",
      score: 0.1,
      matchingLiteralOrdinals: [0],
      title: "Generated title",
      sessionUpdatedAtUnixMs: 2_000,
      evidence: {
        rowKey: "generated-session:0",
        seq: "0",
        eventTimeUnixMs: 1_000,
        eventType: "message/generated",
        surface: "current",
      },
    }],
    truncated: false,
  },
  telemetry: {
    operation: "execute", outcome: "ok", elapsedMicros: "12",
    phasesMicros: { indexedPlan: "10" }, counts: { results: "1" },
  },
});
assert.equal(Object.isFrozen(validated), true);
assert.equal(Object.isFrozen(validated.result.sessions), true);
assert.throws(() => compiledViewRegistry.validateResult(request, {
  ...validated,
  result: { ...validated.result, sessions: [{ ...validated.result.sessions[0], documentBody: "leak" }] },
}), /unknown field documentBody/u);

console.log("compiled view catalog: ok");
