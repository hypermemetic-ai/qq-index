import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  launcherConfig,
  planSessionIndexDaemon,
} from "../src/session-index-launcher.mjs";

const execute = promisify(execFile);
const unit = await readFile(resolve("systemd", "user", "qq-session-indexd.service"), "utf8");
assert.match(unit, /^Description=QQ durable session-history index daemon$/mu);
assert.match(unit, /^UMask=0077$/mu);
assert.match(unit, /^RuntimeDirectory=qq-index$/mu);
assert.match(unit, /^RuntimeDirectoryMode=0700$/mu);
assert.match(unit, /^StateDirectory=qq-index$/mu);
assert.match(unit, /^StateDirectoryMode=0700$/mu);
assert.match(unit, /^ExecStart=.*qq-session-indexd-launch$/mu);
assert.match(unit, /^Restart=on-failure$/mu);
assert.match(unit, /^RestartSec=2s$/mu);
assert.match(unit, /^TimeoutStopSec=15s$/mu);
assert.doesNotMatch(unit, /qq-index-refresh/u);

const root = await mkdtemp(resolve(tmpdir(), "qq-session-index-launcher-generated-"));
try {
  const runtime = resolve(root, "runtime");
  const state = resolve(root, "state");
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  const daemonPath = resolve(root, "qq-session-indexd-generated");
  await writeFile(daemonPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const socketPath = resolve(runtime, "session-index.sock");
  const databasePath = resolve(state, "session-index.db");

  const parsed = launcherConfig([
    "--daemon", daemonPath,
    "--socket", socketPath,
    "--database", databasePath,
    "--readers", "3",
    "--queue-capacity", "17",
    "--plan",
  ], {}, resolve(root, "bin"));
  assert.equal(parsed.planOnly, true);
  assert.equal(parsed.readers, 3);
  assert.equal(parsed.queueCapacity, 17);
  const create = await planSessionIndexDaemon(parsed);
  assert.equal(Object.isFrozen(create), true);
  assert.equal(Object.isFrozen(create.arguments), true);
  assert.equal(create.mode, "create");
  assert.deepEqual(create.arguments, [
    "--socket", socketPath,
    "--database", databasePath,
    "--create",
    "--readers", "3",
    "--queue-capacity", "17",
  ]);
  await assert.rejects(lstat(databasePath), (error) => error.code === "ENOENT");
  await assert.rejects(lstat(socketPath), (error) => error.code === "ENOENT");

  // A private owner-owned single-link regular target is delegated to the daemon's
  // schema/application-id validation via explicit --open; the launcher never adopts it.
  await writeFile(databasePath, "generated daemon-owned placeholder", { mode: 0o600 });
  const open = await planSessionIndexDaemon(parsed);
  assert.equal(open.mode, "open");
  assert.equal(open.arguments.includes("--open"), true);
  assert.equal(open.arguments.includes("--create"), false);

  await chmod(databasePath, 0o644);
  await assert.rejects(planSessionIndexDaemon(parsed), /owner-only/u);
  await chmod(databasePath, 0o600);
  const hardLink = resolve(state, "hard-link.db");
  await link(databasePath, hardLink);
  await assert.rejects(planSessionIndexDaemon(parsed), /exactly one hard link/u);
  await rm(hardLink);
  await rm(databasePath);

  const symlinkTarget = resolve(state, "elsewhere.db");
  await writeFile(symlinkTarget, "not an index", { mode: 0o600 });
  await symlink(symlinkTarget, databasePath);
  await assert.rejects(planSessionIndexDaemon(parsed), /non-symlink regular file/u);
  await rm(databasePath);
  await mkdir(databasePath, { mode: 0o700 });
  await assert.rejects(planSessionIndexDaemon(parsed), /regular file/u);
  await rm(databasePath, { recursive: true });

  await writeFile(socketPath, "must not be removed", { mode: 0o600 });
  await assert.rejects(planSessionIndexDaemon(parsed), /must not already exist/u);
  assert.equal((await lstat(socketPath)).isFile(), true, "launcher must not unlink a socket-path occupant");
  await rm(socketPath);

  const realAncestor = resolve(root, "real-ancestor");
  const linkedAncestor = resolve(root, "linked-ancestor");
  await mkdir(realAncestor, { mode: 0o700 });
  await symlink(realAncestor, linkedAncestor);
  await assert.rejects(planSessionIndexDaemon({
    ...parsed,
    socketPath: resolve(linkedAncestor, "linked.sock"),
  }), /symlink ancestors/u);

  await assert.rejects(planSessionIndexDaemon({ ...parsed, socketPath: "relative.sock" }), /absolute/u);
  await assert.rejects(planSessionIndexDaemon({ ...parsed, readers: 17 }), /1\.\.16/u);
  await assert.rejects(planSessionIndexDaemon({ ...parsed, queueCapacity: 0 }), /1\.\.1024/u);
  assert.throws(() => launcherConfig(["--readers", "01"], {}, root), /integer/u);
  assert.throws(() => launcherConfig(["--readers", "1", "--readers", "2"], {}, root), /only once/u);

  const cli = await execute(resolve("bin", "qq-session-indexd-launch"), [
    "--daemon", daemonPath,
    "--socket", socketPath,
    "--database", databasePath,
    "--readers", "2",
    "--queue-capacity", "8",
    "--plan",
  ], { cwd: resolve(".") });
  const cliPlan = JSON.parse(cli.stdout);
  assert.equal(cliPlan.mode, "create");
  assert.equal(cliPlan.daemonPath, daemonPath);
  assert.deepEqual(cliPlan.arguments.slice(-4), ["--readers", "2", "--queue-capacity", "8"]);
  assert.equal(cli.stderr, "");

  console.log("session-index launcher safety: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
