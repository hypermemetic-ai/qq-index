import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { harvestRepository as defaultHarvestRepository } from "./harvest.mjs";
import { validateIndex } from "./index.mjs";
import { runModelPass as defaultRunModelPass } from "./model-pass.mjs";

const execFile = promisify(execFileCallback);
const BOT_NAME = "qqp-bot";
const BOT_EMAIL = "qqp-bot@users.noreply.github.com";
const COMMIT_MESSAGE = "Refresh repository index";
const LOCK_NAME = "qq-index-refresh.lock";
const INDEX_PATH = "README.md";
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

function errorText(error) {
  return String(error?.stderr || error?.stdout || error?.message || error).trim();
}

async function run(command, args, options = {}) {
  try {
    return await execFile(command, args, {
      encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
      maxBuffer: MAX_GIT_OUTPUT,
      ...options,
    });
  } catch (error) {
    const detail = errorText(error);
    throw new Error(`qq-index: ${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`, {
      cause: error,
    });
  }
}

async function git(repoRoot, args, options = {}) {
  return run("git", ["-C", repoRoot, ...args], options);
}

async function gitText(repoRoot, args) {
  return (await git(repoRoot, args)).stdout.trim();
}

function nulPaths(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  return text.split("\0").filter(Boolean);
}

function isIndexPath(path) {
  return path === INDEX_PATH;
}

async function requireMainAndClean(repoRoot, expectedRevision) {
  let branch;
  try {
    branch = await gitText(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    throw new Error("qq-index: source checkout must be on main (detached HEAD)");
  }
  if (branch !== "main") throw new Error(`qq-index: source checkout must be on main (found ${branch})`);
  const revision = await gitText(repoRoot, ["rev-parse", "HEAD"]);
  if (expectedRevision !== undefined && revision !== expectedRevision) {
    throw new Error("qq-index: live main moved during refresh; retry on the next tick");
  }
  const status = (await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  if (status !== "") throw new Error("qq-index: source checkout must be clean");
  return revision;
}

function lockHolderScript() {
  return [
    "process.stdout.write('locked\\n');",
    "process.stdin.resume();",
    "process.stdin.on('end', () => process.exit(0));",
  ].join("");
}

async function acquireLock(lockPath) {
  const child = spawn("flock", ["-n", lockPath, process.execPath, "-e", lockHolderScript()], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let stdout = "";
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once("error", (error) => fail(new Error(`qq-index: cannot acquire refresh lock: ${error.message}`)));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (!settled && stdout.includes("locked\n")) {
        settled = true;
        resolvePromise({
          busy: false,
          async release() {
            if (child.exitCode !== null) return;
            child.stdin.end();
            if (child.exitCode === null) await once(child, "exit");
          },
        });
      }
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code === 1) resolvePromise({ busy: true, release: async () => {} });
      else reject(new Error(`qq-index: refresh lock helper exited with code ${code}`));
    });
  });
}

async function commonGitDir(repoRoot) {
  const raw = await gitText(repoRoot, ["rev-parse", "--git-common-dir"]);
  return resolve(repoRoot, raw);
}

async function latestIndexCommit(cloneRoot) {
  // A validated model no-op is an empty refresh commit, so its cursor cannot be
  // found with a path-limited log. Still require it to follow the latest README
  // commit so an older bot commit cannot bless a later human README rewrite.
  const marker = await gitText(cloneRoot, [
    "log", "-1", "--fixed-strings", `--grep=${COMMIT_MESSAGE}`, `--author=${BOT_EMAIL}`,
    "--format=%H%x00%an%x00%ae%x00%s",
  ]);
  if (!marker) return null;
  const [revision, author, email, subject] = marker.split("\0");
  if (author !== BOT_NAME || email !== BOT_EMAIL || subject !== COMMIT_MESSAGE) return null;

  const latestReadmeRevision = await gitText(cloneRoot, [
    "log", "-1", "--format=%H", "--", INDEX_PATH,
  ]);
  if (!latestReadmeRevision) return null;
  if (latestReadmeRevision === revision) return revision;

  const mergeBase = await gitText(cloneRoot, ["merge-base", latestReadmeRevision, revision]);
  if (mergeBase !== latestReadmeRevision) return null;
  const markerDiff = await git(cloneRoot, [
    "diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-m", "--root", "-z", revision,
  ], { encoding: null });
  return nulPaths(markerDiff.stdout).length === 0 ? revision : null;
}

