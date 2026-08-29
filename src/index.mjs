import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const INDEX_MAX_CHARS = 10_000;

function unicodeCodePointCount(text) {
  let count = 0;
  for (const _codePoint of text) count += 1;
  return count;
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

/** Load the bounded repository index, or an empty string when it is absent. */
export function loadIndex(repoRoot) {
  const { index, indexStat } = inspectIndex(repoRoot);
  if (indexStat === null) return "";
  const text = readFileSync(index, "utf8");
  if (unicodeCodePointCount(text) > INDEX_MAX_CHARS) {
    throw new Error(`qq-index: README.md exceeds ${INDEX_MAX_CHARS} Unicode code points`);
  }
  return text;
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

/** Validate the README bound and every local link. Returns true when valid. */
export function validateIndex(repoRoot) {
  const inspected = inspectIndex(repoRoot);
  if (inspected.indexStat === null) return true;

  const index = loadIndex(repoRoot);
  const canonicalRoot = realpathSync(inspected.root);
  for (const destination of markdownDestinations(index)) {
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

export const internals = Object.freeze({ markdownDestinations });
