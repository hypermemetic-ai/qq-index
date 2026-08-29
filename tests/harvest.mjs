import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { HEAT_COMMIT_LIMIT, harvestRepository } from "../src/harvest.mjs";

const execFile = promisify(execFileCallback);
const roots = [];

async function git(root, ...args) {
  return (await execFile("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trim();
}

async function put(root, path, contents) {
  const target = resolve(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function commit(root, message) {
  await git(root, "add", "-A");
  await git(root, "commit", "-m", message);
}

async function repository() {
  const root = await mkdtemp(resolve(tmpdir(), "qq-index-harvest-test-"));
  roots.push(root);
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Test User");
  await git(root, "config", "user.email", "test@example.test");
  return root;
}

function section(packet, heading) {
  const start = packet.indexOf(`${heading}\n\n\`\`\`text\n`);
  assert.notEqual(start, -1, `packet contains ${heading}`);
  const bodyStart = start + `${heading}\n\n\`\`\`text\n`.length;
  return packet.slice(bodyStart, packet.indexOf("\n```", bodyStart));
}

try {
  assert.equal(HEAT_COMMIT_LIMIT, 200);
  const root = await repository();
  await put(root, "package.json", '{"scripts":{"test":"node test.mjs"},"name":"example"}\n');
  await put(root, "README.md", "old\n");
  await put(root, "src/a.mjs", 'import "./shared.mjs";\nimport value from "external";\n');
  await put(root, "src/b.mjs", 'export { value } from "./shared.mjs";\nimport("./shared.mjs");\n');
  await put(root, "src/c.cjs", 'require("./shared.mjs");\nrequire("./shared.mjs");\n');
  await put(root, "src/shared.mjs", "export const value = 1;\n");
  await put(root, "odd\nname.txt", "odd\n");
  await put(root, "deleted.txt", "gone soon\n");
  await commit(root, "Initial files");
  await put(root, "src/shared.mjs", "export const value = 2;\n");
  await commit(root, "Change shared");
  await put(root, "src/a.mjs", 'import "./shared.mjs";\nexport const a = true;\n');
  await rm(resolve(root, "deleted.txt"));
  await commit(root, "Change a and delete old file");

  const first = await harvestRepository(root);
  const second = await harvestRepository(root);
  assert.equal(first, second, "the same revision produces the same packet");
  assert.match(first, /Revision: [0-9a-f]{40}/);
  assert.match(first, /"name": "example"/);
  assert.match(first, /"test": "node test\.mjs"/);

  const tracked = section(first, "## Tracked files (`git ls-files`)").split("\n");
  assert.deepEqual(tracked, [...tracked].sort());
  assert.ok(tracked.includes('"odd\\nname.txt"'), "unusual paths are JSON-escaped");
  assert.ok(!tracked.includes('"deleted.txt"'), "deleted paths are not evidence");

  const heat = section(first, `## Change heat (occurrences in the last ${HEAT_COMMIT_LIMIT} commits)`);
  assert.match(heat, /^2\t"src\/a\.mjs"/m);
  assert.match(heat, /^2\t"src\/shared\.mjs"/m);
  assert.doesNotMatch(heat, /deleted\.txt/);

  const fanIn = section(first, "## Import fan-in (distinct tracked relative importers)");
  assert.match(fanIn, /^3\t"src\/shared\.mjs"$/m);
  assert.doesNotMatch(fanIn, /external/);

  const noPackage = await repository();
  await put(noPackage, "README.md", "# No package\n");
  await commit(noPackage, "Initial");
  assert.match(await harvestRepository(noPackage), /\(package\.json is not tracked\)/);

  const invalidPackage = await repository();
  await put(invalidPackage, "package.json", "not json\n");
  await commit(invalidPackage, "Invalid package");
  await assert.rejects(() => harvestRepository(invalidPackage), /package\.json is invalid/);

  console.log("deterministic harvest: ok");
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
