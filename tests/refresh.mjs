import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { parseCliArgs, parseRepositoryRegistry, repositoriesForCli, runCli } from "../src/cli.mjs";
import { INDEX_MAX_CHARS } from "../src/index.mjs";
import { modelPassPlan } from "../src/model-pass.mjs";
import { refreshRepository } from "../src/refresh.mjs";

const execFile = promisify(execFileCallback);
const roots = [];
const EVIDENCE = "# qq-index evidence packet\n\n## Tracked files (`git ls-files`)\n\n```text\n\"README.md\"\n\"src/app.mjs\"\n```\n";

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

async function createRepository({ readme = true } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "qq-index-refresh-test-"));
  roots.push(root);
  const origin = resolve(root, "origin.git");
  const source = resolve(root, "source");
  await command("git", ["init", "--bare", origin]);
  await command("git", ["init", "--initial-branch=main", source]);
  await git(source, "config", "user.name", "Live Checkout User");
  await git(source, "config", "user.email", "live@example.test");
  await put(source, "src/app.mjs", "export const value = 1;\n");
  if (readme) await put(source, "README.md", "# Existing README\n\n[App](src/app.mjs)\n");
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

function refreshOptions(overrides = {}) {
  return {
    logger: quietLogger(),
    harvestRepository: async () => EVIDENCE,
    ...overrides,
  };
}

