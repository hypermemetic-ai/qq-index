import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { createDshSessionIndexSource } from "../src/session-index-dsh-source.mjs";

const SESSION_ID = "fast-path-production-session";
const WORKSPACE_ID = "/generated/fast-path/workspace";
const HEADER_REVISION = "sha256:test-header-revision";

await unchangedLargeProductionLogSkipsProjection();
await behindCursorProjectsAndCommitsOnlySuffix();
await missingCursorProjectsCompleteLog();
await emptyDurableProductionLogSkipsProjection();
await generatedAndAmbiguousShapesUseProjection();
await malformedShapesDoNotBypassProjectionValidation();
await shorterSourceAndWorkspaceMismatchReject();
await unverifiableDurableCursorsUseProjection();

console.log("session-index DSH unchanged-session fast path: ok");

async function unchangedLargeProductionLogSkipsProjection() {
  const eventCount = 25_000;
  const log = productionLog(eventCount);
  const projectionCalls = { records: 0, documents: 0, extract: 0 };
  const forbiddenProjection = Object.fromEntries([
    "buildSessionEventRecords",
    "buildSessionEventSearchDocuments",
    "extractSessionEventText",
  ].map((name) => [name, () => {
    projectionCalls[name === "buildSessionEventRecords" ? "records"
      : name === "buildSessionEventSearchDocuments" ? "documents" : "extract"] += 1;
    throw new Error(`unchanged production log invoked ${name}`);
  }]));

  const startedAt = performance.now();
  const result = await exercise({
    sessionLog: log,
    durableState: durable(eventCount),
    projectionHelpers: forbiddenProjection,
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.error, null, result.error?.stack);
  assert.deepEqual(projectionCalls, { records: 0, documents: 0, extract: 0 });
  assert.equal(result.readCalls, 1, "the authoritative source must still be read exactly once");
  assert.equal(result.sourceStateCalls, 1);
  assert.equal(result.applyCalls.length, 0, "an unchanged log must perform no commits");
  assert.equal(result.status.sessionsScanned, 1, "the fast path must count the session exactly once");
  assert.equal(result.status.eventsCommitted, 0);
  assert.equal(result.status.documentsCommitted, 0);
  assert.equal(result.status.watermark, "41");
  console.log(JSON.stringify({ unchangedEvents: eventCount, projectionCalls: 0, elapsedMs: Number(elapsedMs.toFixed(2)) }));
}

async function behindCursorProjectsAndCommitsOnlySuffix() {
  const helpers = instrumentedProjectionHelpers();
  const result = await exercise({
    sessionLog: productionLog(5),
    durableState: durable(3),
    projectionHelpers: helpers,
  });

  assert.equal(result.error, null, result.error?.stack);
  assert.deepEqual(helpers.calls, { records: 1, documents: 1, extract: 0 });
  assert.deepEqual(result.applyCalls.flatMap(({ documents }) => documents.map(({ seq }) => seq)), ["3", "4"]);
  assert.equal(result.status.sessionsScanned, 1);
  assert.equal(result.status.eventsCommitted, 2);
  assert.equal(result.status.documentsCommitted, 2);
  assert.equal(result.readCalls, 1);
}

async function missingCursorProjectsCompleteLog() {
  const helpers = instrumentedProjectionHelpers();
  const result = await exercise({
    sessionLog: productionLog(2),
    durableState: undefined,
    projectionHelpers: helpers,
  });

  assert.equal(result.error, null, result.error?.stack);
  assert.deepEqual(helpers.calls, { records: 1, documents: 1, extract: 0 });
  assert.deepEqual(result.applyCalls.flatMap(({ documents }) => documents.map(({ seq }) => seq)), ["0", "1"]);
  assert.equal(result.status.sessionsScanned, 1);
  assert.equal(result.status.eventsCommitted, 2);
  assert.equal(result.readCalls, 1);
}

async function emptyDurableProductionLogSkipsProjection() {
  const helpers = instrumentedProjectionHelpers();
  const result = await exercise({
    sessionLog: productionLog(0),
    durableState: durable(0),
    projectionHelpers: helpers,
  });

  assert.equal(result.error, null, result.error?.stack);
  assert.deepEqual(helpers.calls, { records: 0, documents: 0, extract: 0 });
  assert.equal(result.applyCalls.length, 0);
  assert.equal(result.status.sessionsScanned, 1);
}

async function generatedAndAmbiguousShapesUseProjection() {
  const nonstandardEvents = productionEvents(2);
  Object.setPrototypeOf(nonstandardEvents, Object.create(Array.prototype));
  for (const [description, sessionLog] of [
    ["generated compatibility", {
      workspaceId: WORKSPACE_ID,
      events: productionEvents(2),
    }],
    ["ambiguous top-level workspace", {
      ...productionLog(2),
      workspaceId: "/generated/ambiguous/workspace",
    }],
    ["unknown production header identity", {
      ...productionLog(2),
      session: {
        ...productionLog(0).session,
        workspaceId: "/generated/ambiguous/header-workspace",
      },
    }],
    ["nonstandard production event array", {
      ...productionLog(0),
      events: nonstandardEvents,
    }],
  ]) {
    const helpers = instrumentedProjectionHelpers();
    const result = await exercise({
      sessionLog,
      durableState: durable(2),
      projectionHelpers: helpers,
    });
    assert.equal(result.error, null, `${description}: ${result.error?.stack}`);
    assert.equal(helpers.calls.records, 1, `${description} must use full record projection`);
    assert.equal(helpers.calls.documents, 1, `${description} must use full document projection`);
    assert.equal(result.applyCalls.length, 0);
    assert.equal(result.status.sessionsScanned, 1);
  }
}

async function malformedShapesDoNotBypassProjectionValidation() {
  const relativeWorkspace = await exercise({
    sessionLog: productionLog(1, "relative/generated-workspace"),
    durableState: durable(1, "relative/generated-workspace"),
    projectionHelpers: instrumentedProjectionHelpers(),
  });
  assert.match(relativeWorkspace.error?.message ?? "", /shorter than its durable session cursor/u);
  assert.equal(relativeWorkspace.status.sessionsScanned, 1);

  const malformedEvents = await exercise({
    sessionLog: {
      session: productionLog(0).session,
      events: { 0: productionEvents(1)[0], length: 1 },
    },
    durableState: durable(1),
    projectionHelpers: instrumentedProjectionHelpers(),
  });
  assert.match(malformedEvents.error?.message ?? "", /shorter than its durable session cursor/u);
  assert.equal(malformedEvents.status.sessionsScanned, 1);

  const wrongHeader = await exercise({
    sessionLog: {
      ...productionLog(1),
      session: { ...productionLog(0).session, id: "wrong-session-id" },
    },
    durableState: durable(1),
    projectionHelpers: instrumentedProjectionHelpers(),
  });
  assert.match(wrongHeader.error?.message ?? "", /header id does not match sessionId/u);
  assert.equal(wrongHeader.status.sessionsScanned, 0, "projection failure retains pre-existing counter behavior");
}

async function shorterSourceAndWorkspaceMismatchReject() {
  const shorterHelpers = instrumentedProjectionHelpers();
  const shorter = await exercise({
    sessionLog: productionLog(1),
    durableState: durable(2),
    projectionHelpers: shorterHelpers,
  });
  assert.match(shorter.error?.message ?? "", /shorter than its durable session cursor/u);
  assert.deepEqual(shorterHelpers.calls, { records: 0, documents: 0, extract: 0 });
  assert.equal(shorter.status.sessionsScanned, 1);
  assert.equal(shorter.applyCalls.length, 0);

  const behindMismatchHelpers = instrumentedProjectionHelpers();
  const behindMismatch = await exercise({
    sessionLog: productionLog(2),
    durableState: durable(1, "/generated/other/workspace"),
    projectionHelpers: behindMismatchHelpers,
  });
  assert.match(behindMismatch.error?.message ?? "", /workspace does not match its durable session cursor/u);
  assert.deepEqual(behindMismatchHelpers.calls, { records: 1, documents: 1, extract: 0 });
  assert.equal(behindMismatch.status.sessionsScanned, 1);
  assert.equal(behindMismatch.applyCalls.length, 0);

  const emptyMismatchHelpers = instrumentedProjectionHelpers();
  const emptyMismatch = await exercise({
    sessionLog: productionLog(0),
    durableState: durable(0, "/generated/other/workspace"),
    projectionHelpers: emptyMismatchHelpers,
  });
  assert.match(emptyMismatch.error?.message ?? "", /workspace does not match its durable session cursor/u);
  assert.deepEqual(emptyMismatchHelpers.calls, { records: 0, documents: 0, extract: 0 });
  assert.equal(emptyMismatch.status.sessionsScanned, 1);

  for (const durableWorkspace of [
    "/generated/other/workspace",
    "/generated/fast-path/./workspace",
  ]) {
    const helpers = instrumentedProjectionHelpers();
    const mismatch = await exercise({
      sessionLog: productionLog(2),
      durableState: durable(2, durableWorkspace),
      projectionHelpers: helpers,
    });
    assert.match(mismatch.error?.message ?? "", /workspace does not match its durable session cursor/u);
    assert.deepEqual(helpers.calls, { records: 0, documents: 0, extract: 0 });
    assert.equal(mismatch.status.sessionsScanned, 1);
    assert.equal(mismatch.applyCalls.length, 0);
  }
}

async function unverifiableDurableCursorsUseProjection() {
  const incompleteStateHelpers = instrumentedProjectionHelpers();
  const { headerRevision: ignoredHeaderRevision, ...incompleteState } = durable(1);
  assert.equal(typeof ignoredHeaderRevision, "string");
  const incomplete = await exercise({
    sessionLog: productionLog(1),
    durableState: incompleteState,
    projectionHelpers: incompleteStateHelpers,
  });
  assert.equal(incomplete.error, null, incomplete.error?.stack);
  assert.deepEqual(incompleteStateHelpers.calls, { records: 1, documents: 1, extract: 0 });
  assert.equal(incomplete.applyCalls.length, 0);

  const numericHelpers = instrumentedProjectionHelpers();
  const numeric = await exercise({
    sessionLog: productionLog(1),
    durableState: { ...durable(1), nextSeq: 1 },
    projectionHelpers: numericHelpers,
  });
  assert.equal(numeric.error, null, numeric.error?.stack);
  assert.deepEqual(numericHelpers.calls, { records: 1, documents: 1, extract: 0 });
  assert.equal(numeric.applyCalls.length, 0);
  assert.equal(numeric.status.sessionsScanned, 1);

  const malformedHelpers = instrumentedProjectionHelpers();
  const malformed = await exercise({
    sessionLog: productionLog(1),
    durableState: { ...durable(1), nextSeq: "01" },
    projectionHelpers: malformedHelpers,
  });
  assert.match(malformed.error?.message ?? "", /canonical unsigned integer/u);
  assert.deepEqual(malformedHelpers.calls, { records: 1, documents: 1, extract: 0 });
  assert.equal(malformed.status.sessionsScanned, 1);

  const maximumCursorHelpers = instrumentedProjectionHelpers();
  const maximumCursor = await exercise({
    sessionLog: productionLog(0),
    durableState: { ...durable(0), nextSeq: "9223372036854775807" },
    projectionHelpers: maximumCursorHelpers,
  });
  assert.match(maximumCursor.error?.message ?? "", /shorter than its durable session cursor/u);
  assert.deepEqual(maximumCursorHelpers.calls, { records: 0, documents: 0, extract: 0 });
  assert.equal(maximumCursor.status.sessionsScanned, 1);
}

async function exercise({ sessionLog, durableState, projectionHelpers }) {
  let readCalls = 0;
  let sourceStateCalls = 0;
  const applyCalls = [];
  const client = {
    async sourceState({ sessionIds }) {
      sourceStateCalls += 1;
      assert.deepEqual(sessionIds, [SESSION_ID]);
      return {
        sourceWatermark: "41",
        sessions: durableState === undefined ? [] : [durableState],
      };
    },
    async applyBatch(batch) {
      applyCalls.push(structuredClone(batch));
      return {
        sourceWatermark: batch.sourceWatermark,
        generation: batch.sourceWatermark,
        insertedDocuments: batch.documents.length,
        replayedDocuments: 0,
        batchReplayed: false,
      };
    },
  };
  const source = createDshSessionIndexSource({
    sessionQuery: {
      async listSessions(signal) {
        assert.equal(signal.aborted, false);
        return [{ header: productionLog(0).session, live: true, persisted: false }];
      },
      async readSession(sessionId) {
        readCalls += 1;
        assert.equal(sessionId, SESSION_ID);
        return sessionLog;
      },
    },
    client,
    projectionHelpers,
  });

  let error = null;
  try {
    await source.start();
  } catch (caught) {
    error = caught;
  }
  const status = source.status();
  await source.close();
  return { error, status, readCalls, sourceStateCalls, applyCalls };
}

function durable(nextSeq, workspaceId = WORKSPACE_ID) {
  return {
    sessionId: SESSION_ID,
    nextSeq: String(nextSeq),
    workspaceId,
    headerRevision: HEADER_REVISION,
  };
}

function productionLog(eventCount, cwd = WORKSPACE_ID) {
  return {
    session: {
      version: 0,
      id: SESSION_ID,
      createdAt: 1_700_000_000_000,
      cwd,
    },
    events: productionEvents(eventCount),
  };
}

function productionEvents(eventCount) {
  return Array.from({ length: eventCount }, (_, seq) => ({
    seq,
    time: 1_700_000_000_000 + seq,
    type: "user/message",
    surface: "current",
    text: `generated event ${seq}`,
  }));
}

function instrumentedProjectionHelpers() {
  const calls = { records: 0, documents: 0, extract: 0 };
  return {
    calls,
    async buildSessionEventRecords(first, second) {
      calls.records += 1;
      return sourceEvents(first, second).map((event) => ({ ...event }));
    },
    async buildSessionEventSearchDocuments(first, second) {
      calls.documents += 1;
      return sourceEvents(first, second).map((event) => ({
        seq: event.seq,
        text: event.text ?? `generated event ${event.seq}`,
      }));
    },
    async extractSessionEventText() {
      calls.extract += 1;
      return "unexpected extraction fallback";
    },
  };
}

function sourceEvents(first, second) {
  if (Array.isArray(second)) return second;
  if (Array.isArray(first?.events)) return first.events;
  if (Array.isArray(first)) return first;
  throw new TypeError("test projection received no event array");
}
