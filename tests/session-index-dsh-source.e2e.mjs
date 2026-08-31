import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  SESSION_INDEX_SEARCH_VERSION,
  connectSessionIndexClient,
} from "@hypermemetic-ai/qq-index/session-index-client";
import {
  createDshSessionIndexSource,
  deriveWorkspaceScopeToken,
  projectDshSessionLog,
  verifyDshSearchCandidates,
} from "@hypermemetic-ai/qq-index/session-index-dsh-source";
import {
  buildSessionEventRecords,
  buildSessionEventSearchDocuments,
  extractSessionEventText,
} from "@deepseek-ai/dsh-session-query";

const root = await mkdtemp(resolve(tmpdir(), "qq-session-index-dsh-generated-"));
const socketPath = resolve(root, "runtime", "session-index.sock");
const databasePath = resolve(root, "generated-index.db");
const children = new Set();

function daemonPath() {
  return process.env.QQ_SESSION_INDEXD_BIN
    ? resolve(process.env.QQ_SESSION_INDEXD_BIN)
    : resolve("target", "debug", "qq-session-indexd");
}

async function ensureDaemon() {
  const binary = daemonPath();
  try {
    await access(binary);
  } catch {
    const build = spawnSync(
      "cargo",
      ["build", "--package", "qq-session-indexd", "--bin", "qq-session-indexd"],
      { cwd: resolve("."), encoding: "utf8" },
    );
    assert.equal(
      build.status,
      0,
      `daemon build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
    );
  }
  return binary;
}

function spawnDaemon(binary) {
  const child = spawn(binary, [
    "--socket", socketPath,
    "--database", databasePath,
    "--create",
    "--readers", "2",
    "--queue-capacity", "4",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  children.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => {
    children.delete(child);
    resolveExit({ code, signal, stderr });
  }));
  return { child, exited };
}

async function connectBoundedly(daemon) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    if (daemon.child.exitCode !== null) {
      assert.fail(`daemon exited before readiness: ${JSON.stringify(await daemon.exited)}`);
    }
    try {
      return await connectSessionIndexClient({ socketPath, timeoutMs: 200 });
    } catch (error) {
      lastError = error;
      await delay(20);
    }
  }
  assert.fail(`daemon was not ready: ${lastError?.stack ?? lastError}`);
}

async function boundedExit(daemon) {
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon exit timed out")), 5_000);
    timer.unref?.();
  });
  const result = await Promise.race([daemon.exited, timeout]);
  assert.deepEqual(
    { code: result.code, signal: result.signal },
    { code: 0, signal: null },
    result.stderr,
  );
}

const sessionId = "generated-dsh-session";
const workspaceId = resolve(root, "generated-dsh-workspace");
const initialLiteral = "generated amber dialogue";
const toolLiteral = "generated forbidden tool result";
const fencedLiteral = "generated fenced heliotrope";
const liveLiteral = "generated live marigold";
const restartedLiteral = "generated resumed quartz";
const logs = new Map([[sessionId, {
  session: {
    version: 1,
    id: sessionId,
    createdAt: 1_700_000_000_000,
    cwd: workspaceId,
  },
  events: [
    event(0, "user/message", initialLiteral),
    event(1, "turn/start"),
    event(2, "tool/result", toolLiteral),
    event(3, "assistant/message", "generated assistant response", {
      op: "replace",
      start: 0,
      end: 0,
    }, [0]),
  ],
}]]);
const projectionHelpers = {
  buildSessionEventRecords,
  buildSessionEventSearchDocuments,
  extractSessionEventText,
};

const listeners = new Set();
let injectedFenceRace = false;
const sessionQuery = {
  async listSessions(signal) {
    assert.equal(signal.aborted, false);
    assert.ok(listeners.size > 0, "live subscription must precede listSessions fence");
    return [{ header: structuredClone(logs.get(sessionId).session), live: true, persisted: false }];
  },
  async readSession(requestedSessionId) {
    const current = logs.get(requestedSessionId);
    if (current === undefined) throw new Error("generated session missing");
    const snapshot = structuredClone(current);
    if (!injectedFenceRace) {
      injectedFenceRace = true;
      current.events.push(event(4, "user/message", fencedLiteral));
      emit("session/event", requestedSessionId);
    }
    return snapshot;
  },
};
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(type, emittedSessionId) {
  for (const listener of [...listeners]) listener(type, { sessionId: emittedSessionId });
}

function event(seq, type, text, surfaceOp = "append", sourceEventSeqs = undefined) {
  const base = { seq, time: 1_700_000_000_000 + seq, type };
  if (type === "turn/start") return { ...base, data: { turn: 0 } };
  const surface = {
    ...base,
    surfaceOp,
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  };
  if (type === "user/message") {
    return {
      ...surface,
      data: {
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "user" },
      },
    };
  }
  if (type === "assistant/message") {
    return {
      ...surface,
      data: {
        turn: 0,
        step: 0,
        message: { role: "assistant", content: [{ type: "text", text }] },
      },
    };
  }
  if (type === "tool/result") {
    return {
      ...surface,
      data: {
        turn: 0,
        step: 0,
        message: {
          role: "tool",
          callId: "generated-call",
          content: [{ type: "text", text }],
          isError: false,
        },
      },
    };
  }
  throw new Error(`unsupported generated event type ${type}`);
}

function searchRequest(literal, eventTypeAllowList, surfaceAllowList) {
  return {
    version: SESSION_INDEX_SEARCH_VERSION,
    literals: [literal],
    perSourceDepth: 10,
    finalLimit: 10,
    filters: {
      authorizedScopeTokens: [deriveWorkspaceScopeToken(workspaceId)],
      workspaceIds: [workspaceId],
      surfaceAllowList,
      eventTypeAllowList,
      includeSessionIds: [sessionId],
      excludeSessionIds: [],
    },
  };
}

function recordingFactory(applied) {
  return async () => {
    const client = await connectSessionIndexClient({ socketPath, timeoutMs: 5_000 });
    return {
      sourceState: (...arguments_) => client.sourceState(...arguments_),
      async applyBatch(batch, options) {
        applied.push(structuredClone(batch));
        return client.applyBatch(batch, options);
      },
      close: () => client.close(),
    };
  };
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  assert.fail(`${description} timed out${lastError ? `: ${lastError.stack}` : ""}`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function exactVerificationAssertions() {
  const good = pointer("verify-good", "0", "user/message", "current");
  const badLiteral = pointer("verify-bad-literal", "0", "user/message", "current");
  const badType = pointer("verify-bad-type", "0", "user/message", "current");
  const badSurface = pointer("verify-bad-surface", "0", "user/message", "current");
  const missing = pointer("verify-missing", "0", "user/message", "current");
  const searchResponse = {
    sources: [
      { queryOrdinal: 0, ranked: [ranked(good), ranked(badLiteral), ranked(badType)] },
      { queryOrdinal: 1, ranked: [ranked(good), ranked(badSurface), ranked(missing)] },
    ],
    fused: [
      fused("verify-good"),
      fused("verify-bad-literal"),
      fused("verify-bad-type"),
      fused("verify-bad-surface"),
      fused("verify-missing"),
    ],
  };
  const sourceEvents = new Map([
    ["verify-good:0", { sessionId: "verify-good", seq: 0, type: "user/message", time: 1, surface: "current", text: "literal alpha and literal beta" }],
    ["verify-bad-literal:0", { sessionId: "verify-bad-literal", seq: 0, type: "user/message", time: 1, surface: "current", text: "different generated text" }],
    ["verify-bad-type:0", { sessionId: "verify-bad-type", seq: 0, type: "tool/result", time: 1, surface: "current", text: "literal alpha" }],
    ["verify-bad-surface:0", { sessionId: "verify-bad-surface", seq: 0, type: "user/message", time: 1, surface: "shadowed", text: "literal beta" }],
  ]);
  const reads = new Map();
  let active = 0;
  let maximumActive = 0;
  const result = await verifyDshSearchCandidates({
    searchResponse,
    literals: ["literal alpha", "literal beta"],
    eventTypeAllowList: ["user/message"],
    surfaceAllowList: ["current", "shadowed"],
    maxConcurrency: 2,
    maxCandidates: 10,
    sessionQuery: {
      async filterEvents(readSessionId, filters) {
        assert.deepEqual(filters, [{ kind: "seq", from: 0, to: 0 }]);
        const key = `${readSessionId}:0`;
        reads.set(key, (reads.get(key) ?? 0) + 1);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await delay(10);
          return sourceEvents.has(key) ? [sourceEvents.get(key)] : [];
        } finally {
          active -= 1;
        }
      },
    },
  });
  assert.equal(reads.size, 5);
  assert.equal(reads.get("verify-good:0"), 1, "duplicate evidence must share one exact read");
  assert.ok(maximumActive <= 2 && maximumActive > 1, `observed exact-read concurrency ${maximumActive}`);
  assert.deepEqual(result.verifiedCandidates.map((candidate) => candidate.sessionId), ["verify-good"]);
  assert.equal(result.verifiedEvidence.length, 2);
  assert.deepEqual(result.verifiedEvidence.map((evidence) => evidence.queryOrdinal), [0, 1]);
}

function pointer(pointerSessionId, seq, eventType, surface) {
  return {
    sessionId: pointerSessionId,
    seq,
    eventType,
    surface,
    documentKey: `generated:${pointerSessionId}:${seq}`,
  };
}
function ranked(evidence) {
  return { sessionId: evidence.sessionId, evidence };
}
function fused(fusedSessionId) {
  return { rank: 1, sessionId: fusedSessionId, rrfScore: 0.1, contributions: [] };
}

async function forceCleanup() {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await Promise.allSettled([...children].map((child) => new Promise((resolveExit) => {
    child.once("exit", resolveExit);
  })));
  await rm(root, { recursive: true, force: true });
}

try {
  const scopeToken = deriveWorkspaceScopeToken(workspaceId);
  assert.match(scopeToken, /^w[a-f0-9]{63}$/u);
  assert.equal(scopeToken, deriveWorkspaceScopeToken(workspaceId));
  assert.notEqual(scopeToken, deriveWorkspaceScopeToken(`${workspaceId}-other`));
  assert.equal(scopeToken.includes(workspaceId), false);
  for (const cwd of [undefined, "relative/generated-workspace"]) {
    const unscoped = await projectDshSessionLog({
      sessionId: "generated-unscoped",
      sessionLog: {
        session: { version: 1, id: "generated-unscoped", createdAt: 1, ...(cwd ? { cwd } : {}) },
        events: [event(0, "user/message", "must never be indexed")],
      },
      projectionHelpers,
    });
    assert.deepEqual(unscoped, [], "missing/non-absolute production cwd must fail closed");
  }
  await exactVerificationAssertions();
  const binary = await ensureDaemon();
  const daemon = spawnDaemon(binary);
  const applied = [];
  const source = createDshSessionIndexSource({
    sessionQuery,
    subscribe,
    projectionHelpers,
    clientFactory: recordingFactory(applied),
    maxBatchDocuments: 2,
  });
  await source.start();
  assert.equal(source.status().phase, "live");
  assert.equal(source.status().eventsCommitted, 5);
  assert.equal(source.status().documentsCommitted, 5);
  assert.equal(source.status().bufferedSessions, 0);
  assert.equal(source.status().lastError, null);
  assert.equal(JSON.stringify(source.status()).includes(sessionId), false);
  assert.equal(JSON.stringify(source.status()).includes(initialLiteral), false);

  // The adapter retains its ingest connection while this independently accepted
  // client reads source state and searches through the real daemon.
  const searchClient = await connectBoundedly(daemon);
  const secondSearchClient = await connectBoundedly(daemon);
  assert.equal((await searchClient.health()).capabilities.readerCount, 2);
  const bootState = await searchClient.sourceState({ sessionIds: [sessionId] });
  assert.equal(bootState.sessions[0].nextSeq, "5");
  assert.equal(bootState.sourceWatermark, "3");
  const [fenced, simultaneousInitial] = await Promise.all([
    searchClient.searchBatch(searchRequest(
      fencedLiteral,
      ["user/message", "assistant/message"],
      ["current", "shadowed"],
    )),
    secondSearchClient.searchBatch(searchRequest(
      initialLiteral,
      ["user/message"],
      ["shadowed"],
    )),
  ]);
  assert.equal(fenced.fused[0].sessionId, sessionId, "fenced live event was lost");
  assert.equal(simultaneousInitial.fused[0].sessionId, sessionId);
  const toolExists = await searchClient.searchBatch(searchRequest(
    toolLiteral,
    ["tool/result"],
    ["current"],
  ));
  assert.equal(toolExists.fused[0].sessionId, sessionId);
  const toolExcluded = await searchClient.searchBatch(searchRequest(
    toolLiteral,
    ["user/message", "assistant/message"],
    ["current", "shadowed"],
  ));
  assert.equal(toolExcluded.fused.length, 0, "conversation type filter leaked a tool result");

  logs.get(sessionId).events.push(event(5, "assistant/message", liveLiteral));
  emit("session/event", sessionId);
  await waitFor(async () => {
    const state = await searchClient.sourceState({ sessionIds: [sessionId] });
    return state.sessions[0]?.nextSeq === "6";
  }, "generated live append");
  const live = await searchClient.searchBatch(searchRequest(
    liveLiteral,
    ["user/message", "assistant/message"],
    ["current", "shadowed"],
  ));
  assert.equal(live.fused[0].sessionId, sessionId);
  assert.deepEqual(applied.at(-1).documents.map((document) => document.seq), ["5"]);
  assert.equal(source.status().eventsCommitted, 6);
  assert.equal(source.status().documentsCommitted, 6);
  await source.close();

  const appliedAfterRestart = [];
  const restarted = createDshSessionIndexSource({
    sessionQuery,
    subscribe,
    projectionHelpers,
    clientFactory: recordingFactory(appliedAfterRestart),
    maxBatchDocuments: 2,
  });
  await restarted.start();
  assert.equal(appliedAfterRestart.length, 0, "restart resent a committed source prefix");
  assert.equal(restarted.status().watermark, "4");

  logs.get(sessionId).events.push(event(6, "user/message", restartedLiteral));
  emit("session/event", sessionId);
  await waitFor(async () => {
    const state = await searchClient.sourceState({ sessionIds: [sessionId] });
    return state.sessions[0]?.nextSeq === "7";
  }, "resumed live append");
  assert.equal(appliedAfterRestart.length, 1);
  assert.deepEqual(appliedAfterRestart[0].documents.map((document) => document.seq), ["6"]);
  assert.equal(appliedAfterRestart[0].sourceWatermark, "5");
  assert.match(appliedAfterRestart[0].idempotencyKey, /^dshbatchv1:[a-f0-9]{64}$/u);
  const allBatches = [...applied, ...appliedAfterRestart];
  assert.deepEqual(allBatches.map((batch) => batch.sourceWatermark), ["1", "2", "3", "4", "5"]);
  assert.equal(new Set(allBatches.map((batch) => batch.idempotencyKey)).size, allBatches.length);

  // Disposal is recorded for a later corpus pass; it never deletes durable rows.
  emit("session/disposed", sessionId);
  await restarted.close();
  const staleStillDerived = await searchClient.searchBatch(searchRequest(
    initialLiteral,
    ["user/message"],
    ["shadowed"],
  ));
  assert.equal(staleStillDerived.fused[0].sessionId, sessionId);

  await secondSearchClient.close();
  await searchClient.shutdown({ timeoutMs: 2_000 });
  await boundedExit(daemon);
  console.log("session-index DSH source generated E2E: ok");
} finally {
  await forceCleanup();
}
