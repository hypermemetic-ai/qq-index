import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { refreshRepository } from "./refresh.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CONCURRENCY = 3;

export function resolveRepository(value, options = {}) {
  const home = resolve(options.home ?? homedir());
  return isAbsolute(value) ? resolve(value) : resolve(options.projectsRoot ?? resolve(home, "projects"), value);
}

export function parseRepositoryRegistry(text, options = {}) {
  const repositories = [];
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const repository = resolveRepository(line, options);
    if (!seen.has(repository)) {
      seen.add(repository);
      repositories.push(repository);
    }
  }
  return repositories;
}

function usage() {
  return "Usage: qq-wiki-refresh [--repo <path-or-name>]";
}

export function parseCliArgs(argv) {
  if (argv.length === 0) return { repo: undefined };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  if (argv.length === 2 && argv[0] === "--repo" && argv[1].trim() !== "") return { repo: argv[1] };
  throw new Error(`qq-wiki: invalid arguments\n${usage()}`);
}

async function mapBounded(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await operation(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function repositoriesForCli(argv, options = {}) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) return { help: true, repositories: [] };
  const pathOptions = { home: options.home, projectsRoot: options.projectsRoot };
  if (parsed.repo !== undefined) {
    return { help: false, repositories: [resolveRepository(parsed.repo, pathOptions)] };
  }
  const registryPath = resolve(options.registryPath ?? resolve(packageRoot, "config/repositories"));
  const text = await readFile(registryPath, "utf8");
  return { help: false, repositories: parseRepositoryRegistry(text, pathOptions) };
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const logger = options.logger ?? console;
  const selection = await repositoriesForCli(argv, options);
  if (selection.help) {
    logger.log(usage());
    return [];
  }
  const refresh = options.refreshRepository ?? refreshRepository;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("qq-wiki: concurrency must be a positive integer");
  }
  const results = await mapBounded(
    selection.repositories,
    concurrency,
    (repository) => refresh(repository, { logger }),
  );
  const failures = results
    .map((result, index) => ({ result, repository: selection.repositories[index] }))
    .filter(({ result }) => result.status === "rejected");
  for (const { result, repository } of failures) {
    logger.error(`qq-wiki: ${repository}: ${result.reason?.message ?? result.reason}`);
  }
  if (failures.length > 0) {
    throw new Error(`qq-wiki: ${failures.length} refresh${failures.length === 1 ? "" : "es"} failed`);
  }
  return results.map((result) => result.value);
}

export const internals = Object.freeze({ mapBounded, usage });
