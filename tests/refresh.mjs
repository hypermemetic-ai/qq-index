import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { INDEX_MAX_CHARS } from "../src/index.mjs";
import { parseRepositoryRegistry, repositoriesForCli, runCli } from "../src/cli.mjs";
import { modelPassPlan } from "../src/model-pass.mjs";
import { refreshRepository } from "../src/refresh.mjs";

const execFile = promisify(execFileCallback);
const roots = [];
const FIXED_TIME = "2026-08-14T12:34:56.789Z";

async function command(commandName, args, options = {}) {
  const result = await execFile(commandName, args, { encoding: "utf8", ...options });
  return result.stdout.trim();
}

async function git(root, ...args) {
  return command("git", ["-C", root, ...args]);
}

async function put(root, path, content) {
  const absolute = resolve(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function createRepository({ wiki = true } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "qq-wiki-refresh-test-"));
  roots.push(root);
  const origin = resolve(root, "origin.git");
  const source = resolve(root, "source");
  await command("git", ["init", "--bare", origin]);
  await command("git", ["init", "--initial-branch=main", source]);
  await git(source, "config", "user.name", "Live Checkout User");
  await git(source, "config", "user.email", "live@example.test");
  await put(source, "README.md", "# Target\n");
  if (wiki) await put(
    source,
    "wiki/index.md",
    "# Target orientation\nRefreshed: 2025-01-01T00:00:00.000Z\n\n- Source wins.\n",
  );
  await git(source, "add", "-A");
  await git(source, "commit", "-m", "Initial source");
  await git(source, "remote", "add", "origin", origin);
  await git(source, "push", "-u", "origin", "main");
  return { root, origin, source };
}

async function commitAndPush(source, path, content, message) {
  await put(source, path, content);
  await git(source, "add", "-A");
  await git(source, "commit", "-m", message);
  await git(source, "push", "origin", "main");
}

function quietLogger() {
  const lines = [];
  return {
    lines,
    log(line) { lines.push(String(line)); },
    error(line) { lines.push(String(line)); },
  };
}

async function rejectsMessage(operation, pattern) {
  await assert.rejects(operation, pattern);
}

