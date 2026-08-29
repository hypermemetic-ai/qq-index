import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const HEAT_COMMIT_LIMIT = 200;
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const MODULE_EXTENSIONS = [".mjs", ".js", ".cjs", ".json", ".ts", ".tsx", ".jsx"];
const MODULE_FILE = /\.(?:[cm]?js|json|tsx?|jsx)$/i;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorText(error) {
  return String(error?.stderr || error?.stdout || error?.message || error).trim();
}

async function git(repoRoot, args, options = {}) {
  try {
    return await execFile("git", ["-C", repoRoot, ...args], {
      encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
      maxBuffer: MAX_GIT_OUTPUT,
      ...options,
    });
  } catch (error) {
    const detail = errorText(error);
    throw new Error(`qq-index: git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`, {
      cause: error,
    });
  }
}

function nulPaths(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  return text.split("\0").filter(Boolean);
}

function moduleSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'\n]*?\s+from\s*)?["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveTrackedModule(importer, specifier, tracked) {
  if (!specifier.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  if (base === ".." || base.startsWith("../") || base.startsWith("/")) return null;
  const candidates = [base];
  if (!posix.extname(base)) {
    for (const extension of MODULE_EXTENSIONS) candidates.push(`${base}${extension}`);
    for (const extension of MODULE_EXTENSIONS) candidates.push(`${base}/index${extension}`);
  }
  return candidates.find((candidate) => tracked.has(candidate)) ?? null;
}

async function fanInRows(root, paths) {
  const tracked = new Set(paths);
  const importers = new Map();
  for (const importer of paths.filter((path) => MODULE_FILE.test(path))) {
    let source;
    try {
      source = await readFile(resolve(root, importer), "utf8");
    } catch (error) {
      throw new Error(`qq-index: cannot read tracked module ${JSON.stringify(importer)}: ${error.message}`);
    }
    for (const specifier of new Set(moduleSpecifiers(source))) {
      const target = resolveTrackedModule(importer, specifier, tracked);
      if (target === null || target === importer) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(importer);
    }
  }
  return [...importers]
    .map(([path, sources]) => ({ path, count: sources.size }))
    .sort((left, right) => right.count - left.count || compareText(left.path, right.path));
}

function rowsBlock(rows) {
  if (rows.length === 0) return "(none)";
  return rows.map(({ count, path }) => `${count}\t${JSON.stringify(path)}`).join("\n");
}

/** Build a deterministic, source-free evidence packet for the README writer. */
export async function harvestRepository(repoRoot) {
  const root = resolve(repoRoot);
  const trackedOutput = await git(root, ["ls-files", "-z"], { encoding: null });
  const paths = nulPaths(trackedOutput.stdout).sort(compareText);
  const tracked = new Set(paths);

  let manifest = "(package.json is not tracked)";
  if (tracked.has("package.json")) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    } catch (error) {
      throw new Error(`qq-index: package.json is invalid: ${error.message}`);
    }
    manifest = JSON.stringify(parsed, null, 2);
  }

  const heatOutput = await git(root, [
    "log", `-${HEAT_COMMIT_LIMIT}`, "--format=", "--name-only", "--no-renames", "-z", "--",
  ], { encoding: null });
  const heatCounts = new Map();
  for (const path of nulPaths(heatOutput.stdout)) {
    if (tracked.has(path)) heatCounts.set(path, (heatCounts.get(path) ?? 0) + 1);
  }
  const heat = [...heatCounts]
    .map(([path, count]) => ({ path, count }))
    .sort((left, right) => right.count - left.count || compareText(left.path, right.path));
  const fanIn = await fanInRows(root, paths);
  const revision = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();

  return [
    "# qq-index evidence packet",
    "",
    "This packet is the writer's complete evidence. Paths are JSON strings so unusual filenames cannot change its structure.",
    `Revision: ${revision}`,
    "",
    "## package.json",
    "",
    "```json",
    manifest,
    "```",
    "",
    "## Tracked files (`git ls-files`)",
    "",
    "```text",
    ...paths.map((path) => JSON.stringify(path)),
    "```",
    "",
    `## Change heat (occurrences in the last ${HEAT_COMMIT_LIMIT} commits)`,
    "",
    "```text",
    rowsBlock(heat),
    "```",
    "",
    "## Import fan-in (distinct tracked relative importers)",
    "",
    "```text",
    rowsBlock(fanIn),
    "```",
    "",
  ].join("\n");
}

export const internals = Object.freeze({ moduleSpecifiers, resolveTrackedModule });