try {
  {
    const { source, origin } = await createRepository();
    let modelCalls = 0;
    let receivedEvidence;
    const result = await refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot, options) => {
        modelCalls += 1;
        receivedEvidence = options.evidencePacket;
        await put(cloneRoot, "README.md", "# Generated index\n\n[App](src/app.mjs)\n");
      },
    }));
    assert.equal(result.status, "published");
    assert.equal(result.mode, "model");
    assert.equal(modelCalls, 1);
    assert.equal(receivedEvidence, EVIDENCE);
    assert.match(await readFile(resolve(source, "README.md"), "utf8"), /Generated index/);
    assert.equal(await git(source, "status", "--porcelain"), "");
    assert.equal(await git(source, "show", "-s", "--format=%an <%ae>", "HEAD"),
      "qqp-bot <qqp-bot@users.noreply.github.com>");
    assert.equal(await git(source, "show", "-s", "--format=%s", "HEAD"), "Refresh repository index");
    assert.equal(await git(source, "rev-parse", "HEAD"), await git(origin, "rev-parse", "main"));
    assert.equal(await git(source, "show", "--format=", "--name-only", "HEAD"), "README.md");

    const second = await refreshRepository(source, refreshOptions({
      runModelPass: async () => assert.fail("an unchanged source must not run the model"),
    }));
    assert.equal(second.status, "up-to-date");
    assert.equal(await git(source, "rev-parse", "HEAD"), result.commit);

    await commitAndPush(source, "src/app.mjs", "export const value = 2;\n", "Change source");
    const third = await refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot) => {
        modelCalls += 1;
        await put(cloneRoot, "README.md", "# Updated index\n\n[App](src/app.mjs)\n");
      },
    }));
    assert.equal(third.status, "published");
    assert.equal(modelCalls, 2);
    assert.match(await readFile(resolve(source, "README.md"), "utf8"), /Updated index/);

    await commitAndPush(source, "src/app.mjs", "export const value = 3;\n", "Change source again");
    const changedSource = await git(source, "rev-parse", "HEAD");
    const fourth = await refreshRepository(source, refreshOptions({
      runModelPass: async () => { modelCalls += 1; },
    }));
    assert.equal(fourth.status, "published");
    assert.equal(fourth.mode, "model-noop");
    assert.equal(fourth.parent, changedSource);
    assert.equal(modelCalls, 3);
    assert.notEqual(fourth.commit, changedSource);

    const fifth = await refreshRepository(source, refreshOptions({
      runModelPass: async () => assert.fail("a post-source model noop must not be repeated"),
    }));
    assert.equal(fifth.status, "up-to-date");
    assert.equal(await git(source, "rev-parse", "HEAD"), fourth.commit);
  }

  {
    const { source } = await createRepository({ readme: false });
    const result = await refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot) => {
        await put(cloneRoot, "README.md", "# First index\n\n[App](src/app.mjs)\n");
      },
    }));
    assert.equal(result.status, "published");
    assert.match(await readFile(resolve(source, "README.md"), "utf8"), /^# First index/);
  }

  {
    const { source, origin } = await createRepository();
    const parent = await git(source, "rev-parse", "HEAD");
    let modelCalls = 0;
    const result = await refreshRepository(source, refreshOptions({
      runModelPass: async () => { modelCalls += 1; },
    }));
    assert.deepEqual(
      { status: result.status, mode: result.mode, parent: result.parent },
      { status: "published", mode: "model-noop", parent },
    );
    assert.equal(modelCalls, 1);
    assert.notEqual(result.commit, parent);
    assert.equal(await git(source, "rev-parse", "HEAD"), result.commit);
    assert.equal(await git(origin, "rev-parse", "main"), result.commit);
    assert.equal(await git(source, "show", "--format=", "--name-only", "HEAD"), "");
    assert.equal(await git(source, "show", "-s", "--format=%T", "HEAD"),
      await git(source, "show", "-s", "--format=%T", parent));

    const second = await refreshRepository(source, refreshOptions({
      runModelPass: async () => assert.fail("a model-noop marker must advance the refresh cursor"),
    }));
    assert.equal(second.status, "up-to-date");
    assert.equal(await git(source, "rev-parse", "HEAD"), result.commit);

    await commitAndPush(source, "src/app.mjs", "export const value = 2;\n", "Source after noop marker");
    const third = await refreshRepository(source, refreshOptions({
      runModelPass: async () => { modelCalls += 1; },
    }));
    assert.equal(third.status, "published");
    assert.equal(third.mode, "model-noop");
    assert.equal(modelCalls, 2);

    await commitAndPush(source, "README.md", "# Human rewrite\n\n[App](src/app.mjs)\n", "Rewrite README manually");
    const fourth = await refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot) => {
        modelCalls += 1;
        await put(cloneRoot, "README.md", "# Regenerated index\n\n[App](src/app.mjs)\n");
      },
    }));
    assert.equal(fourth.status, "published");
    assert.equal(fourth.mode, "model");
    assert.equal(modelCalls, 3);
  }

  {
    const { source } = await createRepository();
    let releaseModel;
    let modelStarted;
    const started = new Promise((resolveStarted) => { modelStarted = resolveStarted; });
    const hold = new Promise((resolveHold) => { releaseModel = resolveHold; });
    const first = refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot) => {
        modelStarted();
        await hold;
        await put(cloneRoot, "README.md", "# Locked index\n\n[App](src/app.mjs)\n");
      },
    }));
    await started;
    const logger = quietLogger();
    const second = await refreshRepository(source, refreshOptions({
      logger,
      runModelPass: async () => assert.fail("busy refresh must not spawn a model"),
    }));
    assert.equal(second.status, "busy");
    assert.ok(logger.lines.some((line) => line.includes("already running")));
    releaseModel();
    await first;
  }

  {
    const { source } = await createRepository();
    await put(source, "dirty.txt", "dirty\n");
    await assert.rejects(() => refreshRepository(source, refreshOptions()), /must be clean/);
    await rm(resolve(source, "dirty.txt"));
    await git(source, "checkout", "-b", "not-main");
    await assert.rejects(() => refreshRepository(source, refreshOptions()), /must be on main/);
  }

  {
    const { source } = await createRepository();
    const initial = await git(source, "rev-parse", "HEAD");
    await assert.rejects(() => refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot) => {
        await put(cloneRoot, "README.md", "# Raced index\n\n[App](src/app.mjs)\n");
        await commitAndPush(source, "src/app.mjs", "export const value = 3;\n", "Move live main");
      },
    })), /live main moved/);
    assert.notEqual(await git(source, "rev-parse", "HEAD"), initial);
    assert.equal(await git(source, "show", "-s", "--format=%s", "HEAD"), "Move live main");
  }

  {
    const { source } = await createRepository();
    const parent = await git(source, "rev-parse", "HEAD");
    await assert.rejects(() => refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot) => {
        await put(cloneRoot, "README.md", "# Index\n\n[App](src/app.mjs)\n");
        await put(cloneRoot, "NOT-README.txt", "escaped\n");
      },
    })), /other than README\.md.*NOT-README/);
    assert.equal(await git(source, "rev-parse", "HEAD"), parent);
  }

  {
    const { source } = await createRepository();
    await commitAndPush(source, ".gitignore", "scratch.log\n", "Ignore scratch");
    await assert.rejects(() => refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot) => {
        await put(cloneRoot, "README.md", "# Index\n\n[App](src/app.mjs)\n");
        await put(cloneRoot, "scratch.log", "ignored but forbidden\n");
      },
    })), /other than README\.md.*scratch\.log/);
  }

  {
    const { source } = await createRepository();
    await assert.rejects(() => refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot) => {
        await put(cloneRoot, "README.md", "# Broken\n\n[Missing](missing.mjs)\n");
      },
    })), /linked path is not a regular file/);
  }

  {
    const { source } = await createRepository();
    await assert.rejects(() => refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot) => {
        await rm(resolve(cloneRoot, "README.md"));
        await symlink("src/app.mjs", resolve(cloneRoot, "README.md"));
      },
    })), /README\.md must be a regular file/);
  }

  {
    const { source } = await createRepository();
    await assert.rejects(() => refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot) => {
        await put(cloneRoot, "README.md", "x".repeat(INDEX_MAX_CHARS + 1));
      },
    })), /exceeds 10000 Unicode code points/);
  }

  {
    const { source } = await createRepository();
    await assert.rejects(() => refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot) => rm(resolve(cloneRoot, "README.md")),
    })), /did not produce README\.md/);
  }

  {
    const { source } = await createRepository();
    await assert.rejects(() => refreshRepository(source, refreshOptions({
      validateIndex: async (cloneRoot) => put(cloneRoot, "validation-leak.txt", "leak\n"),
      runModelPass: async (cloneRoot) => put(cloneRoot, "README.md", "# Index\n\n[App](src/app.mjs)\n"),
    })), /other than README\.md.*validation-leak/);
  }

  {
    const { source } = await createRepository();
    const parent = await git(source, "rev-parse", "HEAD");
    await git(source, "remote", "set-url", "origin", resolve(source, "missing-origin.git"));
    await assert.rejects(() => refreshRepository(source, refreshOptions({
      runModelPass: async (cloneRoot) => put(cloneRoot, "README.md", "# Index\n\n[App](src/app.mjs)\n"),
    })), /git .*push origin main failed/);
    assert.equal(await git(source, "rev-parse", "HEAD"), parent, "failed push rolls live main back");
    assert.equal(await git(source, "status", "--porcelain"), "");
  }

  {
    const base = resolve("/tmp/projects");
    assert.deepEqual(parseRepositoryRegistry("a\n# c\n\na\n/path/b\n", { projectsRoot: base }), [
      resolve(base, "a"),
      "/path/b",
    ]);
    assert.deepEqual(parseCliArgs([]), { repo: undefined });
    assert.deepEqual(parseCliArgs(["--repo", "a"]), { repo: "a" });
    assert.deepEqual(parseCliArgs(["--help"]), { help: true });
    assert.throws(() => parseCliArgs(["--bad"]), /qq-index: invalid arguments/);

    const registryRoot = await mkdtemp(resolve(tmpdir(), "qq-index-registry-test-"));
    roots.push(registryRoot);
    const registry = resolve(registryRoot, "repositories");
    await writeFile(registry, "a\nb\nc\nd\ne\n");
    const selection = await repositoriesForCli([], { projectsRoot: base, registryPath: registry });
    assert.equal(selection.repositories.length, 5);
    let active = 0;
    let maximum = 0;
    const seen = [];
    await runCli([], {
      projectsRoot: base,
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

    const logger = quietLogger();
    await assert.rejects(() => runCli(["--repo", "bad"], {
      projectsRoot: base,
      logger,
      refreshRepository: async () => { throw new Error("boom"); },
    }), /1 refresh failed/);
    assert.ok(logger.lines.some((line) => line.includes("qq-index:") && line.includes("boom")));
  }

  {
    const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
    assert.throws(
      () => modelPassPlan("/tmp/qq-index-clone", { packageRoot: repositoryRoot }),
      /requires a non-empty evidence packet/,
    );
    const plan = modelPassPlan("/tmp/qq-index-clone", {
      packageRoot: repositoryRoot,
      evidencePacket: EVIDENCE,
    });
    assert.equal(typeof plan.then, "undefined");
    assert.equal(plan.cwd, "/tmp/qq-index-clone");
    assert.deepEqual(plan.args.slice(0, 4), [
      "--profile", "headless", "--patch", resolve(repositoryRoot, "config/writer.patch.yml"),
    ]);
    assert.equal(plan.args.at(-1), "Write this repository's README index from the supplied evidence packet.");
    assert.equal(plan.env.QQ_DSH_PROVIDER, "openai-codex");
    assert.equal(plan.env.QQ_DSH_MODEL, "gpt-5.6-sol");
    assert.equal(plan.env.QQ_DSH_REASONING_EFFORT, "xhigh");
    assert.match(plan.env.QQ_INDEX_MODELS_ROOT, /qq-models$/);
    assert.match(plan.env.QQ_INDEX_WORKFLOWS_ROOT, /qq-workflows$/);

    const prompt = plan.env.QQ_INDEX_WRITER_PROMPT;
    assert.match(prompt, /complete and only evidence/);
    assert.match(prompt, /Do not inspect the checkout/);
    assert.match(prompt, /only\s+model-facing tool is Mini Docs/);
    assert.match(prompt, /Replace only `README\.md`/);
    assert.match(prompt, /# qq-index evidence packet/);
    assert.equal(prompt.endsWith(`${EVIDENCE.trimEnd()}\n`), true);
    assert.equal((prompt.match(/echo COMPLETE_DOCS_AND_EXIT/g) ?? []).length, 1);
    assert.doesNotMatch(prompt, /^## Traps$/m);

    assert.match(plan.modelsPluginHref, /^file:\/\/.*\/qq-models\/src\/plugin\.mjs$/);
    assert.match(plan.miniDocsPluginHref, /^file:\/\/.*\/qq-workflows\/src\/mini-docs\.mjs$/);
    assert.match(plan.writerBootPluginHref, /^file:\/\/.*\/src\/writer-boot\.mjs$/);
    assert.match(plan.overlaySource, /id: qq-index-models\n      name: "file:\/\/.*\/src\/plugin\.mjs"/);
    assert.match(plan.overlaySource, /id: qq-mini-docs\n      name: "file:\/\/.*\/src\/mini-docs\.mjs"/);
    assert.match(plan.overlaySource, /id: qq-index-writer-boot\n      name: "file:\/\/.*\/src\/writer-boot\.mjs"/);
    assert.equal(plan.overlaySource.includes("__QQ_INDEX_"), false);

    const overlay = await readFile(resolve(repositoryRoot, "config/writer.patch.yml"), "utf8");
    assert.match(overlay, /id: approval\n  config:\n    policy: never/);
    assert.match(overlay, /id: tool-fs\n  disabled: true/);
    assert.match(overlay, /id: tool-fs-search\n  disabled: true/);
    assert.doesNotMatch(overlay, /id: tool-bash\n  disabled: true/);
    assert.match(overlay, /id: qq-mini-docs\n      name: __QQ_INDEX_MINI_DOCS_PLUGIN__/);
    assert.match(overlay, /id: qq-index-writer-boot\n      name: __QQ_INDEX_WRITER_BOOT_PLUGIN__/);
  }

  {
    const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
    const workflowsOverride = await mkdtemp(resolve(tmpdir(), "qq-index-workflows-override-"));
    roots.push(workflowsOverride);
    await put(workflowsOverride, "package.json", JSON.stringify({
      name: "@hypermemetic-ai/qq-workflows",
      type: "module",
    }));
    await put(workflowsOverride, "src/mini-docs.mjs", "export function miniDocsSetup() {}\n");
    const plan = modelPassPlan("/tmp/qq-index-clone", {
      packageRoot: repositoryRoot,
      evidencePacket: EVIDENCE,
      env: { QQ_INDEX_WORKFLOWS_ROOT: workflowsOverride },
    });
    assert.equal(plan.env.QQ_INDEX_WORKFLOWS_ROOT, workflowsOverride);
    assert.equal(
      plan.miniDocsPluginHref,
      new URL("src/mini-docs.mjs", `${pathToFileURL(workflowsOverride).href}/`).href,
    );
  }

  console.log("refresh program: ok");
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
