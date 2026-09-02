import assert from "node:assert/strict";
import { deriveWorkspaceScopeToken } from "@hypermemetic-ai/qq-index/session-index-dsh-source";
import { createConversationProjectorV1 } from "@hypermemetic-ai/qq-index/views/conversation-v1";

const calls = [];
const projector = createConversationProjectorV1({
  deriveWorkspaceScopeToken,
  workspaceIdForHeader(header) { calls.push("workspace"); return header.workspace; },
  projectEvent(event, { index, observation }) {
    calls.push(`event-${index}`);
    assert.equal(observation.cursor, 1);
    if (event.skip) return null;
    return {
      body: event.body,
      eventTimeUnixMs: event.time,
      eventType: event.type,
      surface: event.surface,
      fingerprint: `fingerprint-${index}`,
    };
  },
  titleForObservation(observation) { calls.push("title"); return `Title at ${observation.cursor}`; },
  revisionForObservation(observation) { calls.push("revision"); return observation.revision; },
});
const result = await projector({
  source: "prepared",
  header: { id: "session-a", workspace: "/generated/workspace" },
  events: [
    { seq: 0, body: "generated body", time: 100, type: "message/generated", surface: "current" },
    { seq: 1, skip: true },
  ],
  cursor: 1,
  revision: "revision-a",
}, { sessionId: "session-a" });
assert.equal(Object.isFrozen(result), true);
assert.equal(Object.isFrozen(result.rows), true);
assert.deepEqual(result.rows, [{
  rowKey: "conversation-v1:9:session-a:0",
  sessionId: "session-a",
  seq: 0,
  eventTimeUnixMs: 100,
  eventType: "message/generated",
  surface: "current",
  workspaceScopeToken: deriveWorkspaceScopeToken("/generated/workspace"),
  body: "generated body",
  fingerprint: "fingerprint-0",
  sessionTitle: "Title at 1",
  sessionUpdatedAtUnixMs: 100,
}]);
assert.equal(result.durableRevision, "revision-a");
assert.deepEqual(calls, ["workspace", "title", "revision", "event-0", "event-1"]);
await assert.rejects(projector({
  header: { id: "session-a", workspace: "/generated/workspace" },
  events: [{ seq: 4 }], cursor: 0, revision: "revision-a",
}, { sessionId: "session-a" }), /contiguous/u);
const aborted = new AbortController();
aborted.abort(new Error("generated abort"));
await assert.rejects(projector({ header: { id: "session-a" }, events: [], cursor: -1 }, {
  sessionId: "session-a", signal: aborted.signal,
}), /generated abort/u);

console.log("conversation view projector: ok");
