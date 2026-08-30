import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  INDEX_MAX_CHARS,
  INDEX_TRUNCATION_MARKER,
  MAX_INJECTED_INDEX_CODE_POINTS,
  internals,
  loadIndex,
  validateIndex,
} from "../src/index.mjs";

const roots = [];
async function temporaryRepo() {
  const root = await mkdtemp(resolve(tmpdir(), "qq-index-test-"));
  roots.push(root);
  return root;
}

async function put(root, path, content) {
  const absolute = resolve(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

function codePointCount(value) {
  return [...value].length;
}

function assertTruncatedProjection(value) {
  assert.ok(value.length > INDEX_TRUNCATION_MARKER.length);
  assert.ok(codePointCount(value) <= MAX_INJECTED_INDEX_CODE_POINTS);
  assert.match(value, /\*\*qq-index truncation:\*\*/);
  assert.match(value, /\[README\.md\]\(README\.md\)/);
  assert.equal(internals.markdownBoundaries(value).openFence, null);
}

try {
  const missing = await temporaryRepo();
  assert.equal(loadIndex(missing), "");
  assert.equal(validateIndex(missing), true);
  assert.equal(MAX_INJECTED_INDEX_CODE_POINTS, 10_000);
  assert.equal(INDEX_MAX_CHARS, MAX_INJECTED_INDEX_CODE_POINTS);

  const exactCap = await temporaryRepo();
  const exactText = "x".repeat(MAX_INJECTED_INDEX_CODE_POINTS);
  await put(exactCap, "README.md", exactText);
  assert.equal(loadIndex(exactCap), exactText);
  assert.equal(validateIndex(exactCap), true);

  const unicodeAtCap = await temporaryRepo();
  const unicodeIndex = `${"é".repeat(MAX_INJECTED_INDEX_CODE_POINTS - 1)}😀`;
  assert.equal(codePointCount(unicodeIndex), MAX_INJECTED_INDEX_CODE_POINTS);
  assert.ok(Buffer.byteLength(unicodeIndex) > MAX_INJECTED_INDEX_CODE_POINTS);
  await put(unicodeAtCap, "README.md", unicodeIndex);
  assert.equal(loadIndex(unicodeAtCap), unicodeIndex);

  const oversized = await temporaryRepo();
  await put(oversized, "README.md", "x".repeat(MAX_INJECTED_INDEX_CODE_POINTS + 1));
  const oversizedProjection = loadIndex(oversized);
  assertTruncatedProjection(oversizedProjection);
  assert.match(oversizedProjection, /^x+/);
  assert.equal(loadIndex(oversized), oversizedProjection);
  assert.equal(validateIndex(oversized), true);

  const unicodeOversized = await temporaryRepo();
  await put(unicodeOversized, "README.md", "😀".repeat(MAX_INJECTED_INDEX_CODE_POINTS + 1));
  const unicodeProjection = loadIndex(unicodeOversized);
  assertTruncatedProjection(unicodeProjection);
  assert.match(unicodeProjection, /^😀+/u);
  assert.doesNotMatch(unicodeProjection, /\uFFFD/u);
  assert.equal(Buffer.from(unicodeProjection, "utf8").toString("utf8"), unicodeProjection);

  const sectioned = await temporaryRepo();
  await put(sectioned, "README.md", [
    "# Identity",
    "",
    "Purpose.",
    "",
    "## Complete map",
    "",
    "Useful map.",
    "",
    "## Oversized detail",
    "",
    "x".repeat(MAX_INJECTED_INDEX_CODE_POINTS),
  ].join("\n"));
  const sectionProjection = loadIndex(sectioned);
  assertTruncatedProjection(sectionProjection);
  assert.match(sectionProjection, /## Complete map/);
  assert.match(sectionProjection, /Useful map\./);
  assert.doesNotMatch(sectionProjection, /## Oversized detail/);

  const firstHeadingPreambles = [
    ["leading blank line", "\n# Title\n\nPurpose lives here.\n\n"],
    ["leading CRLF", "\r\n# Title\r\n\r\nPurpose lives here.\r\n\r\n"],
    ["non-heading preamble", "A short preamble.\n\n# Title\n\nPurpose lives here.\n\n"],
  ];
  for (const [description, prefix] of firstHeadingPreambles) {
    const repository = await temporaryRepo();
    await put(
      repository,
      "README.md",
      `${prefix}${"x".repeat(MAX_INJECTED_INDEX_CODE_POINTS)}`,
    );
    const projection = loadIndex(repository);
    assertTruncatedProjection(projection);
    assert.match(projection, /# Title/, `${description} retains the first ATX heading`);
    assert.match(projection, /Purpose lives here\./, `${description} retains useful orientation`);
    assert.equal(loadIndex(repository), projection, `${description} projection is deterministic`);
  }

  const firstHeadingWithoutLaterBlockBoundary = [
    ["LF heading", "\n# Title\n", null],
    ["LF heading and purpose", "\n# Title\nPurpose lives here.\n", "Purpose lives here."],
    ["CRLF heading", "\r\n# Title\r\n", null],
    [
      "CRLF heading and purpose",
      "\r\n# Title\r\nPurpose lives here.\r\n",
      "Purpose lives here.",
    ],
  ];
  for (const [description, prefix, purpose] of firstHeadingWithoutLaterBlockBoundary) {
    const source = `${prefix}${"x".repeat(MAX_INJECTED_INDEX_CODE_POINTS)}`;
    const projection = internals.projectIndex(source);
    assertTruncatedProjection(projection);
    assert.match(projection, /# Title/, `${description} retains the first ATX heading`);
    if (purpose !== null) {
      assert.ok(projection.includes(purpose), `${description} retains useful orientation`);
    }
    assert.equal(
      internals.projectIndex(source),
      projection,
      `${description} projection is deterministic`,
    );
  }

  const leadingBlankFenceProjection = internals.projectIndex(
    ["", "```text", "x".repeat(MAX_INJECTED_INDEX_CODE_POINTS)].join("\n"),
  );
  assertTruncatedProjection(leadingBlankFenceProjection);
  assert.match(leadingBlankFenceProjection, /    ```text\n/u);
  assert.match(leadingBlankFenceProjection, /\n~~~\n\n> \*\*qq-index truncation:/u);

  const paragraphs = await temporaryRepo();
  await put(paragraphs, "README.md", [
    "Identity paragraph.",
    "",
    "Complete useful paragraph.",
    "",
    "x".repeat(MAX_INJECTED_INDEX_CODE_POINTS),
  ].join("\n"));
  const paragraphProjection = loadIndex(paragraphs);
  assertTruncatedProjection(paragraphProjection);
  assert.match(paragraphProjection, /Complete useful paragraph\./);
  assert.doesNotMatch(paragraphProjection, /xxx/);

  const lines = await temporaryRepo();
  await put(lines, "README.md", [
    "Identity line",
    "Complete useful line",
    "x".repeat(MAX_INJECTED_INDEX_CODE_POINTS),
  ].join("\n"));
  const lineProjection = loadIndex(lines);
  assertTruncatedProjection(lineProjection);
  assert.match(lineProjection, /Complete useful line/);
  assert.doesNotMatch(lineProjection, /xxx/);

  const fenced = await temporaryRepo();
  await put(fenced, "README.md", [
    "# Identity",
    "",
    "Useful introduction.",
    "",
    "```js",
    "x".repeat(MAX_INJECTED_INDEX_CODE_POINTS),
  ].join("\n"));
  const fencedProjection = loadIndex(fenced);
  assertTruncatedProjection(fencedProjection);
  assert.match(fencedProjection, /Useful introduction\./);
  assert.doesNotMatch(fencedProjection, /```js/);

  const completeFence = await temporaryRepo();
  await put(completeFence, "README.md", [
    "Identity paragraph.",
    "",
    "```js",
    "console.log('complete');",
    "```",
    "",
    "x".repeat(MAX_INJECTED_INDEX_CODE_POINTS),
  ].join("\n"));
  const completeFenceProjection = loadIndex(completeFence);
  assertTruncatedProjection(completeFenceProjection);
  assert.ok(completeFenceProjection.includes("```js\nconsole.log('complete');\n```"));

  const enormousFence = await temporaryRepo();
  await put(enormousFence, "README.md", `\`\`\`text\n${"😀".repeat(MAX_INJECTED_INDEX_CODE_POINTS)}`);
  const fenceFallback = loadIndex(enormousFence);
  assertTruncatedProjection(fenceFallback);
  assert.match(fenceFallback, /^~~~text\n    ```text\n/u);
  assert.match(fenceFallback, /\n~~~\n\n> \*\*qq-index truncation:/u);
  assert.doesNotMatch(fenceFallback, /\uFFFD/u);

  const millionCodePoints = Buffer.from("😀".repeat(1_000_000));
  let sourceOffset = 0;
  let bytesReadTotal = 0;
  let closed = false;
  const fakeReader = {
    openSync(path, flags) {
      assert.equal(path, "virtual-README.md");
      assert.equal(flags, "r");
      return 7;
    },
    readSync(descriptor, buffer, offset, length, position) {
      assert.equal(descriptor, 7);
      assert.equal(offset, 0);
      assert.equal(position, null);
      const bytesRead = Math.min(length, millionCodePoints.length - sourceOffset);
      millionCodePoints.copy(buffer, 0, sourceOffset, sourceOffset + bytesRead);
      sourceOffset += bytesRead;
      bytesReadTotal += bytesRead;
      return bytesRead;
    },
    closeSync(descriptor) {
      assert.equal(descriptor, 7);
      closed = true;
    },
  };
  const boundedRead = internals.readUtf8Prefix(
    "virtual-README.md",
    MAX_INJECTED_INDEX_CODE_POINTS,
    fakeReader,
  );
  assert.equal(boundedRead.overLimit, true);
  assert.equal(codePointCount(boundedRead.text), MAX_INJECTED_INDEX_CODE_POINTS + 1);
  assert.doesNotMatch(boundedRead.text, /\uFFFD/u);
  assert.equal(closed, true);
  assert.ok(bytesReadTotal < millionCodePoints.length / 50);

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

  const validLinkAfterCutoff = await temporaryRepo();
  await put(validLinkAfterCutoff, "README.md", [
    "# Long index",
    "",
    "x".repeat(MAX_INJECTED_INDEX_CODE_POINTS),
    "",
    "[Package](package.json)",
    "",
  ].join("\n"));
  await put(validLinkAfterCutoff, "package.json", "{}\n");
  assertTruncatedProjection(loadIndex(validLinkAfterCutoff));
  assert.doesNotMatch(loadIndex(validLinkAfterCutoff), /\[Package\]/);
  assert.equal(validateIndex(validLinkAfterCutoff), true);

  const brokenAfterCutoff = await temporaryRepo();
  await put(brokenAfterCutoff, "README.md", [
    "# Long index",
    "",
    "x".repeat(MAX_INJECTED_INDEX_CODE_POINTS),
    "",
    "[Missing](missing-after-cutoff.mjs)",
    "",
  ].join("\n"));
  assertTruncatedProjection(loadIndex(brokenAfterCutoff));
  assert.throws(
    () => validateIndex(brokenAfterCutoff),
    /not a regular file.*missing-after-cutoff\.mjs/,
  );

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
  assert.throws(() => validateIndex(readmeSymlink), /README\.md must be a regular file/);

  const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
  assert.equal(validateIndex(repositoryRoot), true);

  console.log("index loader: ok");
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
