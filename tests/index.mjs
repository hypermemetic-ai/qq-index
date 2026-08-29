import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { INDEX_MAX_CHARS, loadIndex, validateIndex } from "../src/index.mjs";

const roots = [];
async function temporaryRepo() {
  const root = await mkdtemp(resolve(tmpdir(), "qq-index-test-"));
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
  assert.equal(validateIndex(missing), true);
  assert.equal(INDEX_MAX_CHARS, 10_000);

  const exactCap = await temporaryRepo();
  await put(exactCap, "README.md", "x".repeat(INDEX_MAX_CHARS));
  assert.equal([...loadIndex(exactCap)].length, INDEX_MAX_CHARS);
  assert.equal(validateIndex(exactCap), true);

  const oversized = await temporaryRepo();
  await put(oversized, "README.md", "x".repeat(INDEX_MAX_CHARS + 1));
  assert.throws(() => loadIndex(oversized), /README\.md exceeds 10000 Unicode code points/);
  assert.throws(() => validateIndex(oversized), /README\.md exceeds 10000 Unicode code points/);

  const unicodeAtCap = await temporaryRepo();
  const unicodeIndex = `${"é".repeat(INDEX_MAX_CHARS - 1)}😀`;
  assert.equal([...unicodeIndex].length, INDEX_MAX_CHARS);
  assert.ok(Buffer.byteLength(unicodeIndex) > INDEX_MAX_CHARS);
  await put(unicodeAtCap, "README.md", unicodeIndex);
  assert.equal(loadIndex(unicodeAtCap), unicodeIndex);
  await put(unicodeAtCap, "README.md", `${unicodeIndex}x`);
  assert.throws(() => validateIndex(unicodeAtCap), /exceeds 10000/);

  const valid = await temporaryRepo();
  await put(valid, "README.md", [
    "# Index",
    "[Module](src/module.mjs#api)",
    "![Diagram](assets/diagram.svg)",
    "[Config][config]",
    "[Section](#index)",
    "[Web](https://example.test/path)",
    "[Mail](mailto:test@example.test)",
    "",
    "[config]: <package.json> \"manifest\"",
    "",
  ].join("\n"));
  await put(valid, "src/module.mjs", "export {};\n");
  await put(valid, "assets/diagram.svg", "<svg/>\n");
  await put(valid, "package.json", "{}\n");
  assert.equal(validateIndex(valid), true);

  const broken = await temporaryRepo();
  await put(broken, "README.md", "[Missing](missing.mjs)\n");
  assert.throws(() => validateIndex(broken), /not a regular file.*missing\.mjs/);

  const brokenImage = await temporaryRepo();
  await put(brokenImage, "README.md", "![Missing](missing.svg)\n");
  assert.throws(() => validateIndex(brokenImage), /not a regular file.*missing\.svg/);

  const directoryLink = await temporaryRepo();
  await put(directoryLink, "README.md", "[Directory](src/)\n");
  await mkdir(resolve(directoryLink, "src"));
  assert.throws(() => validateIndex(directoryLink), /not a regular file/);

  const escaping = await temporaryRepo();
  await put(escaping, "README.md", "[Outside](../outside.md)\n");
  assert.throws(() => validateIndex(escaping), /escapes repository/);

  const encodedEscape = await temporaryRepo();
  await put(encodedEscape, "README.md", "[Outside](%2e%2e/outside.md)\n");
  assert.throws(() => validateIndex(encodedEscape), /escapes repository/);

  const absolute = await temporaryRepo();
  await put(absolute, "README.md", "[Absolute](/etc/passwd)\n");
  assert.throws(() => validateIndex(absolute), /repository-relative/);

  const invalidEncoding = await temporaryRepo();
  await put(invalidEncoding, "README.md", "[Bad](%ZZ)\n");
  assert.throws(() => validateIndex(invalidEncoding), /invalid link destination/);

  const symlinked = await temporaryRepo();
  await put(symlinked, "README.md", "[Link](link.mjs)\n");
  await put(symlinked, "source.mjs", "export {};\n");
  await symlink(resolve(symlinked, "source.mjs"), resolve(symlinked, "link.mjs"));
  assert.throws(() => validateIndex(symlinked), /not a regular file/);

  const symlinkAncestor = await temporaryRepo();
  const outside = await temporaryRepo();
  await put(symlinkAncestor, "README.md", "[Outside](linked/file.mjs)\n");
  await put(outside, "file.mjs", "export {};\n");
  await symlink(outside, resolve(symlinkAncestor, "linked"));
  assert.throws(() => validateIndex(symlinkAncestor), /linked path escapes repository/);

  const readmeSymlink = await temporaryRepo();
  await put(readmeSymlink, "actual.md", "# Index\n");
  await symlink(resolve(readmeSymlink, "actual.md"), resolve(readmeSymlink, "README.md"));
  assert.throws(() => loadIndex(readmeSymlink), /README\.md must be a regular file/);

  const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
  assert.equal(validateIndex(repositoryRoot), true);

  console.log("index loader: ok");
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
