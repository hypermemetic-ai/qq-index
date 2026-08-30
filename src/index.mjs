import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Total Unicode-code-point budget for the string returned by loadIndex. */
export const MAX_INJECTED_INDEX_CODE_POINTS = 10_000;
/** @deprecated Compatibility alias for MAX_INJECTED_INDEX_CODE_POINTS. */
export const INDEX_MAX_CHARS = MAX_INJECTED_INDEX_CODE_POINTS;
export const INDEX_TRUNCATION_MARKER =
  "> **qq-index truncation:** This injected excerpt is incomplete. Read the full [README.md](README.md).";

const READ_BUFFER_BYTES = 4 * 1024;
const fileSystem = Object.freeze({ closeSync, openSync, readSync });

function unicodeCodePointCount(text) {
  let count = 0;
  for (const _codePoint of text) count += 1;
  return count;
}

function unicodePrefix(text, maximum) {
  const prefix = [];
  for (const codePoint of text) {
    if (prefix.length === maximum) break;
    prefix.push(codePoint);
  }
  return prefix.join("");
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function inspectIndex(repoRoot) {
  const root = resolve(repoRoot);
  const index = resolve(root, "README.md");
  const indexStat = lstatIfPresent(index);
  if (indexStat !== null && !indexStat.isFile()) {
    throw new Error("qq-index: README.md must be a regular file");
  }
  return { root, index, indexStat };
}

/** Read no more decoded content than is needed to distinguish limit from limit + 1. */
function readUtf8Prefix(path, maximum, reader = fileSystem) {
  const descriptor = reader.openSync(path, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const codePoints = [];

  const append = (decoded) => {
    for (const codePoint of decoded) {
      codePoints.push(codePoint);
      if (codePoints.length > maximum) return true;
    }
    return false;
  };

  try {
    while (true) {
      const bytesRead = reader.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        append(decoder.end());
        return { text: codePoints.join(""), overLimit: codePoints.length > maximum };
      }
      if (append(decoder.write(buffer.subarray(0, bytesRead)))) {
        return { text: codePoints.join(""), overLimit: true };
      }
    }
  } finally {
    reader.closeSync(descriptor);
  }
}

function fenceDelimiter(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return null;
  return { character: match[1][0], length: match[1].length };
}

function closesFence(line, fence) {
  const match = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line);
  return match !== null && match[1][0] === fence.character && match[1].length >= fence.length;
}

function markdownBoundaries(markdown) {
  const section = [];
  const block = [];
  const line = [];
  const lines = markdown.split("\n");
  let offset = 0;
  let openFence = null;
  let atxHeadingCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const completeLine = index < lines.length - 1;
    const rawLine = lines[index];
    const content = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineLength = unicodeCodePointCount(rawLine) + (completeLine ? 1 : 0);
    const end = offset + lineLength;

    if (openFence !== null) {
      if (closesFence(content, openFence)) {
        openFence = null;
        if (completeLine) {
          line.push(end);
          block.push(end);
        }
      }
    } else {
      if (/^ {0,3}#{1,6}(?:[\t ]+|$)/.test(content)) {
        atxHeadingCount += 1;
        // A preamble can put the title at a nonzero offset. Only later ATX
        // headings prove that a complete authored section precedes them.
        if (atxHeadingCount > 1) section.push(offset);
      }

      const opening = fenceDelimiter(content);
      if (opening !== null) {
        openFence = { ...opening, start: offset };
      } else if (completeLine) {
        line.push(end);
        if (/^[\t ]*$/.test(content)) block.push(end);
      }
    }
    offset = end;
  }

  return { block, line, openFence, section };
}

function latest(values) {
  return values.length === 0 ? null : values[values.length - 1];
}

/*
 * A README that starts with one enormous fence has no safe authored boundary.
 * Wrap an indented source prefix in the opposite fence style so the excerpt is
 * still useful and the generated Markdown remains structurally closed.
 */
function fencedBlockFallback(source, maximum, sourceFence) {
  const wrapperCharacter = sourceFence.character === "`" ? "~" : "`";
  const opening = `${wrapperCharacter.repeat(3)}text\n`;
  const closing = `\n${wrapperCharacter.repeat(3)}\n`;
  const fixedLength = unicodeCodePointCount(opening) + unicodeCodePointCount(closing);
  const output = [opening];
  let used = fixedLength;
  let atLineStart = true;

  for (const codePoint of source) {
    if (atLineStart) {
      if (used + 4 > maximum) break;
      output.push("    ");
      used += 4;
      atLineStart = false;
    }
    if (used + 1 > maximum) break;
    output.push(codePoint);
    used += 1;
    if (codePoint === "\n") atLineStart = true;
  }
  output.push(closing);
  return output.join("");
}

