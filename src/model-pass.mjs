import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { harvestRepository } from "./harvest.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRITER_TASK = "Write this repository's README index from the supplied evidence packet.";
export const MODELS_NAME_TOKEN = "__QQ_INDEX_MODELS_ROOT__";
export const WRITER_BOOT_NAME_TOKEN = "__QQ_INDEX_WRITER_BOOT_PLUGIN__";

function requirePath(path, label, mode = fsConstants.F_OK) {
  try {
    accessSync(path, mode);
  } catch {
    throw new Error(`qq-index: ${label} is missing: ${path}`);
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
  throw new Error(`qq-index: ${label} is missing (looked in ${paths.join(", ")})`);
}

function resolveDsh(env, root) {
  if (env.QQ_INDEX_DSH) return requirePath(resolve(env.QQ_INDEX_DSH), "dsh executable", fsConstants.X_OK);
  return firstPresent(
    projectsRoots(env, root).map((projectsRoot) => resolve(projectsRoot, "qq-core/dsh/node_modules/.bin/dsh")),
    "dsh executable",
    fsConstants.X_OK,
  );
}

function resolveSiblingPackage(env, root, { envName, sibling, packageName }) {
  const candidates = env[envName]
    ? [resolve(env[envName])]
    : projectsRoots(env, root).map((projectsRoot) => resolve(projectsRoot, sibling));
  const manifestPath = firstPresent(
    candidates.map((candidate) => resolve(candidate, "package.json")),
    `${sibling} package`,
  );
  const path = dirname(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`qq-index: cannot read ${sibling} package at ${path}: ${error.message}`);
  }
  if (manifest.name !== packageName) {
    throw new Error(`qq-index: expected ${packageName} at ${path}`);
  }
  return path;
}

function resolveModels(env, root) {
  return resolveSiblingPackage(env, root, {
    envName: "QQ_INDEX_MODELS_ROOT",
    sibling: "qq-models",
    packageName: "@hypermemetic-ai/qq-models",
  });
}

function resolveWorkflows(env, root) {
  return resolveSiblingPackage(env, root, {
    envName: "QQ_INDEX_WORKFLOWS_ROOT",
    sibling: "qq-workflows",
    packageName: "@hypermemetic-ai/qq-workflows",
  });
}

function resolvePluginHref(root, relativePath, label) {
  return pathToFileURL(requirePath(resolve(root, relativePath), label)).href;
}

/** Inline plugin specifiers. DSH imports entry `name` before evaluating !!js. */
export function resolveWriterOverlay(template, pluginHrefs) {
  const replacements = [
    [MODELS_NAME_TOKEN, pluginHrefs.models, "qq-models"],
    [WRITER_BOOT_NAME_TOKEN, pluginHrefs.writerBoot, "qq-index writer boot"],
  ];
  let source = template;
  for (const [token, href, label] of replacements) {
    const needle = `name: ${token}`;
    if (!source.includes(needle)) {
      throw new Error(`qq-index: writer overlay is missing the ${label} name token`);
    }
    source = source.replaceAll(needle, `name: ${JSON.stringify(href)}`);
  }
  return source;
}

/** Build the exact headless DSH invocation without spawning it. */
export function modelPassPlan(cloneRoot, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const evidencePacket = options.evidencePacket ?? env.QQ_INDEX_EVIDENCE_PACKET;
  if (typeof evidencePacket !== "string" || evidencePacket.trim() === "") {
    throw new Error("qq-index: model pass requires a non-empty evidence packet");
  }
  const root = resolve(options.packageRoot ?? packageRoot);
  const command = resolveDsh(env, root);
  const modelsRoot = resolveModels(env, root);
  const workflowsRoot = resolveWorkflows(env, root);
  const overlay = resolve(root, "config/writer.patch.yml");
  requirePath(overlay, "writer overlay");
  const contract = readFileSync(resolve(root, "prompts/writer.md"), "utf8").trimEnd();
  const prompt = `${contract}\n\n${evidencePacket.trimEnd()}\n`;
  const pluginHrefs = {
    models: resolvePluginHref(modelsRoot, "src/plugin.mjs", "qq-models plugin"),
    writerBoot: resolvePluginHref(root, "src/writer-boot.mjs", "qq-index writer boot plugin"),
  };
  const overlaySource = resolveWriterOverlay(readFileSync(overlay, "utf8"), pluginHrefs);

  return {
    command,
    args: ["--profile", "headless", "--patch", overlay, WRITER_TASK],
    overlaySource,
    pluginHrefs,
    modelsPluginHref: pluginHrefs.models,
    writerBootPluginHref: pluginHrefs.writerBoot,
    cwd: resolve(cloneRoot),
    env: {
      ...env,
      QQ_DSH_PROVIDER: "openai-codex",
      QQ_DSH_MODEL: "gpt-5.6-sol",
      QQ_DSH_REASONING_EFFORT: "xhigh",
      QQ_INDEX_MODELS_ROOT: modelsRoot,
      QQ_INDEX_WORKFLOWS_ROOT: workflowsRoot,
      QQ_INDEX_WRITER_PROMPT: prompt,
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
        `qq-index: model pass failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
      ));
    });
  });
}

/** Run the unattended inner writer pass. It never commits or publishes. */
export async function runModelPass(cloneRoot, options = {}) {
  const evidencePacket = options.evidencePacket ?? await harvestRepository(cloneRoot);
  const plan = modelPassPlan(cloneRoot, { ...options, evidencePacket });
  const overlayPath = join(tmpdir(), `qq-index-writer-${randomUUID()}.patch.yml`);
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
