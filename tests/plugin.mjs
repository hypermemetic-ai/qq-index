import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import * as plugin from "@hypermemetic-ai/qq-index";
import {
  deriveWorkspaceScopeToken,
  verifyDshSearchCandidates,
} from "@hypermemetic-ai/qq-index/session-index-dsh-source";

assert.equal(plugin.name, "qq-index");
assert.deepEqual(plugin.inject, []);
assert.equal(plugin.provide, "qq-index");
assert.equal(typeof plugin.apply, "function");
assert.equal(typeof plugin.loadIndex, "function");
assert.equal(typeof plugin.validateIndex, "function");
assert.equal(plugin.MAX_INJECTED_INDEX_CODE_POINTS, 10_000);
assert.equal(plugin.INDEX_MAX_CHARS, plugin.MAX_INJECTED_INDEX_CODE_POINTS);
assert.match(plugin.INDEX_TRUNCATION_MARKER, /\[README\.md\]\(README\.md\)/);
assert.equal(typeof plugin.internals.markdownDestinations, "function");
assert.equal(typeof plugin.internals.projectIndex, "function");

const registrations = [];
const disposeDisabled = plugin.apply({
  provide(name, service) {
    registrations.push({ name, service });
  },
});

assert.deepEqual(registrations.map(({ name }) => name), ["qq-index", "qq-session-index"]);
const indexService = registrations[0].service;
const sessionService = registrations[1].service;
assert.equal(Object.isFrozen(indexService), true);
assert.deepEqual(Object.keys(indexService).sort(), ["loadIndex", "validateIndex"]);
assert.equal(indexService.loadIndex, plugin.loadIndex);
assert.equal(indexService.validateIndex, plugin.validateIndex);
assert.equal(Object.isFrozen(sessionService), true);
assert.deepEqual(Object.keys(sessionService).sort(), ["capabilities", "deriveWorkspaceScopeToken", "health", "queryView", "ready", "restart", "searchBatch", "status", "verifyDshSearchCandidates"]);
assert.equal(sessionService.deriveWorkspaceScopeToken, deriveWorkspaceScopeToken);
assert.equal(sessionService.verifyDshSearchCandidates, verifyDshSearchCandidates);
assert.equal(sessionService.ready(), false);
assert.equal(sessionService.status().enabled, false);
assert.equal(sessionService.status().phase, "disabled");
assert.equal(JSON.stringify(sessionService.status()).includes("socket"), false);
await assert.rejects(sessionService.searchBatch({}), (error) => error.code === "disabled");
await disposeDisabled();

let injection;
const optionalRegistrations = [];
const disposeWaiting = plugin.apply({
  provide(name, provided) {
    optionalRegistrations.push({ name, service: provided });
  },
  inject(dependencies, callback) {
    injection = { dependencies, callback };
    return { dispose() {} };
  },
}, {
  sessionIndex: {
    enabled: true,
    socketPath: "/generated/runtime/qq-index/session-index.sock",
  },
});
assert.deepEqual(injection.dependencies, ["sessionQuery"]);
assert.equal(typeof injection.callback, "function");
const waitingService = optionalRegistrations.find(({ name }) => name === "qq-session-index").service;
assert.equal(waitingService.status().phase, "waiting-session-query");
assert.equal(waitingService.ready(), false);
await assert.rejects(waitingService.health(), (error) => error.code === "session_query_unavailable");
await disposeWaiting();
assert.throws(() => plugin.apply({ provide() {} }, {
  sessionIndex: { enabled: true, socketPath: "relative.sock" },
}), /absolute/u);

const repository = await mkdtemp(resolve(tmpdir(), "qq-index-plugin-"));
try {
  await writeFile(resolve(repository, "README.md"), "# Index\n\n[Package](package.json)\n");
  await writeFile(resolve(repository, "package.json"), "{}\n");
  assert.equal(indexService.loadIndex(repository), "# Index\n\n[Package](package.json)\n");
  assert.equal(indexService.validateIndex(repository), true);

  await writeFile(resolve(repository, "README.md"), "[Missing](missing.md)\n");
  assert.throws(() => indexService.validateIndex(repository), /not a regular file/);
} finally {
  await rm(repository, { recursive: true, force: true });
}

console.log("index plugin: ok");