function appendTruncationMarker(body) {
  const prefix = body.trimEnd();
  if (prefix === "") return `${INDEX_TRUNCATION_MARKER}\n`;
  return `${prefix}\n\n${INDEX_TRUNCATION_MARKER}\n`;
}

/** Project authored Markdown into the fixed total injected-output budget. */
function projectIndex(markdown, maximum = MAX_INJECTED_INDEX_CODE_POINTS) {
  const retained = [];
  let overLimit = false;
  for (const codePoint of markdown) {
    retained.push(codePoint);
    if (retained.length > maximum) {
      overLimit = true;
      break;
    }
  }
  if (!overLimit) return markdown;

  const markerBudget = unicodeCodePointCount(`\n\n${INDEX_TRUNCATION_MARKER}\n`);
  const bodyBudget = maximum - markerBudget;
  if (bodyBudget <= 0) {
    throw new Error("qq-index: injected-output budget cannot contain its truncation marker");
  }

  const candidate = retained.slice(0, bodyBudget).join("");
  const boundaries = markdownBoundaries(candidate);
  const cutoff = latest(boundaries.section) ?? latest(boundaries.block) ?? latest(boundaries.line);
  let body;

  if (cutoff !== null) {
    body = unicodePrefix(candidate, cutoff);
  } else if (boundaries.openFence !== null) {
    body = fencedBlockFallback(candidate, bodyBudget, boundaries.openFence);
  } else {
    // No complete structural unit fits (for example, one enormous paragraph).
    body = candidate;
  }

  const projected = appendTruncationMarker(body);
  if (unicodeCodePointCount(projected) > maximum) {
    throw new Error("qq-index: internal projection exceeded the injected-output budget");
  }
  return projected;
}

/** Load a bounded README projection, or an empty string when README.md is absent. */
export function loadIndex(repoRoot) {
  const { index, indexStat } = inspectIndex(repoRoot);
  if (indexStat === null) return "";
  const loaded = readUtf8Prefix(index, MAX_INJECTED_INDEX_CODE_POINTS);
  return loaded.overLimit ? projectIndex(loaded.text) : loaded.text;
}

function markdownDestinations(markdown) {
  const destinations = [];
  const inline = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n)]*["'])?\s*\)/g;
  for (const match of markdown.matchAll(inline)) {
    destinations.push(match[1] ?? match[2]);
  }

  const reference = /^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm;
  for (const match of markdown.matchAll(reference)) {
    destinations.push(match[1] ?? match[2]);
  }
  return [...new Set(destinations)];
}

function localPathFromDestination(destination) {
  const raw = destination.trim();
  if (!raw || raw.startsWith("#")) return null;
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(raw) || raw.startsWith("//")) return null;

  const pathPart = raw.split(/[?#]/, 1)[0];
  if (!pathPart) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    throw new Error(`qq-index: invalid link destination ${JSON.stringify(raw)}`);
  }
  if (
    !decoded ||
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    isAbsolute(decoded) ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(decoded)
  ) {
    throw new Error(`qq-index: link must be repository-relative: ${JSON.stringify(raw)}`);
  }
  return { raw, decoded };
}

function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && !rel.split(sep).includes(".."));
}

/** Validate the complete authored README and every local link. */
export function validateIndex(repoRoot) {
  const inspected = inspectIndex(repoRoot);
  if (inspected.indexStat === null) return true;

  // Validation deliberately does not use loadIndex: links after its projection
  // cutoff are still part of the authored-document contract.
  const authoredIndex = readFileSync(inspected.index, "utf8");
  const canonicalRoot = realpathSync(inspected.root);
  for (const destination of markdownDestinations(authoredIndex)) {
    const local = localPathFromDestination(destination);
    if (local === null) continue;

    const target = resolve(inspected.root, local.decoded);
    if (!isContained(inspected.root, target)) {
      throw new Error(`qq-index: link escapes repository: ${JSON.stringify(local.raw)}`);
    }
    const targetStat = lstatIfPresent(target);
    if (targetStat === null || !targetStat.isFile()) {
      throw new Error(`qq-index: linked path is not a regular file: ${JSON.stringify(local.raw)}`);
    }
    const canonicalTarget = realpathSync(target);
    if (!isContained(canonicalRoot, canonicalTarget)) {
      throw new Error(`qq-index: linked path escapes repository: ${JSON.stringify(local.raw)}`);
    }
  }
  return true;
}

export const internals = Object.freeze({
  markdownBoundaries,
  markdownDestinations,
  projectIndex,
  readUtf8Prefix,
  unicodeCodePointCount,
});
