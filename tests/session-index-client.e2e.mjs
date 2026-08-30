import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  SESSION_INDEX_PROTOCOL_VERSION,
  SESSION_INDEX_SEARCH_VERSION,
  connectSessionIndexClient,
} from "@hypermemetic-ai/qq-index/session-index-client";

const root = await mkdtemp(resolve(tmpdir(), "qq-session-index-e2e-"));
const socketPath = resolve(root, "runtime", "session-index.sock");
const databasePath = resolve(root, "generated-index.db");
const literals = [
  "amber telescope",
  "cobalt orchard",
  "velvet compass",
  "silver meadow",
  "juniper lantern",
];
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
  await access(binary);
  return binary;
}

function spawnDaemon(binary, mode, targetSocket = socketPath, targetDatabase = databasePath) {
  const child = spawn(binary, [
    "--socket",
    targetSocket,
    "--database",
    targetDatabase,
    mode,
    "--readers",
    "2",
    "--queue-capacity",
    "2",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  children.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      children.delete(child);
      resolveExit({ code, signal, stderr });
    });
  });
  return { child, exited, stderr: () => stderr };
}

async function connectBoundedly(processHandle) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    if (processHandle.child.exitCode !== null) {
      const exited = await processHandle.exited;
      assert.fail(`daemon exited before readiness: ${JSON.stringify(exited)}`);
    }
    try {
      return await connectSessionIndexClient({ socketPath, timeoutMs: 100 });
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  assert.fail(`daemon was not ready within 5 seconds: ${lastError?.stack ?? lastError}`);
}