async function hasSourceCommitsSinceIndex(cloneRoot) {
  try {
    const stat = await lstat(resolve(cloneRoot, INDEX_PATH));
    if (!stat.isFile() || stat.isSymbolicLink()) return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return true;
    throw error;
  }

  const lastIndexCommit = await latestIndexCommit(cloneRoot);
  if (lastIndexCommit === null) return true;
  const revisions = (await gitText(cloneRoot, ["rev-list", `${lastIndexCommit}..HEAD`]))
    .split("\n")
    .filter(Boolean);
  for (const revision of revisions) {
    const output = await git(cloneRoot, [
      "diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-m", "--root", "-z", revision,
    ], { encoding: null });
    if (nulPaths(output.stdout).some((path) => !isIndexPath(path))) return true;
  }
  return false;
}

async function changedWorktreePaths(cloneRoot) {
  const tracked = await git(cloneRoot, ["diff", "--name-only", "--no-renames", "-z", "HEAD"], {
    encoding: null,
  });
  // No excludes: an ignored file created by the model still violates the boundary.
  const untracked = await git(cloneRoot, ["ls-files", "--others", "-z"], { encoding: null });
  return [...new Set([...nulPaths(tracked.stdout), ...nulPaths(untracked.stdout)])];
}

async function requireIndexOnlyWorktree(cloneRoot) {
  const paths = await changedWorktreePaths(cloneRoot);
  const invalid = paths.filter((path) => !isIndexPath(path));
  if (invalid.length > 0) {
    throw new Error(`qq-index: model pass touched paths other than README.md: ${invalid.join(", ")}`);
  }
  return paths;
}

async function requireReadableIndex(cloneRoot) {
  let stat;
  try {
    stat = await lstat(resolve(cloneRoot, INDEX_PATH));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new Error("qq-index: model pass did not produce README.md");
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("qq-index: README.md must be a regular file");
  }
}

async function stagedPaths(cloneRoot) {
  const output = await git(cloneRoot, [
    "diff", "--cached", "--name-only", "--no-renames", "-z", "--diff-filter=ACDMRTUXB",
  ], { encoding: null });
  return nulPaths(output.stdout);
}

async function indexMode(cloneRoot, path) {
  const output = await gitText(cloneRoot, ["ls-files", "--stage", "--", path]);
  return output ? output.split(/\s+/, 1)[0] : "";
}

async function requireRegularStagedIndex(cloneRoot) {
  const paths = await stagedPaths(cloneRoot);
  if (paths.length !== 1 || paths[0] !== INDEX_PATH) {
    throw new Error(`qq-index: refresh must stage only README.md (found ${paths.join(", ") || "nothing"})`);
  }
  const mode = await indexMode(cloneRoot, INDEX_PATH);
  if (!/^100\d{3}$/.test(mode)) {
    throw new Error("qq-index: staged README.md is not a regular file");
  }
  const stat = await lstat(resolve(cloneRoot, INDEX_PATH));
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("qq-index: staged README.md is not a regular file");
  }
}

async function commitIndex(cloneRoot, { allowEmpty = false } = {}) {
  const commitArgs = ["commit", "--no-gpg-sign"];
  if (allowEmpty) commitArgs.push("--allow-empty");
  commitArgs.push("-m", COMMIT_MESSAGE);
  await git(cloneRoot, [
    "-c", `user.name=${BOT_NAME}`,
    "-c", `user.email=${BOT_EMAIL}`,
    ...commitArgs,
  ]);
  return gitText(cloneRoot, ["rev-parse", "HEAD"]);
}

