import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { harvestRepository } from "../src/harvest.mjs";
import {
  analyzeRepository,
  builtInExclusionReason,
  bulkPathLimit,
  candidateClearsGates,
  HISTORY_SHADOW_POLICY,
  retainEligibleEvents,
  selectFutureAnnotations,
  selectScopeCandidates,
} from "../src/history-shadow.mjs";
import {
  parseHistoryShadowArgs,
  parseShadowRegistry,
  repositoriesForHistoryShadow,
  runHistoryShadowCli,
} from "../src/history-shadow-cli.mjs";

const execFile = promisify(execFileCallback);
const roots = [];

function cleanGitEnvironment() {
  const env = { ...process.env };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_WORK_TREE",
  ]) delete env[name];
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };
}

async function command(name, args, options = {}) {
  return execFile(name, args, { encoding: "utf8", env: cleanGitEnvironment(), ...options });
}

async function git(root, ...args) {
  return (await command("git", ["-C", root, ...args])).stdout.trim();
}

async function put(root, path, contents) {
  const target = resolve(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function repository(prefix = "qq-index-history-shadow-test-") {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  roots.push(root);
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "History Test");
  await git(root, "config", "user.email", "history@example.test");
  return root;
}

async function commit(root, message) {
  await git(root, "add", "-A");
  await git(root, "commit", "-m", message);
}

function event(revision, ...paths) {
  return { revision, paths };
}

function validCandidate(paths, retainedSupport = 6) {
  return {
    mode: "pair-relative-v1",
    paths,
    counts: {
      opportunities: 12,
      left: 12,
      right: 6,
      shared: 6,
      sharedInRetainedWindow: retainedSupport,
    },
    ratios: {
      accompaniment: { numerator: 6, denominator: 6 },
      overlap: { numerator: 6, denominator: 12 },
    },
    bands: ["older", "middle", "newer"].map((name) => ({
      name, events: 4, opportunities: 4, left: 4, right: 2, shared: 2,
    })),
  };
}

function alternatingPairEvents(left, right, count = 12) {
  const oldest = Array.from({ length: count }, (_, index) => event(
    `p${index}`,
    ...(index % 2 === 0 ? [left, right] : [left]),
  ));
  return oldest.reverse();
}

function allCandidatePaths(result) {
  return Object.values(result.selectors).flatMap((selector) => selector.candidates.flatMap((candidate) => candidate.paths));
}

try {
  assert.equal(HISTORY_SHADOW_POLICY.limits.scanRevisions, 400);
  assert.equal(HISTORY_SHADOW_POLICY.limits.retainedDiffs, 200);
  assert.equal(HISTORY_SHADOW_POLICY.limits.pairRelativeEvents, 24);
  assert.equal(HISTORY_SHADOW_POLICY.limits.futureAnnotations, 2);
  assert.equal(HISTORY_SHADOW_POLICY.primarySelector, "pair-relative-v1");
  assert.equal(HISTORY_SHADOW_POLICY.challengerSelector, "repository-window-v1");
  assert.deepEqual(HISTORY_SHADOW_POLICY.evaluationArms, [
    "production-baseline", "hygiene-only", "pair-relative-v1", "repository-window-v1",
  ]);
  assert.equal(HISTORY_SHADOW_POLICY.switchDecision.requiredMechanicalTruthPercent, 100);
  assert.equal(bulkPathLimit(1), 20);
  assert.equal(bulkPathLimit(250), 50);
  assert.equal(bulkPathLimit(10_000), 100);

  assert.equal(builtInExclusionReason("README.md"), "qq-index");
  assert.equal(builtInExclusionReason(".qq-index/history-shadow.json"), "qq-index");
  assert.equal(builtInExclusionReason("nested/package-lock.json"), "lockfile");
  assert.equal(builtInExclusionReason("app/dist/bundle.js"), "generated-contract");
  assert.equal(builtInExclusionReason("lib/vendor/x.c"), "vendored-contract");
  assert.equal(builtInExclusionReason("docs/guide.md"), null);

  {
    const bulkPaths = Array.from({ length: 21 }, (_, index) => `bulk/p${String(index).padStart(2, "0")}.mjs`);
    const currentPaths = [
      "README.md", "package-lock.json", "dist/out.js", "vendor/lib.c", "generated/out.js",
      "src/a.mjs", "tests/a.mjs", ...bulkPaths,
    ];
    const attributesByPath = new Map([["generated/out.js", { generated: "set" }]]);
    const retained = retainEligibleEvents({
      currentPaths,
      attributesByPath,
      revisionEvents: [
        event("empty"),
        event("index", "README.md"),
        event("locks", "package-lock.json"),
        event("generated", "dist/out.js", "generated/out.js"),
        event("vendor", "vendor/lib.c"),
        event("gone", "deleted/old.mjs"),
        event("bulk-over", ...bulkPaths),
        event("bulk-boundary", ...bulkPaths.slice(0, 20)),
        event("pair", "src/a.mjs", "tests/a.mjs"),
      ],
    });
    assert.equal(retained.status, "ok");
    assert.equal(retained.audit.revisionsScanned, 9);
    assert.equal(retained.audit.retainedEligibleDiffs, 2);
    assert.deepEqual(retained.events.map(({ revision }) => revision), ["bulk-boundary", "pair"]);
    assert.deepEqual(retained.audit.omittedDiffs, {
      empty: 1,
      "no-current-regular-path": 1,
      "excluded-only": 4,
      bulk: 1,
      "older-after-retention": 0,
    });
    assert.equal(retained.audit.excludedPathTouches["qq-index"], 1);
    assert.equal(retained.audit.excludedPathTouches.lockfile, 1);
    assert.equal(retained.audit.excludedPathTouches["generated-contract"], 1);
    assert.equal(retained.audit.excludedPathTouches["generated-attribute"], 1);
    assert.equal(retained.audit.excludedPathTouches["vendored-contract"], 1);
    assert.equal(retained.audit.excludedPathTouches.nonCurrent, 1);
  }

  {
    const bounded = retainEligibleEvents({
      currentPaths: ["src/a.mjs"],
      revisionEvents: Array.from({ length: 405 }, (_, index) => event(`r${index}`, "src/a.mjs")),
    });
    assert.equal(bounded.audit.revisionsScanned, 400);
    assert.equal(bounded.audit.retainedEligibleDiffs, 200);
    assert.equal(bounded.audit.retentionLimitReached, true);
    assert.equal(bounded.audit.scanLimitReached, true);
    assert.equal(bounded.audit.omittedDiffs["older-after-retention"], 200);
    assert.equal(bounded.audit.retainedRevisions.at(-1), "r199");
  }

  {
    const left = "src/a.mjs";
    const right = "tests/a.mjs";
    const sharedPositions = new Set([0, 3, 7, 10, 14, 18]);
    const leftOnlyPositions = new Set([1, 8, 13, 19]);
    const exactBoundaryOldest = Array.from({ length: 20 }, (_, index) => event(
      `boundary-${index}`,
      ...(sharedPositions.has(index) ? [left, right] : leftOnlyPositions.has(index) ? [left] : [right]),
    ));
    const result = selectScopeCandidates([...exactBoundaryOldest].reverse(), "pair-relative-v1");
    assert.equal(result.status, "ok");
    assert.equal(result.qualifiedPairs, 1);
    const [candidate] = result.candidates;
    assert.deepEqual(candidate.counts, {
      opportunities: 20,
      left: 10,
      right: 16,
      shared: 6,
      sharedInRetainedWindow: 6,
    });
    assert.deepEqual(candidate.ratios.accompaniment, { numerator: 6, denominator: 10 });
    assert.deepEqual(candidate.ratios.overlap, { numerator: 6, denominator: 20 });
    assert.deepEqual(candidate.bands.map(({ name, shared }) => [name, shared]), [
      ["older", 2], ["middle", 2], ["newer", 2],
    ]);
    assert.equal(candidateClearsGates(candidate), true);

    const overlapBelow = selectScopeCandidates([
      event("right-only-extra", right), ...[...exactBoundaryOldest].reverse(),
    ], "pair-relative-v1");
    assert.equal(overlapBelow.qualifiedPairs, 0, "6/21 is below the 3/10 overlap boundary");

    const accompanimentBelowOldest = [
      ...Array.from({ length: 6 }, (_, index) => event(`shared-${index}`, left, right)),
      ...Array.from({ length: 5 }, (_, index) => event(`left-${index}`, left)),
      ...Array.from({ length: 5 }, (_, index) => event(`right-${index}`, right)),
    ];
    const accompanimentBelow = selectScopeCandidates(
      accompanimentBelowOldest.reverse(), "pair-relative-v1",
    );
    assert.equal(accompanimentBelow.qualifiedPairs, 0, "6/11 is below the 3/5 accompaniment boundary");

    const missingNewerBand = selectScopeCandidates([
      ...Array.from({ length: 6 }, (_, index) => event(`new-left-${index}`, left)),
      ...Array.from({ length: 6 }, (_, index) => event(`old-shared-${index}`, left, right)),
    ], "pair-relative-v1");
    assert.equal(missingNewerBand.qualifiedPairs, 0);

    const tooFewOpportunities = selectScopeCandidates(
      alternatingPairEvents(left, right, 11), "pair-relative-v1",
    );
    assert.equal(tooFewOpportunities.qualifiedPairs, 0);
  }

  {
    const latestTwentyFour = alternatingPairEvents("src/capped.mjs", "tests/capped.mjs", 24);
    const base = selectScopeCandidates(latestTwentyFour, "pair-relative-v1");
    const withOlderUnionEvents = selectScopeCandidates([
      ...latestTwentyFour,
      ...Array.from({ length: 10 }, (_, index) => event(`older-${index}`, "tests/capped.mjs")),
    ], "pair-relative-v1");
    assert.deepEqual(withOlderUnionEvents, base, "pair-relative facts stop at the latest 24 A-or-B events");
  }

  {
    const pairEvents = alternatingPairEvents("src/main.mjs", "tests/main.mjs");
    const unrelated = Array.from({ length: 48 }, (_, index) => event(`unrelated-${index}`, `docs/d${index}.md`));
    const history = [...pairEvents, ...unrelated];
    const primary = selectScopeCandidates(history, "pair-relative-v1");
    const challenger = selectScopeCandidates(history, "repository-window-v1");
    assert.equal(primary.qualifiedPairs, 1);
    assert.equal(challenger.qualifiedPairs, 0, "repository thirds see support only in the newest third");
    assert.deepEqual(
      selectScopeCandidates([event("unrelated-new", "docs/new.md"), ...history], "pair-relative-v1"),
      primary,
      "an unrelated singleton does not alter pair-relative candidate facts",
    );
  }

  {
    const events = [];
    for (let pairIndex = 0; pairIndex < 5; pairIndex += 1) {
      events.push(...alternatingPairEvents(`src${pairIndex}/a.mjs`, `test${pairIndex}/a.mjs`));
    }
    const result = selectScopeCandidates(events, "pair-relative-v1");
    assert.equal(result.qualifiedPairs, 5);
    assert.equal(result.candidates.length, 4);
    const paths = result.candidates.flatMap((candidate) => candidate.paths);
    assert.equal(new Set(paths).size, paths.length, "bounded candidate output never reuses a path");
  }

  {
    const baseline = alternatingPairEvents("src/stable.mjs", "tests/stable.mjs");
    const baseRetention = retainEligibleEvents({
      currentPaths: ["README.md", "package-lock.json", "src/stable.mjs", "tests/stable.mjs"],
      revisionEvents: baseline,
    });
    const noisyRetention = retainEligibleEvents({
      currentPaths: ["README.md", "package-lock.json", "src/stable.mjs", "tests/stable.mjs"],
      revisionEvents: [
        event("readme-noise", "README.md"),
        event("lock-noise", "package-lock.json"),
        ...baseline,
      ],
    });
    assert.deepEqual(noisyRetention.events, baseRetention.events);
    assert.deepEqual(
      selectScopeCandidates(noisyRetention.events, "pair-relative-v1"),
      selectScopeCandidates(baseRetention.events, "pair-relative-v1"),
    );
  }

  {
    const closeWinner = validCandidate(["src/a.mjs", "tests/a.mjs"], 10);
    const closeRunner = validCandidate(["src/a.mjs", "docs/a.md"], 9);
    assert.deepEqual(selectFutureAnnotations([
      { path: "src/a.mjs", independentlyJustified: true },
    ], [closeWinner, closeRunner]), [], "a one-event runner-up margin abstains");

    const clearWinner = validCandidate(["src/a.mjs", "tests/a.mjs"], 11);
    const routeTwo = validCandidate(["src/b.mjs", "tests/b.mjs"], 8);
    const routeThree = validCandidate(["src/c.mjs", "tests/c.mjs"], 7);
    const selected = selectFutureAnnotations([
      { path: "ignored/no.mjs", independentlyJustified: false },
      { path: "src/a.mjs", independentlyJustified: true },
      { path: "tests/a.mjs", independentlyJustified: true },
      { path: "src/b.mjs", independentlyJustified: true },
      { path: "src/c.mjs", independentlyJustified: true },
    ], [closeRunner, clearWinner, routeTwo, routeThree]);
    assert.deepEqual(selected.map(({ route, companion }) => ({ route, companion })), [
      { route: "src/a.mjs", companion: "tests/a.mjs" },
      { route: "src/b.mjs", companion: "tests/b.mjs" },
    ]);
    assert.equal(selected.length, 2);
    assert.equal(new Set(selected.flatMap(({ route, companion }) => [route, companion])).size, 4);

    const sharedWinner = validCandidate(["src/first.mjs", "shared/z.mjs"], 12);
    const reusedWinner = validCandidate(["src/second.mjs", "shared/z.mjs"], 10);
    const secondRunner = validCandidate(["src/second.mjs", "tests/second.mjs"], 8);
    const thirdRoute = validCandidate(["src/third.mjs", "tests/third.mjs"], 7);
    const noFallthrough = selectFutureAnnotations([
      { path: "src/first.mjs", independentlyJustified: true },
      { path: "src/second.mjs", independentlyJustified: true },
      { path: "src/third.mjs", independentlyJustified: true },
    ], [sharedWinner, reusedWinner, secondRunner, thirdRoute]);
    assert.deepEqual(noFallthrough.map(({ route, companion }) => ({ route, companion })), [
      { route: "src/first.mjs", companion: "shared/z.mjs" },
      { route: "src/third.mjs", companion: "tests/third.mjs" },
    ], "path reuse skips a route instead of promoting its lower-ranked runner-up");
  }

  {
    const root = await repository("qq-index-history-mainline-");
    let serial = 0;
    const touchPair = async (label) => {
      serial += 1;
      await put(root, "src/a.mjs", `export const a = ${serial};\n`);
      await put(root, "tests/a.mjs", `export const t = ${serial};\n`);
      await put(root, "generated/out.js", `generated ${serial}\n`);
      await commit(root, label);
    };
    const touchLeft = async (label) => {
      serial += 1;
      await put(root, "src/a.mjs", `export const a = ${serial};\n`);
      await commit(root, label);
    };

    await put(root, ".gitattributes", "generated/out.js generated\n");
    await put(root, "README.md", "# Initial\n");
    await put(root, "src/a.mjs", "export const a = 0;\n");
    await put(root, "tests/a.mjs", "export const t = 0;\n");
    await put(root, "generated/out.js", "generated 0\n");
    await put(root, "deleted/old.mjs", "old\n");
    await put(root, "renames/old-name.mjs", "rename\n");
    await symlink("src/a.mjs", resolve(root, "linked-a.mjs"));
    await commit(root, "root pair");

    await touchPair("shared 1");
    await rm(resolve(root, "deleted/old.mjs"));
    await touchLeft("left 1 and delete");
    await touchPair("shared 2");
    await git(root, "mv", "renames/old-name.mjs", "renames/new-name.mjs");
    await touchLeft("left 2 and rename");
    await touchPair("shared 3");

    await git(root, "checkout", "-b", "feature");
    await touchPair("branch shared 1");
    await touchPair("branch shared 2");
    await git(root, "checkout", "main");
    await put(root, "notes/main.txt", "main line\n");
    await commit(root, "main-only integration predecessor");
    await git(root, "merge", "--no-ff", "feature", "-m", "merge feature");

    await touchLeft("left 3");
    await touchPair("shared 4");
    await touchLeft("left 4");
    await touchLeft("left 5");
    await touchPair("shared 5");
    await put(root, "README.md", "# Generated orientation\n");
    await commit(root, "README only");
    await put(root, "package-lock.json", "{}\n");
    await commit(root, "lock only");

    const beforeStatus = await git(root, "status", "--porcelain=v1");
    const beforeHead = await git(root, "rev-parse", "HEAD");
    const packetBefore = await harvestRepository(root);
    const result = await analyzeRepository(root);
    const packetAfter = await harvestRepository(root);
    assert.equal(result.status, "ok");
    assert.equal(result.head, beforeHead);
    assert.equal(await git(root, "status", "--porcelain=v1"), beforeStatus);
    assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
    assert.equal(packetAfter, packetBefore, "shadow analysis cannot alter the production evidence packet");

    const firstParentCount = Number(await git(root, "rev-list", "--first-parent", "--count", "HEAD"));
    assert.equal(result.history.revisionsScanned, firstParentCount);
    assert.equal(firstParentCount, 15, "two interior branch commits are not traversed");
    assert.equal(result.history.retainedEligibleDiffs, 13);
    assert.equal(result.history.omittedDiffs["excluded-only"], 2);
    assert.ok(result.history.excludedPathTouches["generated-attribute"] >= 7);
    assert.equal(result.history.excludedPathTouches["qq-index"], 2);
    assert.equal(result.history.excludedPathTouches.lockfile, 1);

    const primary = result.selectors["pair-relative-v1"];
    const pair = primary.candidates.find((candidate) => candidate.paths.includes("src/a.mjs")
      && candidate.paths.includes("tests/a.mjs"));
    assert.ok(pair, "mainline repeated pair qualifies");
    assert.equal(pair.counts.opportunities, 12);
    assert.equal(pair.counts.shared, 7, "root and merge count once; two branch commits do not count");
    assert.deepEqual(pair.bands.map(({ shared }) => shared), [3, 2, 2]);
    const paths = allCandidatePaths(result);
    assert.ok(!paths.includes("generated/out.js"));
    assert.ok(!paths.includes("README.md"));
    assert.ok(!paths.includes("package-lock.json"));
    assert.ok(!paths.includes("deleted/old.mjs"));
    assert.ok(!paths.includes("renames/old-name.mjs"));
    assert.ok(!paths.includes("linked-a.mjs"), "tracked symlinks are not current regular-file evidence");
  }

  {
    const root = await repository("qq-index-history-unusual-");
    const unusual = "odd\nsegment/a\".txt";
    const companion = "tests/b\tfile.txt";
    for (let index = 0; index < 12; index += 1) {
      await put(root, unusual, `odd ${index}\n`);
      if (index % 2 === 0) await put(root, companion, `companion ${index}\n`);
      await commit(root, `ordinal ${index}`);
    }
    const statusBefore = await git(root, "status", "--porcelain=v1");
    const first = await analyzeRepository(root);
    const second = await analyzeRepository(root);
    assert.deepEqual(second, first);
    const candidate = first.selectors["pair-relative-v1"].candidates[0];
    assert.deepEqual(candidate.paths, [unusual, companion]);
    assert.equal(candidate.counts.opportunities, 12);
    assert.equal(candidate.counts.shared, 6);

    const executable = resolve(new URL("../bin/qq-index-history-shadow", import.meta.url).pathname);
    const firstOutput = (await command("node", [executable, "--repo", root])).stdout;
    const secondOutput = (await command("node", [executable, "--repo", root])).stdout;
    assert.equal(secondOutput, firstOutput, "CLI JSON is byte-identical at the same revision");
    assert.ok(!firstOutput.includes("odd\nsegment"), "a filename newline is JSON escaped");
    assert.ok(!firstOutput.includes("b\tfile"), "a filename tab is JSON escaped");
    const parsed = JSON.parse(firstOutput);
    assert.equal(parsed.schemaVersion, HISTORY_SHADOW_POLICY.schemaVersion);
    assert.equal(parsed.shadowOnly, true);
    assert.equal(parsed.publicationEnabled, false);
    assert.ok(parsed.evaluationArms.includes("hygiene-only"));
    assert.deepEqual(
      parsed.repositories[0].selectors["pair-relative-v1"].candidates[0].paths,
      [unusual, companion],
    );
    assert.equal(await git(root, "status", "--porcelain=v1"), statusBefore);
  }

  {
    const base = resolve("/example/projects");
    assert.deepEqual(parseHistoryShadowArgs([]), { repo: undefined });
    assert.deepEqual(parseHistoryShadowArgs(["--repo", "one"]), { repo: "one" });
    assert.deepEqual(parseHistoryShadowArgs(["-h"]), { help: true });
    assert.throws(() => parseHistoryShadowArgs(["--bad"]), /invalid arguments/);
    assert.deepEqual(parseShadowRegistry("one\n# ignored\n\none\n/two\n", { projectsRoot: base }), [
      resolve(base, "one"), "/two",
    ]);

    const registryRoot = await mkdtemp(resolve(tmpdir(), "qq-index-history-registry-"));
    roots.push(registryRoot);
    const registryPath = resolve(registryRoot, "repositories");
    await writeFile(registryPath, "one\ntwo\none\n");
    const selection = await repositoriesForHistoryShadow([], { projectsRoot: base, registryPath });
    assert.deepEqual(selection.repositories, [resolve(base, "one"), resolve(base, "two")]);

    const outputs = [];
    const stdout = { write(value) { outputs.push(String(value)); } };
    const report = await runHistoryShadowCli([], {
      projectsRoot: base,
      registryPath,
      stdout,
      analyzeRepository: async (repositoryPath) => ({
        schemaVersion: HISTORY_SHADOW_POLICY.schemaVersion,
        policyVersion: HISTORY_SHADOW_POLICY.version,
        repository: repositoryPath,
        status: "ok",
        shadowOnly: true,
        publicationEnabled: false,
        selectors: {},
      }),
    });
    assert.deepEqual(report.repositories.map(({ repository: repositoryPath }) => repositoryPath), [
      resolve(base, "one"), resolve(base, "two"),
    ]);
    assert.deepEqual(JSON.parse(outputs.join("")), report);

    const errorOutput = [];
    const errorReport = await runHistoryShadowCli(["--repo", "one"], {
      projectsRoot: base,
      stdout: { write(value) { errorOutput.push(String(value)); } },
      analyzeRepository: async () => { throw new Error("bounded failure"); },
    });
    assert.equal(errorReport.repositories[0].status, "error");
    assert.equal(errorReport.repositories[0].publicationEnabled, false);
    assert.match(errorReport.repositories[0].message, /bounded failure/);
    assert.deepEqual(JSON.parse(errorOutput.join("")), errorReport);
  }

  console.log("history shadow analyzer: ok");
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