async function boundedExit(processHandle, description) {
  const result = await Promise.race([
    processHandle.exited,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${description} did not exit within 5 seconds`)),
        5_000,
      );
      timer.unref?.();
    }),
  ]);
  assert.deepEqual(
    { code: result.code, signal: result.signal },
    { code: 0, signal: null },
    `${description} failed: ${result.stderr}`,
  );
}

function generatedBatch() {
  return {
    idempotencyKey: "node-generated-batch-1",
    payloadFingerprint: "node-generated-payload-1",
    sourceWatermark: "1",
    documents: [{
      sessionId: "node-generated-session",
      seq: "0",
      eventTimeUnixMs: 1_700_000_000_000,
      eventType: "message/generated",
      surface: "conversation",
      workspaceId: "workspace-generated",
      scopeTokens: ["scopegenerated"],
      body: literals.join(" "),
      fingerprint: "node-generated-document-fingerprint-1",
      sourceRevision: "node-generated-source-revision-1",
    }],
  };
}

function generatedSearch() {
  return {
    version: SESSION_INDEX_SEARCH_VERSION,
    literals,
    perSourceDepth: 10,
    finalLimit: 10,
    filters: {
      authorizedScopeTokens: ["scopegenerated"],
      workspaceIds: [],
      surfaceAllowList: ["conversation"],
      eventTypeAllowList: ["message/generated"],
      includeSessionIds: ["node-generated-session"],
      excludeSessionIds: [],
      sessionSeqBounds: [{
        sessionId: "node-generated-session",
        notBeforeSeq: "0",
        notAfterSeq: "0",
      }],
    },
    minimumSourceWatermark: "1",
  };
}

function broadBatch(batchIndex, count = 1_000) {
  const sourceWatermark = batchIndex + 2;
  return {
    idempotencyKey: `node-broad-batch-${batchIndex}`,
    payloadFingerprint: `node-broad-payload-${batchIndex}`,
    sourceWatermark: String(sourceWatermark),
    documents: Array.from({ length: count }, (_, documentIndex) => {
      const ordinal = batchIndex * count + documentIndex;
      return {
        sessionId: `node-broad-session-${ordinal}`,
        seq: "0",
        eventTimeUnixMs: 1_700_100_000_000 + ordinal,
        eventType: "message/generated",
        surface: "conversation",
        workspaceId: "workspace-generated",
        scopeTokens: ["scopegenerated"],
        body: `generated broad cancellation workload ${"padding ".repeat(48)}${ordinal}`,
        fingerprint: `node-broad-fingerprint-${ordinal}`,
        sourceRevision: `node-broad-revision-${ordinal}`,
      };
    }),
  };
}

function broadSearch() {
  return {
    version: SESSION_INDEX_SEARCH_VERSION,
    literals: ["generated", "broad", "cancellation", "workload", "padding"],
    perSourceDepth: 100,
    finalLimit: 100,
    filters: {
      authorizedScopeTokens: ["scopegenerated"],
      workspaceIds: ["workspace-generated"],
      surfaceAllowList: ["conversation"],
      eventTypeAllowList: ["message/generated"],
      includeSessionIds: [],
      excludeSessionIds: [],
      sessionSeqBounds: [],
    },
    minimumSourceWatermark: "31",
  };
}

async function waitForActiveReaders(client, minimum, pending, description) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !pending.settled) {
    const health = await client.health({ timeoutMs: 500 });
    if (health.capabilities.activeReaders >= minimum) return health;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
  assert.fail(`${description} did not expose ${minimum} active readers before settling`);
}

function assertPersistedSearch(response) {
  assert.equal(response.version, "search-batch-response-v1");
  assert.deepEqual(response.snapshot, {
    generation: "1",
    sourceWatermark: "1",
    sourceLagMs: null,
  });
  assert.equal(response.sources.length, 5);
  for (const [ordinal, source] of response.sources.entries()) {
    assert.equal(source.queryOrdinal, ordinal);
    assert.equal(source.ranked.length, 1);
    assert.equal(source.ranked[0].sessionId, "node-generated-session");
    assert.equal(source.ranked[0].evidence.sessionId, "node-generated-session");
    assert.equal(source.ranked[0].evidence.seq, "0");
    assert.match(source.ranked[0].evidence.documentKey, /^document-v1:/u);
  }
  assert.equal(response.fused.length, 1);
  assert.equal(response.fused[0].sessionId, "node-generated-session");
  assert.equal(response.fused[0].contributions.length, 5);
  for (const contribution of response.fused[0].contributions) {
    assert.equal(contribution.seq, "0");
    assert.match(contribution.documentKey, /^document-v1:/u);
  }
}

async function forceCleanup() {
  const exits = [];
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
    exits.push(new Promise((resolveExit) => child.once("exit", resolveExit)));
  }
  await Promise.allSettled(exits);
  await rm(root, { recursive: true, force: true });
}

try {
  const binary = await ensureDaemon();

  await assert.rejects(
    connectSessionIndexClient({ socketPath: "relative.sock" }),
    (error) => error.code === "invalid_argument",
  );

  const firstDaemon = spawnDaemon(binary, "--create");
  const firstClient = await connectBoundedly(firstDaemon);
  assert.throws(
    () => firstClient.applyBatch({ ...generatedBatch(), unknown: true }),
    (error) => error.code === "invalid_argument",
  );
  assert.throws(
    () => firstClient.searchBatch({ ...generatedSearch(), version: "search-batch-v2" }),
    (error) => error.code === "protocol_violation",
  );
  assert.throws(
    () => firstClient.health({ unknown: true }),
    (error) => error.code === "invalid_argument",
  );
  assert.throws(
    () => firstClient.sourceState({
      sessionIds: Array.from({ length: 33 }, (_, index) => `bounded-${index}`),
    }),
    (error) => error.code === "invalid_argument",
  );
  const health = await firstClient.health({ timeoutMs: 1_000 });
  assert.equal(health.protocolVersion, SESSION_INDEX_PROTOCOL_VERSION);
  assert.equal(health.generation, "0");
  assert.equal(health.sourceWatermark, "0");
  assert.deepEqual(health.capabilities, {
    localUnixSocket: true,
    serializedRequests: false,
    serializedWriter: true,
    activeSqliteInterrupt: true,
    progressDeadlineSupport: true,
    readerCount: 2,
    queueCapacity: 2,
    readerRetirements: 0,
    activeReaders: 0,
    peakActiveReaders: 0,
    maxFrameBytes: 1_048_576,
  });
  assert.equal(health.cancelRequestVersion, "cancel-v1");
  assert.equal(health.cancelResponseVersion, "cancel-response-v1");

  const socketMetadata = await stat(socketPath);
  assert.equal(socketMetadata.isSocket(), true);
  assert.equal(socketMetadata.mode & 0o777, 0o600);
  const parentMetadata = await stat(dirname(socketPath));
  assert.equal(parentMetadata.mode & 0o077, 0);

  const aborted = new AbortController();
  aborted.abort(new Error("generated queued abort"));
  await assert.rejects(
    firstClient.health({ signal: aborted.signal }),
    (error) => error.name === "AbortError" && error.code === "aborted",
  );
  await assert.rejects(
    firstClient.health({ deadlineUnixMs: Date.now() - 1 }),
    (error) => error.code === "deadline_exceeded",
  );

  const receipt = await firstClient.applyBatch(generatedBatch(), { timeoutMs: 2_000 });
  assert.deepEqual(receipt, {
    type: "applyBatch",
    version: "commit-receipt-v1",
    generation: "1",
    sourceWatermark: "1",
    insertedDocuments: 1,
    replayedDocuments: 0,
    batchReplayed: false,
  });
  const searchClient = await connectSessionIndexClient({ socketPath, timeoutMs: 2_000 });
  assert.deepEqual(
    await searchClient.sourceState({
      sessionIds: ["missing-node-generated", "node-generated-session"],
    }),
    {
      type: "sourceState",
      version: "source-state-response-v1",
      generation: "1",
      sourceWatermark: "1",
      sessions: [{
        sessionId: "node-generated-session",
        nextSeq: "1",
        workspaceId: "workspace-generated",
        headerRevision: "node-generated-source-revision-1",
      }],
    },
  );
  assertPersistedSearch(await searchClient.searchBatch(generatedSearch(), { timeoutMs: 2_000 }));
  await searchClient.close();
  await firstClient.shutdown({ timeoutMs: 1_000 });
  await boundedExit(firstDaemon, "create daemon");
  await assert.rejects(stat(socketPath), { code: "ENOENT" });

  const restartedDaemon = spawnDaemon(binary, "--open");
  const restartedClient = await connectBoundedly(restartedDaemon);
  const restartedHealth = await restartedClient.health({ timeoutMs: 1_000 });
  assert.equal(restartedHealth.generation, "1");
  assert.equal(restartedHealth.sourceWatermark, "1");
  const restartedState = await restartedClient.sourceState({
    sessionIds: ["node-generated-session"],
  });
  assert.equal(restartedState.sessions[0].nextSeq, "1");
  assert.equal(restartedState.sessions[0].headerRevision, "node-generated-source-revision-1");
  assertPersistedSearch(
    await restartedClient.searchBatch(generatedSearch(), { timeoutMs: 2_000 }),
  );

  // Build only generated broad data. FTS ranking must inspect enough equal
  // postings to keep requests active while the pool/control path is observed.
  for (let batchIndex = 0; batchIndex < 30; batchIndex += 1) {
    await restartedClient.applyBatch(broadBatch(batchIndex), { timeoutMs: 5_000 });
  }
  const concurrentA = await connectSessionIndexClient({ socketPath, timeoutMs: 5_000 });
  const concurrentB = await connectSessionIndexClient({ socketPath, timeoutMs: 5_000 });
  const overlap = await Promise.all([
    concurrentA.searchBatch(broadSearch(), { timeoutMs: 5_000 }),
    concurrentB.searchBatch(broadSearch(), { timeoutMs: 5_000 }),
  ]);
  assert.equal(overlap[0].snapshot.generation, "31");
  assert.equal(overlap[1].snapshot.generation, "31");
  const overlapHealth = await restartedClient.health({ timeoutMs: 1_000 });
  assert.ok(
    overlapHealth.capabilities.peakActiveReaders >= 2,
    `reader pool did not overlap: ${JSON.stringify(overlapHealth.capabilities)}`,
  );

  const controller = new AbortController();
  const active = { settled: false };
  const cancellable = concurrentA.searchBatch(broadSearch(), {
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  cancellable.then(
    () => { active.settled = true; },
    () => { active.settled = true; },
  );
  await waitForActiveReaders(restartedClient, 1, active, "generated cancellable search");
  const cancelledAt = performance.now();
  controller.abort(new Error("generated active cancellation"));
  await assert.rejects(
    cancellable,
    (error) => error.code === "cancelled",
  );
  const cancellationAckMs = performance.now() - cancelledAt;
  assert.ok(
    cancellationAckMs < 100,
    `active cancellation acknowledgement was ${cancellationAckMs.toFixed(3)} ms`,
  );
  assert.equal(
    (await concurrentA.searchBatch(broadSearch(), { timeoutMs: 5_000 })).snapshot.generation,
    "31",
  );

  // Occupy both readers, then submit a third generated search with a short
  // absolute deadline. Queue time is part of the deadline and cancellation is
  // acknowledged without entering SQLite.
  const holders = { settled: false };
  const holderA = concurrentA.searchBatch(broadSearch(), { timeoutMs: 5_000 });
  const holderB = concurrentB.searchBatch(broadSearch(), { timeoutMs: 5_000 });
  Promise.allSettled([holderA, holderB]).then(() => { holders.settled = true; });
  await waitForActiveReaders(restartedClient, 2, holders, "generated queued-deadline holders");
  const queuedStarted = performance.now();
  await assert.rejects(
    restartedClient.searchBatch(broadSearch(), { deadlineUnixMs: Date.now() + 50 }),
    (error) => error.code === "deadline_exceeded",
  );
  assert.ok(performance.now() - queuedStarted < 200, "queued deadline was not bounded");
  await Promise.all([holderA, holderB]);
  await concurrentA.close();
  await concurrentB.close();

  console.log(`generated active cancellation acknowledgement: ${cancellationAckMs.toFixed(3)} ms`);
  await restartedClient.shutdown({ timeoutMs: 1_000 });
  await boundedExit(restartedDaemon, "restarted daemon");

  const unsafeSocket = resolve(root, "unsafe-existing-target");
  const unsafeContents = "generated non-socket target\n";
  await writeFile(unsafeSocket, unsafeContents);
  await chmod(unsafeSocket, 0o600);
  const unsafeDaemon = spawnDaemon(binary, "--open", unsafeSocket, databasePath);
  const unsafeExit = await unsafeDaemon.exited;
  assert.equal(unsafeExit.code, 1, unsafeExit.stderr);
  assert.match(unsafeExit.stderr, /refusing pre-existing socket target/u);
  assert.equal(await readFile(unsafeSocket, "utf8"), unsafeContents);

  console.log("session-index client daemon E2E: ok");
} finally {
  await forceCleanup();
}
