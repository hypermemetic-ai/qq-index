import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const INDEX_MAX_BYTES = 4 * 1024;
export const INDEX_MAX_LINES = 80;
// Readable aliases for consumers that phrase the limit as a cap.
export const MAX_INDEX_BYTES = INDEX_MAX_BYTES;
export const MAX_INDEX_LINES = INDEX_MAX_LINES;

function physicalLineCount(text) {
  if (text.length === 0) return 0;
  const breaks = text.match(/\r\n|[\r\n]/g)?.length ?? 0;
  return breaks + (/[\r\n]$/.test(text) ? 0 : 1);
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function wikiPaths(repoRoot) {
  const root = resolve(repoRoot);
  const wiki = resolve(root, "wiki");
  return { wiki, index: resolve(wiki, "index.md") };
}

function inspectWiki(repoRoot) {
  const paths = wikiPaths(repoRoot);
  const wikiStat = lstatIfPresent(paths.wiki);
  if (wikiStat === null) return { ...paths, wikiStat, indexStat: null };
  if (!wikiStat.isDirectory()) {
    throw new Error("qq-wiki: wiki/ must be a directory");
  }

  const indexStat = lstatIfPresent(paths.index);
  if (indexStat !== null && !indexStat.isFile()) {
    throw new Error("qq-wiki: wiki/index.md must be a regular file");
  }
  return { ...paths, wikiStat, indexStat };
}

/** Load the bounded orientation index, or an empty string when it is absent. */
export function loadIndex(repoRoot) {
  const { index, wikiStat, indexStat } = inspectWiki(repoRoot);
  if (wikiStat === null || indexStat === null) return "";
  if (indexStat.size > INDEX_MAX_BYTES) {
    throw new Error(`qq-wiki: wiki/index.md exceeds ${INDEX_MAX_BYTES} bytes`);
  }

  const bytes = readFileSync(index);
  if (bytes.byteLength > INDEX_MAX_BYTES) {
    throw new Error(`qq-wiki: wiki/index.md exceeds ${INDEX_MAX_BYTES} bytes`);
  }
  const text = bytes.toString("utf8");
  const lines = physicalLineCount(text);
  if (lines > INDEX_MAX_LINES) {
    throw new Error(`qq-wiki: wiki/index.md exceeds ${INDEX_MAX_LINES} lines`);
  }
  return text;
}

function markdownDestinations(markdown) {
  const destinations = [];
  const inline = /(?<!!)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n)]*["'])?\s*\)/g;
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
    throw new Error(`qq-wiki: invalid link destination ${JSON.stringify(raw)}`);
  }
  if (
    !decoded ||
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    isAbsolute(decoded) ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(decoded)
  ) {
    throw new Error(`qq-wiki: link must stay under wiki/: ${JSON.stringify(raw)}`);
  }
  return { raw, decoded };
}

function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && !rel.split(sep).includes(".."));
}

/** Validate index limits and every local page link. Returns true when valid. */
export function validateWiki(repoRoot) {
  const inspected = inspectWiki(repoRoot);
  if (inspected.wikiStat === null) return true;
  if (inspected.indexStat === null) {
    throw new Error("qq-wiki: wiki/index.md is required when wiki/ exists");
  }

  const index = loadIndex(repoRoot);
  const canonicalWiki = realpathSync(inspected.wiki);
  for (const destination of markdownDestinations(index)) {
    const local = localPathFromDestination(destination);
    if (local === null) continue;

    const target = resolve(inspected.wiki, local.decoded);
    if (!isContained(inspected.wiki, target)) {
      throw new Error(`qq-wiki: link escapes wiki/: ${JSON.stringify(local.raw)}`);
    }
    const targetStat = lstatIfPresent(target);
    if (targetStat === null || !targetStat.isFile()) {
      throw new Error(`qq-wiki: linked page is not a regular file: ${JSON.stringify(local.raw)}`);
    }
    const canonicalTarget = realpathSync(target);
    if (!isContained(canonicalWiki, canonicalTarget)) {
      throw new Error(`qq-wiki: linked page escapes wiki/: ${JSON.stringify(local.raw)}`);
    }
  }
  return true;
}
