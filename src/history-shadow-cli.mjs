import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeRepository, HISTORY_SHADOW_POLICY } from "./history-shadow.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveShadowRepository(value, options = {}) {
  if (Buffer.byteLength(value, "utf8") > HISTORY_SHADOW_POLICY.limits.maxPathBytes) {
    throw new Error("qq-index history shadow: repository argument exceeds the path limit");
  }
  const home = resolve(options.home ?? homedir());
  return isAbsolute(value) ? resolve(value) : resolve(options.projectsRoot ?? resolve(home, "projects"), value);
}

export function parseShadowRegistry(text, options = {}) {
  const repositories = [];
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const repository = resolveShadowRepository(line, options);
    if (!seen.has(repository)) {
      seen.add(repository);
      repositories.push(repository);
    }
  }
  if (repositories.length > HISTORY_SHADOW_POLICY.limits.maxRegistryRepositories) {
    throw new Error("qq-index history shadow: repository registry exceeds the repository limit");
  }
  return repositories;
}

export function historyShadowUsage() {
  return "Usage: qq-index-history-shadow [--repo <path-or-name>]";
}

export function parseHistoryShadowArgs(argv) {
  if (argv.length === 0) return { repo: undefined };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  if (argv.length === 2 && argv[0] === "--repo" && argv[1].trim() !== "") return { repo: argv[1] };
  throw new Error(`qq-index history shadow: invalid arguments\n${historyShadowUsage()}`);
}

export async function repositoriesForHistoryShadow(argv, options = {}) {
  const parsed = parseHistoryShadowArgs(argv);
  if (parsed.help) return { help: true, repositories: [] };
  const pathOptions = { home: options.home, projectsRoot: options.projectsRoot };
  if (parsed.repo !== undefined) {
    return { help: false, repositories: [resolveShadowRepository(parsed.repo, pathOptions)] };
  }
  const registryPath = resolve(options.registryPath ?? resolve(packageRoot, "config/repositories"));
  const bytes = await readFile(registryPath);
  if (bytes.length > HISTORY_SHADOW_POLICY.limits.maxRegistryBytes) {
    throw new Error("qq-index history shadow: repository registry exceeds the byte limit");
  }
  const text = bytes.toString("utf8");
  return { help: false, repositories: parseShadowRegistry(text, pathOptions) };
}

function safeErrorMessage(error) {
  return String(error?.message ?? error).slice(0, 4_096);
}

/** Run the unpublished analyzer and emit one deterministic JSON document. */
export async function runHistoryShadowCli(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const selection = await repositoriesForHistoryShadow(argv, options);
  if (selection.help) {
    stdout.write(`${historyShadowUsage()}\n`);
    return null;
  }

  const analyzer = options.analyzeRepository ?? analyzeRepository;
  const repositories = [];
  for (const repository of selection.repositories) {
    try {
      repositories.push(await analyzer(repository));
    } catch (error) {
      repositories.push({
        schemaVersion: HISTORY_SHADOW_POLICY.schemaVersion,
        policyVersion: HISTORY_SHADOW_POLICY.version,
        repository,
        status: "error",
        reason: "analysis-failed",
        message: safeErrorMessage(error),
        shadowOnly: true,
        publicationEnabled: false,
        selectors: {},
      });
    }
  }
  const report = {
    schemaVersion: HISTORY_SHADOW_POLICY.schemaVersion,
    policyVersion: HISTORY_SHADOW_POLICY.version,
    shadowOnly: true,
    publicationEnabled: false,
    primarySelector: HISTORY_SHADOW_POLICY.primarySelector,
    challengerSelector: HISTORY_SHADOW_POLICY.challengerSelector,
    evaluationArms: HISTORY_SHADOW_POLICY.evaluationArms,
    repositories,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(json, "utf8") > HISTORY_SHADOW_POLICY.limits.maxReportBytes) {
    throw new Error("qq-index history shadow: report exceeds the output byte limit");
  }
  stdout.write(json);
  return report;
}
