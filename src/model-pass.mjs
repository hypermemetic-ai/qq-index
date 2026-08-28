import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRITER_TASK = "Refresh this repository's architect orientation wiki.";
export const MODELS_NAME_TOKEN = "__QQ_WIKI_MODELS_ROOT__";

function requirePath(path, label, mode = fsConstants.F_OK) {
  try {
    accessSync(path, mode);
  } catch {
    throw new Error(`qq-wiki: ${label} is missing: ${path}`);
  }
  return path;
}

function projectsRoots(env, root) {
  const candidates = [];
  const add = (value) => {
    if (!value) return;
    const absolute = resolve(value);
    if (!candidates.includes(absolute)) candidates.push(absolute);
  };
  add(env.QQ_PROJECTS_ROOT);
  const parts = resolve(root).split("/");
  const worktreesIndex = parts.lastIndexOf(".qq-worktrees");
  if (worktreesIndex > 0) add(parts.slice(0, worktreesIndex).join("/") || "/");
  add(dirname(root));
  if (env.HOME) add(resolve(env.HOME, "projects"));
  return candidates;
}

function firstPresent(paths, label, mode = fsConstants.F_OK) {
  for (const path of paths) {
    try {
      accessSync(path, mode);
      return path;
    } catch {}
  }
  throw new Error(`qq-wiki: ${label} is missing (looked in ${paths.join(", ")})`);
}

function resolveDsh(env, root) {
  if (env.QQ_WIKI_DSH) return requirePath(resolve(env.QQ_WIKI_DSH), "dsh executable", fsConstants.X_OK);
  return firstPresent(
    projectsRoots(env, root).map((projectsRoot) => resolve(projectsRoot, "qq-core/dsh/node_modules/.bin/dsh")),
    "dsh executable",
    fsConstants.X_OK,
  );
}

function resolveModels(env, root) {
  const candidates = env.QQ_WIKI_MODELS_ROOT
    ? [resolve(env.QQ_WIKI_MODELS_ROOT)]
    : projectsRoots(env, root).map((projectsRoot) => resolve(projectsRoot, "qq-models"));
  const manifestPath = firstPresent(
    candidates.map((candidate) => resolve(candidate, "package.json")),
    "qq-models package",
  );
  const path = dirname(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`qq-wiki: cannot read qq-models package at ${path}: ${error.message}`);
  }
  if (manifest.name !== "@hypermemetic-ai/qq-models") {
    throw new Error(`qq-wiki: expected @hypermemetic-ai/qq-models at ${path}`);
  }
  return path;
}

function resolvePluginHref(modelsRoot) {
  const plugin = requirePath(resolve(modelsRoot, "src/plugin.mjs"), "qq-models plugin");
  return pathToFileURL(plugin).href;
}

/** Inline the qq-models plugin specifier. DSH imports entry `name` before !!js. */
export function resolveWriterOverlay(template, pluginHref) {
  const needle = `name: ${MODELS_NAME_TOKEN}`;
  if (!template.includes(needle)) {
    throw new Error("qq-wiki: writer overlay is missing the qq-models name token");
  }
  return template.replaceAll(needle, `name: ${JSON.stringify(pluginHref)}`);
}

/** Build the exact headless DSH invocation without spawning it. */
export function modelPassPlan(cloneRoot, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const root = resolve(options.packageRoot ?? packageRoot);
  const command = resolveDsh(env, root);
  const modelsRoot = resolveModels(env, root);
  const overlay = resolve(root, "config/writer.patch.yml");
  requirePath(overlay, "writer overlay");
  const prompt = readFileSync(resolve(root, "prompts/writer.md"), "utf8");
  const pluginHref = resolvePluginHref(modelsRoot);
  const overlaySource = resolveWriterOverlay(readFileSync(overlay, "utf8"), pluginHref);

  return {
    command,
    args: ["--profile", "headless", "--patch", overlay, WRITER_TASK],
    overlaySource,
    pluginHref,
    cwd: resolve(cloneRoot),
    env: {
      ...env,
      QQ_DSH_PROVIDER: "openai-codex",
      QQ_DSH_MODEL: "gpt-5.6-sol",
      QQ_DSH_REASONING_EFFORT: "xhigh",
      DSH_PERMISSION_MODE: "workspace-write",
      QQ_WIKI_MODELS_ROOT: modelsRoot,
      QQ_WIKI_WRITER_PROMPT: prompt,
    },
  };
}

function waitForChild(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(
        `qq-wiki: model pass failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
      ));
    });
  });
}

/** Run the unattended inner writer pass. It never commits or publishes. */
export async function runModelPass(cloneRoot, options = {}) {
  const plan = modelPassPlan(cloneRoot, options);
  const overlayPath = join(tmpdir(), `qq-wiki-writer-${randomUUID()}.patch.yml`);
  writeFileSync(overlayPath, plan.overlaySource, { encoding: "utf8", mode: 0o600 });
  const args = ["--profile", "headless", "--patch", overlayPath, WRITER_TASK];
  try {
    const child = spawn(plan.command, args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: "inherit",
    });
    await waitForChild(child);
  } finally {
    try { unlinkSync(overlayPath); } catch {}
  }
}