try {
  {
    const { source, origin } = await createRepository();
    let modelCalls = 0;
    const result = await refreshRepository(source, {
      now: FIXED_TIME,
      logger: quietLogger(),
      runModelPass: async () => { modelCalls += 1; },
    });
    assert.equal(result.mode, "stamp-only");
    assert.equal(modelCalls, 0);
    const index = await readFile(resolve(source, "wiki/index.md"), "utf8");
    assert.deepEqual(index.split("\n").slice(0, 3), [
      "# Target orientation",
      `Refreshed: ${FIXED_TIME}`,
      "",
    ]);
    assert.equal(index.match(/^Refreshed:/gm)?.length, 1);
    assert.equal(await git(source, "status", "--porcelain"), "");
    assert.equal(await git(source, "show", "-s", "--format=%an <%ae>", "HEAD"),
      "qqp-bot <qqp-bot@users.noreply.github.com>");
    assert.equal(await git(source, "show", "-s", "--format=%s", "HEAD"), "Refresh architect wiki");
    assert.equal(await git(source, "rev-parse", "HEAD"), await git(origin, "rev-parse", "main"));

    // A subsequent run after a wiki-only writer commit remains stamp-only.
    const second = await refreshRepository(source, {
      now: "2026-08-14T20:00:00.000Z",
      logger: quietLogger(),
      runModelPass: async () => { modelCalls += 1; },
    });
    assert.equal(second.mode, "stamp-only");
    assert.equal(modelCalls, 0);
  }

  {
    const { source } = await createRepository();
    await put(source, "wiki/index.md", "# CRLF orientation\r\nRefreshed: 2025-01-01T00:00:00.000Z\r\n\r\nBody\r\n");
    await git(source, "add", "wiki/index.md");
    await git(source, "commit", "-m", "Use CRLF wiki");
    await git(source, "push", "origin", "main");
    await refreshRepository(source, { now: FIXED_TIME, logger: quietLogger() });
    const index = await readFile(resolve(source, "wiki/index.md"), "utf8");
    assert.equal(index, `# CRLF orientation\r\nRefreshed: ${FIXED_TIME}\r\n\r\nBody\r\n`);
  }

  {
    const { source } = await createRepository();
    await commitAndPush(source, "src/app.mjs", "export const changed = true;\n", "Change source");
    let modelCalls = 0;
    const result = await refreshRepository(source, {
      now: FIXED_TIME,
      logger: quietLogger(),
      runModelPass: async (cloneRoot) => {
        modelCalls += 1;
        await put(cloneRoot, "wiki/ownership.md", "# Ownership\n");
        await put(cloneRoot, "wiki/index.md", "# Target orientation\n\n- [Ownership](ownership.md)\n");
      },
    });
    assert.equal(result.mode, "model");
    assert.equal(modelCalls, 1);
    assert.match(await readFile(resolve(source, "wiki/index.md"), "utf8"), /ownership\.md/);
  }

  {
    const { source } = await createRepository({ wiki: false });
    let modelCalls = 0;
    const result = await refreshRepository(source, {
      now: FIXED_TIME,
      logger: quietLogger(),
      runModelPass: async (cloneRoot) => {
        modelCalls += 1;
        await put(cloneRoot, "wiki/index.md", "# First orientation\n\n- Source wins.\n");
      },
    });
    assert.equal(result.mode, "model");
    assert.equal(modelCalls, 1);
    assert.match(await readFile(resolve(source, "wiki/index.md"), "utf8"), /^# First orientation\nRefreshed:/);
  }

  {
    const { source } = await createRepository();
    await commitAndPush(source, "source.txt", "changed\n", "Source needs model");
    let releaseModel;
    let modelStarted;
    const started = new Promise((resolveStarted) => { modelStarted = resolveStarted; });
    const hold = new Promise((resolveHold) => { releaseModel = resolveHold; });
    const first = refreshRepository(source, {
      now: FIXED_TIME,
      logger: quietLogger(),
      runModelPass: async () => {
        modelStarted();
        await hold;
      },
    });
    await started;
    const logger = quietLogger();
    const second = await refreshRepository(source, {
      now: FIXED_TIME,
      logger,
      runModelPass: async () => assert.fail("busy refresh must not spawn a model"),
    });
    assert.equal(second.status, "busy");
    assert.ok(logger.lines.some((line) => line.includes("already running")));
    releaseModel();
    await first;
  }

  {
    const { source } = await createRepository();
    await put(source, "dirty.txt", "dirty\n");
    await rejectsMessage(() => refreshRepository(source, { logger: quietLogger() }), /must be clean/);
    await rm(resolve(source, "dirty.txt"));
    await git(source, "checkout", "-b", "not-main");
    await rejectsMessage(() => refreshRepository(source, { logger: quietLogger() }), /must be on main/);
  }

  {
    const { source } = await createRepository();
    await commitAndPush(source, "source.txt", "first\n", "Source needs model");
    await rejectsMessage(() => refreshRepository(source, {
      now: FIXED_TIME,
      logger: quietLogger(),
      runModelPass: async () => {
        await commitAndPush(source, "source.txt", "moved\n", "Move live main");
      },
    }), /live main moved/);
    assert.equal(await readFile(resolve(source, "source.txt"), "utf8"), "moved\n");
    assert.notEqual(await git(source, "show", "-s", "--format=%s", "HEAD"), "Refresh architect wiki");
  }

  {
    const { source } = await createRepository();
    await commitAndPush(source, "source.txt", "changed\n", "Source needs model");
    const parent = await git(source, "rev-parse", "HEAD");
    await rejectsMessage(() => refreshRepository(source, {
      now: FIXED_TIME,
      logger: quietLogger(),
      runModelPass: async (cloneRoot) => {
        await put(cloneRoot, "wiki/index.md", "# Target orientation\n");
        await put(cloneRoot, "NOT-WIKI.txt", "escaped\n");
      },
    }), /outside wiki.*NOT-WIKI/);
    assert.equal(await git(source, "rev-parse", "HEAD"), parent);
    assert.equal(await git(source, "status", "--porcelain"), "");
  }

  {
    const { source } = await createRepository();
    await commitAndPush(source, "source.txt", "changed\n", "Source needs model");
    const parent = await git(source, "rev-parse", "HEAD");
    await rejectsMessage(() => refreshRepository(source, {
      now: FIXED_TIME,
      logger: quietLogger(),
      runModelPass: async (cloneRoot) => {
        await put(cloneRoot, "wiki/index.md", "# Target orientation\n\n- [Missing](missing.md)\n");
      },
    }), /linked page is not a regular file/);
    assert.equal(await git(source, "rev-parse", "HEAD"), parent);
  }

  {
    const { source } = await createRepository();
    await commitAndPush(source, "source.txt", "changed\n", "Source needs model");
    const parent = await git(source, "rev-parse", "HEAD");
    await rejectsMessage(() => refreshRepository(source, {
      now: FIXED_TIME,
      logger: quietLogger(),
      runModelPass: async (cloneRoot) => {
        await symlink("../README.md", resolve(cloneRoot, "wiki/unlinked.md"));
      },
    }), /not a regular file.*unlinked\.md/);
    assert.equal(await git(source, "rev-parse", "HEAD"), parent);
  }

  {
    const { source } = await createRepository();
    const title = "# Target orientation\n";
    const exactCap = title + "x".repeat(INDEX_MAX_CHARS - [...title].length);
    await put(source, "wiki/index.md", exactCap);
    await git(source, "add", "wiki/index.md");
    await git(source, "commit", "-m", "Fill index cap");
    await git(source, "push", "origin", "main");
    const parent = await git(source, "rev-parse", "HEAD");
    await rejectsMessage(() => refreshRepository(source, {
      now: FIXED_TIME,
      logger: quietLogger(),
      runModelPass: async () => assert.fail("wiki-only history is stamp-only"),
    }), /exceeds 10000 Unicode code points/);
    assert.equal(await git(source, "rev-parse", "HEAD"), parent);
  }

  {
    const parsed = parseRepositoryRegistry("\n# first wave\nqq-core\n/opt/qq-ui\nqq-core\n", {
      home: "/home/tester",
    });
    assert.deepEqual(parsed, ["/home/tester/projects/qq-core", "/opt/qq-ui"]);
    const one = await repositoriesForCli(["--repo", "qq-relay"], { home: "/home/tester" });
    assert.deepEqual(one.repositories, ["/home/tester/projects/qq-relay"]);
    const absolute = await repositoriesForCli(["--repo", "/srv/repo"], { home: "/home/tester" });
    assert.deepEqual(absolute.repositories, ["/srv/repo"]);

    const registryRoot = await mkdtemp(resolve(tmpdir(), "qq-wiki-registry-test-"));
    roots.push(registryRoot);
    const registry = resolve(registryRoot, "repositories");
    await writeFile(registry, "a\nb\nc\nd\ne\n");
    let active = 0;
    let maximum = 0;
    const seen = [];
    await runCli([], {
      home: registryRoot,
      registryPath: registry,
      logger: quietLogger(),
      refreshRepository: async (repository) => {
        seen.push(repository);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((done) => setTimeout(done, 10));
        active -= 1;
        return { status: "published" };
      },
    });
    assert.equal(maximum, 3);
    assert.equal(seen.length, 5);
  }

  {
    const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
    const plan = modelPassPlan("/tmp/qq-wiki-clone", { packageRoot: repositoryRoot });
    assert.equal(typeof plan.then, "undefined");
    assert.equal(plan.cwd, "/tmp/qq-wiki-clone");
    assert.deepEqual(plan.args.slice(0, 4), ["--profile", "headless", "--patch", resolve(repositoryRoot, "config/writer.patch.yml")]);
    assert.equal(plan.args.at(-1), "Refresh this repository's architect orientation wiki.");
    assert.equal(plan.env.QQ_DSH_PROVIDER, "openai-codex");
    assert.equal(plan.env.QQ_DSH_MODEL, "gpt-5.6-sol");
    assert.equal(plan.env.QQ_DSH_REASONING_EFFORT, "xhigh");
    assert.equal(plan.env.DSH_PERMISSION_MODE, "workspace-write");
    assert.equal(plan.env.DSH_HOME, process.env.DSH_HOME);
    assert.match(plan.env.QQ_WIKI_WRITER_PROMPT, /Forced phases/);
    assert.match(plan.env.QQ_WIKI_MODELS_ROOT, /qq-models$/);
    const overlay = await readFile(resolve(repositoryRoot, "config/writer.patch.yml"), "utf8");
    assert.match(overlay, /id: approval\n  config:\n    policy: never/);
    assert.match(overlay, /id: agent-instructions\n  disabled: true/);
    assert.match(overlay, /id: tool-subagent\n  disabled: true/);
  }

  console.log("refresh program: ok");
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
