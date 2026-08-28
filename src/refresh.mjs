import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { validateWiki } from "./index.mjs";
import { runModelPass as defaultRunModelPass } from "./model-pass.mjs";

const execFile = promisify(execFileCallback);
const BOT_NAME = "qqp-bot";
const BOT_EMAIL = "qqp-bot@users.noreply.github.com";
const COMMIT_MESSAGE = "Refresh architect wiki";
const LOCK_NAME = "qq-wiki-refresh.lock";
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
    throw new Error(`qq-wiki: ${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`, {
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

function nulPaths(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : buffer;
  return text.split("\0").filter(Boolean);
}

function isWikiPath(path) {
  return path.startsWith("wiki/") && !path.split("/").includes("..");
}

async function requireMainAndClean(repoRoot, expectedRevision) {
  let branch;
  try {
    branch = await gitText(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    throw new Error("qq-wiki: source checkout must be on main (detached HEAD)");
  }
  if (branch !== "main") throw new Error(`qq-wiki: source checkout must be on main (found ${branch})`);
  const revision = await gitText(repoRoot, ["rev-parse", "HEAD"]);
  if (expectedRevision !== undefined && revision !== expectedRevision) {
    throw new Error("qq-wiki: live main moved during refresh; retry on the next tick");
  }
  const status = (await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  if (status !== "") throw new Error("qq-wiki: source checkout must be clean");
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
    child.once("error", (error) => fail(new Error(`qq-wiki: cannot acquire refresh lock: ${error.message}`)));
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
      else reject(new Error(`qq-wiki: refresh lock helper exited with code ${code}`));
    });
  });
}

async function commonGitDir(repoRoot) {
  const raw = await gitText(repoRoot, ["rev-parse", "--git-common-dir"]);
  return resolve(repoRoot, raw);
}

async function hasSourceCommitsSinceWiki(cloneRoot) {
  try {
    await lstat(resolve(cloneRoot, "wiki/index.md"));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return true;
    throw error;
  }

  const lastWikiCommit = await gitText(cloneRoot, ["log", "-1", "--format=%H", "--", "wiki/"]);
  if (!lastWikiCommit) return true;
  const revisions = (await gitText(cloneRoot, ["rev-list", `${lastWikiCommit}..HEAD`]))
    .split("\n")
    .filter(Boolean);
  for (const revision of revisions) {
    const output = await git(cloneRoot, [
      "diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-m", "--root", "-z", revision,
    ], { encoding: null });
    if (nulPaths(output.stdout).some((path) => !isWikiPath(path))) return true;
  }
  return false;
}

function refreshedIso(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("qq-wiki: refresh clock did not return a valid date");
  return date.toISOString();
}

