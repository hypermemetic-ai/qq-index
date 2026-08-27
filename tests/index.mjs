import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  INDEX_MAX_CHARS,
  loadIndex,
  validateWiki,
} from "../src/index.mjs";

const roots = [];
async function temporaryRepo() {
  const root = await mkdtemp(resolve(tmpdir(), "qq-wiki-test-"));
  roots.push(root);
  return root;
}

async function put(root, path, contents = "") {
  const target = resolve(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

try {
  const missing = await temporaryRepo();
  assert.equal(loadIndex(missing), "");
  assert.equal(validateWiki(missing), true);

  assert.equal(INDEX_MAX_CHARS, 10_000);

  const exactCap = await temporaryRepo();
  await put(exactCap, "wiki/index.md", "x".repeat(INDEX_MAX_CHARS));
  assert.equal([...loadIndex(exactCap)].length, INDEX_MAX_CHARS);
  assert.equal(validateWiki(exactCap), true);

  const oversized = await temporaryRepo();
  await put(oversized, "wiki/index.md", "x".repeat(INDEX_MAX_CHARS + 1));
  assert.throws(() => loadIndex(oversized), /exceeds 10000 Unicode code points/);
  assert.throws(() => validateWiki(oversized), /exceeds 10000 Unicode code points/);

  const unicodeAtCap = await temporaryRepo();
  const unicodeIndex = `${"é".repeat(INDEX_MAX_CHARS - 1)}😀`;
  assert.equal([...unicodeIndex].length, INDEX_MAX_CHARS);
  assert.ok(Buffer.byteLength(unicodeIndex) > INDEX_MAX_CHARS);
  await put(unicodeAtCap, "wiki/index.md", unicodeIndex);
  assert.equal(loadIndex(unicodeAtCap), unicodeIndex);
  assert.equal(validateWiki(unicodeAtCap), true);
  await put(unicodeAtCap, "wiki/index.md", `${unicodeIndex}x`);
  assert.throws(() => loadIndex(unicodeAtCap), /exceeds 10000 Unicode code points/);

  const manyLines = await temporaryRepo();
  await put(manyLines, "wiki/index.md", "x\n".repeat(1_000));
  assert.equal(validateWiki(manyLines), true);

  const stamped = await temporaryRepo();
  const stampedHeader = "# Orientation\nRefreshed: 2026-08-27T16:28:00Z\n\n";
  const stampedAtCap = `${stampedHeader}${"x".repeat(
    INDEX_MAX_CHARS - [...stampedHeader].length,
  )}`;
  await put(stamped, "wiki/index.md", stampedAtCap);
  assert.equal([...loadIndex(stamped)].length, INDEX_MAX_CHARS);
  assert.equal(validateWiki(stamped), true);
  await put(stamped, "wiki/index.md", `${stampedAtCap}x`);
  assert.throws(() => validateWiki(stamped), /exceeds 10000 Unicode code points/);

  const broken = await temporaryRepo();
  await put(broken, "wiki/index.md", "- [Missing](missing.md)\n");
  assert.throws(() => validateWiki(broken), /not a regular file.*missing\.md/);

  const valid = await temporaryRepo();
  await put(valid, "wiki/index.md", "- [Page](pages/page.md#invariants)\n");
  await put(valid, "wiki/pages/page.md", "# Page\n");
  assert.equal(validateWiki(valid), true);

  const referenceLink = await temporaryRepo();
  await put(referenceLink, "wiki/index.md", "- [Page][route]\n\n[route]: page.md\n");
  await put(referenceLink, "wiki/page.md", "# Page\n");
  assert.equal(validateWiki(referenceLink), true);

  const directoryLink = await temporaryRepo();
  await put(directoryLink, "wiki/index.md", "- [Not a page](pages)\n");
  await mkdir(resolve(directoryLink, "wiki/pages"));
  assert.throws(() => validateWiki(directoryLink), /not a regular file/);

  const escaping = await temporaryRepo();
  await put(escaping, "wiki/index.md", "- [Outside](../outside.md)\n");
  await put(escaping, "outside.md", "outside\n");
  assert.throws(() => validateWiki(escaping), /escapes wiki/);

  const encodedEscape = await temporaryRepo();
  await put(encodedEscape, "wiki/index.md", "- [Outside](%2e%2e/outside.md)\n");
  await put(encodedEscape, "outside.md", "outside\n");
  assert.throws(() => validateWiki(encodedEscape), /escapes wiki/);

  const symlinked = await temporaryRepo();
  await put(symlinked, "wiki/index.md", "- [Outside](outside.md)\n");
  await put(symlinked, "outside.md", "outside\n");
  await symlink(resolve(symlinked, "outside.md"), resolve(symlinked, "wiki/outside.md"));
  assert.throws(() => validateWiki(symlinked), /not a regular file/);

  const symlinkAncestor = await temporaryRepo();
  await put(symlinkAncestor, "wiki/index.md", "- [Outside](pages/page.md)\n");
  await put(symlinkAncestor, "outside/page.md", "outside\n");
  await symlink(resolve(symlinkAncestor, "outside"), resolve(symlinkAncestor, "wiki/pages"));
  assert.throws(() => validateWiki(symlinkAncestor), /linked page escapes wiki/);

  const wikiWithoutIndex = await temporaryRepo();
  await mkdir(resolve(wikiWithoutIndex, "wiki"));
  assert.equal(loadIndex(wikiWithoutIndex), "");
  assert.throws(() => validateWiki(wikiWithoutIndex), /index\.md is required/);

  const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
  assert.equal(validateWiki(repositoryRoot), true);

  console.log("index loader: ok");
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
