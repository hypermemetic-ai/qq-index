import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import * as plugin from "@hypermemetic-ai/qq-index";

assert.equal(plugin.name, "qq-index");
assert.deepEqual(plugin.inject, []);
assert.equal(plugin.provide, "qq-index");
assert.equal(typeof plugin.apply, "function");
assert.equal(typeof plugin.loadIndex, "function");
assert.equal(typeof plugin.validateIndex, "function");
assert.equal(plugin.INDEX_MAX_CHARS, 10_000);
assert.equal(typeof plugin.internals.markdownDestinations, "function");

const registrations = [];
plugin.apply({
  provide(name, service) {
    registrations.push({ name, service });
  },
});

assert.deepEqual(registrations.map(({ name }) => name), ["qq-index"]);
const indexService = registrations[0].service;
assert.equal(Object.isFrozen(indexService), true);
assert.deepEqual(Object.keys(indexService).sort(), ["loadIndex", "validateIndex"]);
assert.equal(indexService.loadIndex, plugin.loadIndex);
assert.equal(indexService.validateIndex, plugin.validateIndex);

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