export async function stampIndex(repoRoot, now = () => new Date()) {
  const indexPath = resolve(repoRoot, "wiki/index.md");
  let text;
  try {
    text = await readFile(indexPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("qq-wiki: model pass did not create wiki/index.md");
    throw error;
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (titleIndex === -1) throw new Error("qq-wiki: wiki/index.md needs a '# …' title");
  const withoutOldStamp = lines.filter((line, index) => (
    index === titleIndex || !/^Refreshed:\s+\S.*$/.test(line)
  ));
  const adjustedTitleIndex = withoutOldStamp.findIndex((line) => /^#\s+\S/.test(line));
  withoutOldStamp.splice(adjustedTitleIndex + 1, 0, `Refreshed: ${refreshedIso(now)}`);
  await writeFile(indexPath, `${withoutOldStamp.join(eol)}${hadFinalNewline ? eol : ""}`, "utf8");
}

async function changedWorktreePaths(cloneRoot) {
  const tracked = await git(cloneRoot, ["diff", "--name-only", "--no-renames", "-z", "HEAD"], {
    encoding: null,
  });
  const untracked = await git(cloneRoot, ["ls-files", "--others", "--exclude-standard", "-z"], {
    encoding: null,
  });
  return [...new Set([...nulPaths(tracked.stdout), ...nulPaths(untracked.stdout)])];
}

async function requireWikiOnlyWorktree(cloneRoot) {
  const invalid = (await changedWorktreePaths(cloneRoot)).filter((path) => !isWikiPath(path));
  if (invalid.length > 0) {
    throw new Error(`qq-wiki: model pass touched paths outside wiki/: ${invalid.join(", ")}`);
  }
}

async function stagedPaths(cloneRoot) {
  const output = await git(cloneRoot, [
    "diff", "--cached", "--name-only", "--no-renames", "-z", "--diff-filter=ACDMRTUXB",
  ], { encoding: null });
  return nulPaths(output.stdout);
}

async function treeMode(cloneRoot, revision, path) {
  const output = await gitText(cloneRoot, ["ls-tree", revision, "--", path]);
  return output ? output.split(/\s+/, 1)[0] : "";
}

async function indexMode(cloneRoot, path) {
  const output = await gitText(cloneRoot, ["ls-files", "--stage", "--", path]);
  return output ? output.split(/\s+/, 1)[0] : "";
}

async function requireRegularStagedWiki(cloneRoot, sourceRevision) {
  const paths = await stagedPaths(cloneRoot);
  if (paths.length === 0) throw new Error("qq-wiki: refresh produced no staged wiki changes");
  for (const path of paths) {
    if (!isWikiPath(path)) throw new Error(`qq-wiki: staged path is outside wiki/: ${path}`);
    const currentMode = await indexMode(cloneRoot, path);
    const oldMode = await treeMode(cloneRoot, sourceRevision, path);
    const modes = [currentMode, oldMode].filter(Boolean);
    if (modes.length === 0 || modes.some((mode) => !/^100\d{3}$/.test(mode))) {
      throw new Error(`qq-wiki: staged wiki path is not a regular file: ${path}`);
    }
    if (currentMode) {
      const stat = await lstat(resolve(cloneRoot, path));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`qq-wiki: staged wiki path is not a regular file: ${path}`);
      }
    }
  }
  return paths;
}

async function commitWiki(cloneRoot) {
  await git(cloneRoot, [
    "-c", `user.name=${BOT_NAME}`,
    "-c", `user.email=${BOT_EMAIL}`,
    "commit", "--no-gpg-sign", "-m", COMMIT_MESSAGE,
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

/** Refresh and mechanically publish one repository's architect wiki. */
export async function refreshRepository(repoRoot, options = {}) {
  const root = resolve(repoRoot);
  const logger = options.logger ?? console;
  const sourceRevision = await requireMainAndClean(root);
  const lock = await acquireLock(join(await commonGitDir(root), LOCK_NAME));
  if (lock.busy) {
    logger.log(`qq-wiki: refresh already running for ${root}`);
    return { status: "busy" };
  }

  let temporaryRoot;
  try {
    // Recheck after lock acquisition so a waiting caller never clones stale state.
    await requireMainAndClean(root, sourceRevision);
    temporaryRoot = await mkdtemp(join(tmpdir(), "qq-wiki-refresh-"));
    const cloneRoot = join(temporaryRoot, "repo");
    await run("git", ["clone", "--local", "--no-hardlinks", "--branch", "main", "--single-branch", root, cloneRoot]);
    const cloneRevision = await gitText(cloneRoot, ["rev-parse", "HEAD"]);
    if (cloneRevision !== sourceRevision) throw new Error("qq-wiki: isolated clone did not start at source main");

    const needsModel = await hasSourceCommitsSinceWiki(cloneRoot);
    if (needsModel) {
      const modelPass = options.runModelPass ?? defaultRunModelPass;
      await modelPass(cloneRoot);
    }
    await stampIndex(cloneRoot, options.now ?? (() => new Date()));
    await requireWikiOnlyWorktree(cloneRoot);
    await (options.validateWiki ?? validateWiki)(cloneRoot);
    await requireWikiOnlyWorktree(cloneRoot);

    // Restore the source revision as the index baseline, then stage only wiki/.
    await git(cloneRoot, ["reset", "--mixed", sourceRevision]);
    await git(cloneRoot, ["add", "-A", "--", "wiki/"]);
    await requireRegularStagedWiki(cloneRoot, sourceRevision);
    const writerCommit = await commitWiki(cloneRoot);
    await publish(root, cloneRoot, sourceRevision, writerCommit);
    logger.log(`qq-wiki: refreshed ${root} (${needsModel ? "model" : "stamp-only"})`);
    return {
      status: "published",
      mode: needsModel ? "model" : "stamp-only",
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
  hasSourceCommitsSinceWiki,
  isWikiPath,
});
