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
  const health = await firstClient.health({ timeoutMs: 1_000 });
  assert.equal(health.protocolVersion, SESSION_INDEX_PROTOCOL_VERSION);
  assert.equal(health.generation, "0");
  assert.equal(health.sourceWatermark, "0");
  assert.deepEqual(health.capabilities, {
    localUnixSocket: true,
    serializedRequests: true,
    activeSqliteInterrupt: false,
    maxFrameBytes: 1_048_576,
  });

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
  assertPersistedSearch(await firstClient.searchBatch(generatedSearch(), { timeoutMs: 2_000 }));
  await firstClient.shutdown({ timeoutMs: 1_000 });
  await boundedExit(firstDaemon, "create daemon");
  await assert.rejects(stat(socketPath), { code: "ENOENT" });

  const restartedDaemon = spawnDaemon(binary, "--open");
  const restartedClient = await connectBoundedly(restartedDaemon);
  const restartedHealth = await restartedClient.health({ timeoutMs: 1_000 });
  assert.equal(restartedHealth.generation, "1");
  assert.equal(restartedHealth.sourceWatermark, "1");
  assertPersistedSearch(
    await restartedClient.searchBatch(generatedSearch(), { timeoutMs: 2_000 }),
  );
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