async function publish(repoRoot, cloneRoot, sourceRevision, writerCommit) {
  await requireMainAndClean(repoRoot, sourceRevision);
  await git(repoRoot, ["fetch", "--no-tags", cloneRoot, writerCommit]);
  await requireMainAndClean(repoRoot, sourceRevision);
  await git(repoRoot, ["merge", "--ff-only", writerCommit]);
  try {
    await git(repoRoot, ["push", "origin", "main"]);
  } catch (error) {
    const current = await gitText(repoRoot, ["rev-parse", "HEAD"]).catch(() => "");
    const status = (await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
      .catch(() => ({ stdout: "dirty" }))).stdout;
    if (current === writerCommit && status === "") {
      await git(repoRoot, ["reset", "--hard", sourceRevision]).catch(() => {});
    }
    throw error;
  }
}

/** Refresh and mechanically publish one repository's README index. */
export async function refreshRepository(repoRoot, options = {}) {
  const root = resolve(repoRoot);
  const logger = options.logger ?? console;
  const sourceRevision = await requireMainAndClean(root);
  const lock = await acquireLock(join(await commonGitDir(root), LOCK_NAME));
  if (lock.busy) {
    logger.log(`qq-index: refresh already running for ${root}`);
    return { status: "busy" };
  }

  let temporaryRoot;
  try {
    await requireMainAndClean(root, sourceRevision);
    temporaryRoot = await mkdtemp(join(tmpdir(), "qq-index-refresh-"));
    const cloneRoot = join(temporaryRoot, "repo");
    await run("git", ["clone", "--local", "--no-hardlinks", "--branch", "main", "--single-branch", root, cloneRoot]);
    const cloneRevision = await gitText(cloneRoot, ["rev-parse", "HEAD"]);
    if (cloneRevision !== sourceRevision) throw new Error("qq-index: isolated clone did not start at source main");

    const needsModel = await hasSourceCommitsSinceIndex(cloneRoot);
    if (!needsModel) {
      await requireReadableIndex(cloneRoot);
      await (options.validateIndex ?? validateIndex)(cloneRoot);
      logger.log(`qq-index: up to date ${root}`);
      return { status: "up-to-date", parent: sourceRevision };
    }

    const harvest = options.harvestRepository ?? defaultHarvestRepository;
    const evidencePacket = await harvest(cloneRoot);
    const modelPass = options.runModelPass ?? defaultRunModelPass;
    await modelPass(cloneRoot, { evidencePacket });
    await requireIndexOnlyWorktree(cloneRoot);
    await requireReadableIndex(cloneRoot);
    await (options.validateIndex ?? validateIndex)(cloneRoot);
    const changedPaths = await requireIndexOnlyWorktree(cloneRoot);

    if (changedPaths.length === 0) {
      const writerCommit = await commitIndex(cloneRoot, { allowEmpty: true });
      await publish(root, cloneRoot, sourceRevision, writerCommit);
      logger.log(`qq-index: refreshed ${root} (model produced no index change)`);
      return {
        status: "published",
        mode: "model-noop",
        parent: sourceRevision,
        commit: writerCommit,
      };
    }

    await git(cloneRoot, ["reset", "--mixed", sourceRevision]);
    await git(cloneRoot, ["add", "--", INDEX_PATH]);
    await requireRegularStagedIndex(cloneRoot);
    const writerCommit = await commitIndex(cloneRoot);
    await publish(root, cloneRoot, sourceRevision, writerCommit);
    logger.log(`qq-index: refreshed ${root}`);
    return {
      status: "published",
      mode: "model",
      parent: sourceRevision,
      commit: writerCommit,
    };
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    await lock.release();
  }
}

export const internals = Object.freeze({
  BOT_NAME,
  BOT_EMAIL,
  COMMIT_MESSAGE,
  LOCK_NAME,
  INDEX_PATH,
  hasSourceCommitsSinceIndex,
  isIndexPath,
});
