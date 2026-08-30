import { execFile as execFileCallback } from "node:child_process";
import { posix, resolve } from "node:path";
import { promisify, TextDecoder } from "node:util";

const execFile = promisify(execFileCallback);
const utf8 = new TextDecoder("utf-8", { fatal: true });

const GENERATED_ATTRIBUTES = Object.freeze(["generated", "linguist-generated"]);
const VENDORED_ATTRIBUTES = Object.freeze(["vendored", "linguist-vendored"]);
const ATTRIBUTE_NAMES = Object.freeze([...GENERATED_ATTRIBUTES, ...VENDORED_ATTRIBUTES]);
const SELF_PATHS = Object.freeze(["README.md", ".qq-index-state", ".qq-index-state.json"]);
const SELF_PREFIXES = Object.freeze([".qq-index/"]);
const LOCKFILE_NAMES = Object.freeze([
  "Cargo.lock", "Gemfile.lock", "Pipfile.lock", "bun.lock", "bun.lockb", "composer.lock",
  "npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "poetry.lock", "uv.lock", "yarn.lock",
]);
const GENERATED_DIRECTORY_NAMES = Object.freeze(["build", "coverage", "dist", "node_modules"]);
const VENDORED_DIRECTORY_NAMES = Object.freeze(["third_party", "vendor", "vendored"]);

export const HISTORY_SHADOW_POLICY = Object.freeze({
  version: "history-shadow-v1",
  schemaVersion: "qq-index-history-shadow-report-v1",
  primarySelector: "pair-relative-v1",
  challengerSelector: "repository-window-v1",
  evaluationArms: Object.freeze([
    "production-baseline", "hygiene-only", "pair-relative-v1", "repository-window-v1",
  ]),
  limits: Object.freeze({
    scanRevisions: 400,
    retainedDiffs: 200,
    pairRelativeEvents: 24,
    outputCandidatesPerSelector: 4,
    futureAnnotations: 2,
    maxTrackedRegularFiles: 50_000,
    maxPathBytes: 4_096,
    maxDiffPaths: 100_000,
    maxPairObservations: 250_000,
    maxGitOutputBytes: 32 * 1024 * 1024,
    maxRegistryBytes: 64 * 1024,
    maxRegistryRepositories: 100,
    maxReportBytes: 16 * 1024 * 1024,
    maxGitCommandMilliseconds: 5_000,
  }),
  gates: Object.freeze({
    minimumOpportunities: 12,
    minimumShared: 6,
    accompaniment: Object.freeze({ numerator: 3, denominator: 5 }),
    overlap: Object.freeze({ numerator: 3, denominator: 10 }),
    orderedBands: Object.freeze(["older", "middle", "newer"]),
    minimumSharedPerBand: 1,
    runnerUpSharedMargin: 2,
  }),
  exclusions: Object.freeze({
    selfPaths: SELF_PATHS,
    selfPrefixes: SELF_PREFIXES,
    lockfileNames: LOCKFILE_NAMES,
    generatedDirectoryNames: GENERATED_DIRECTORY_NAMES,
    vendoredDirectoryNames: VENDORED_DIRECTORY_NAMES,
    generatedAttributes: GENERATED_ATTRIBUTES,
    vendoredAttributes: VENDORED_ATTRIBUTES,
  }),
  bulk: Object.freeze({
    maximum: 100,
    minimum: 20,
    eligibleFileNumerator: 1,
    eligibleFileDenominator: 5,
  }),
  switchGate: Object.freeze({
    minimumCalendarDays: 14,
    minimumDistinctFleetSnapshots: 20,
    minimumDistinctSnapshotsPerRepository: 2,
    deepHistoryMinimumRetainedDiffs: 60,
    deepHistoryRepositoryNumerator: 2,
    deepHistoryRepositoryDenominator: 3,
    minimumYieldRepositories: 3,
    minimumYieldSnapshots: 10,
  }),
  switchDecision: Object.freeze({
    requiredMechanicalTruthPercent: 100,
    minimumCorrectnessGainPercentagePoints: 10,
    minimumMedianTimeReductionPercent: 15,
    maximumCorrectnessLossPercentagePoints: 2,
    minimumNotLongerNumerator: 9,
    minimumNotLongerDenominator: 10,
    maximumP95Seconds: 5,
    maximumBaselineLatencyMultiple: 2,
  }),
});

export const FUTURE_ANNOTATION_CAVEAT =
  "Same eligible first-parent diff only; not evidence of dependency, required edits, tasks, ownership, risk, test coverage, causality, or semantic coupling.";

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function decodeUtf8(value, label) {
  try {
    return utf8.decode(Buffer.isBuffer(value) ? value : Buffer.from(value));
  } catch {
    throw new Error(`qq-index history shadow: ${label} is not valid UTF-8; safely abstaining`);
  }
}

function nulStrings(value, label) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (buffer.length === 0) return [];
  const strings = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    strings.push(decodeUtf8(buffer.subarray(start, index), label));
    start = index + 1;
  }
  if (start !== buffer.length) {
    throw new Error(`qq-index history shadow: ${label} was not NUL terminated; safely abstaining`);
  }
  return strings;
}

function pathBytes(path) {
  return Buffer.byteLength(path, "utf8");
}

function assertSafePath(path) {
  if (path === "" || path.includes("\0") || pathBytes(path) > HISTORY_SHADOW_POLICY.limits.maxPathBytes) {
    throw new Error("qq-index history shadow: a repository path exceeds the path safety contract; safely abstaining");
  }
}

function pathHasDirectory(path, names) {
  const segments = path.split("/");
  segments.pop();
  return segments.some((segment) => names.includes(segment));
}

export function builtInExclusionReason(path) {
  if (SELF_PATHS.includes(path) || SELF_PREFIXES.some((prefix) => path.startsWith(prefix))) return "qq-index";
  if (LOCKFILE_NAMES.includes(posix.basename(path))) return "lockfile";
  if (pathHasDirectory(path, GENERATED_DIRECTORY_NAMES)) return "generated-contract";
  if (pathHasDirectory(path, VENDORED_DIRECTORY_NAMES)) return "vendored-contract";
  return null;
}

function enabledAttribute(value) {
  return value === "set" || value === "true";
}

function attributeExclusionReason(attributes = {}) {
  if (GENERATED_ATTRIBUTES.some((name) => enabledAttribute(attributes[name]))) return "generated-attribute";
  if (VENDORED_ATTRIBUTES.some((name) => enabledAttribute(attributes[name]))) return "vendored-attribute";
  return null;
}

function exclusionReason(path, attributesByPath) {
  return builtInExclusionReason(path) ?? attributeExclusionReason(attributesByPath.get(path));
}

export function bulkPathLimit(eligibleFileCount) {
  const proportional = Math.floor(
    eligibleFileCount * HISTORY_SHADOW_POLICY.bulk.eligibleFileNumerator
      / HISTORY_SHADOW_POLICY.bulk.eligibleFileDenominator,
  );
  return Math.min(
    HISTORY_SHADOW_POLICY.bulk.maximum,
    Math.max(HISTORY_SHADOW_POLICY.bulk.minimum, proportional),
  );
}

function emptyCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

/** Build the newest bounded eligible event window from exact changed-path sets. */
export function retainEligibleEvents({ currentPaths, attributesByPath = new Map(), revisionEvents }) {
  const sortedCurrentPaths = [...new Set(currentPaths)].sort(compareBytes);
  if (sortedCurrentPaths.length > HISTORY_SHADOW_POLICY.limits.maxTrackedRegularFiles) {
    return { status: "abstained", reason: "tracked-file-limit", eligibleCurrentPaths: [], events: [], audit: null };
  }
  for (const path of sortedCurrentPaths) assertSafePath(path);

  const reasonKeys = [
    "qq-index", "lockfile", "generated-contract", "vendored-contract",
    "generated-attribute", "vendored-attribute",
  ];
  const reasonByPath = new Map();
  const eligibleCurrentPaths = [];
  const excludedCurrentFiles = emptyCounts(reasonKeys);
  for (const path of sortedCurrentPaths) {
    const reason = exclusionReason(path, attributesByPath);
    if (reason === null) eligibleCurrentPaths.push(path);
    else {
      reasonByPath.set(path, reason);
      excludedCurrentFiles[reason] += 1;
    }
  }

  const current = new Set(sortedCurrentPaths);
  const eligible = new Set(eligibleCurrentPaths);
  const retained = [];
  const retainedRevisions = [];
  const excludedPathTouches = { ...emptyCounts(reasonKeys), nonCurrent: 0 };
  const omittedDiffs = emptyCounts(["empty", "no-current-regular-path", "excluded-only", "bulk", "older-after-retention"]);
  const bulkLimit = bulkPathLimit(eligibleCurrentPaths.length);
  let revisionsScanned = 0;
  let totalChangedPaths = 0;

  for (const event of revisionEvents.slice(0, HISTORY_SHADOW_POLICY.limits.scanRevisions)) {
    revisionsScanned += 1;
    if (retained.length >= HISTORY_SHADOW_POLICY.limits.retainedDiffs) {
      omittedDiffs["older-after-retention"] += 1;
      continue;
    }
    const paths = [...new Set(event.paths)].sort(compareBytes);
    if (paths.length > HISTORY_SHADOW_POLICY.limits.maxDiffPaths) {
      return { status: "abstained", reason: "diff-path-limit", eligibleCurrentPaths, events: [], audit: null };
    }
    for (const path of paths) assertSafePath(path);
    totalChangedPaths += paths.length;
    if (paths.length === 0) {
      omittedDiffs.empty += 1;
      continue;
    }

    const surviving = [];
    let currentPathCount = 0;
    for (const path of paths) {
      if (!current.has(path)) {
        excludedPathTouches.nonCurrent += 1;
        continue;
      }
      currentPathCount += 1;
      if (eligible.has(path)) surviving.push(path);
      else excludedPathTouches[reasonByPath.get(path)] += 1;
    }
    if (currentPathCount === 0) {
      omittedDiffs["no-current-regular-path"] += 1;
      continue;
    }
    if (surviving.length === 0) {
      omittedDiffs["excluded-only"] += 1;
      continue;
    }
    if (surviving.length > bulkLimit) {
      omittedDiffs.bulk += 1;
      continue;
    }

    retained.push(Object.freeze({ revision: event.revision, paths: Object.freeze(surviving) }));
    retainedRevisions.push(event.revision);
  }

  const revisionsAvailable = Math.min(revisionEvents.length, HISTORY_SHADOW_POLICY.limits.scanRevisions);
  return {
    status: "ok",
    eligibleCurrentPaths,
    events: retained,
    audit: {
      revisionsAvailable,
      revisionsScanned,
      scanLimitReached: revisionsAvailable === HISTORY_SHADOW_POLICY.limits.scanRevisions,
      retentionLimitReached: retained.length === HISTORY_SHADOW_POLICY.limits.retainedDiffs,
      retainedEligibleDiffs: retained.length,
      retainedRevisions,
      changedPathsExaminedForRetention: totalChangedPaths,
      bulkPathLimit: bulkLimit,
      trackedRegularFiles: sortedCurrentPaths.length,
      eligibleCurrentFiles: eligibleCurrentPaths.length,
      excludedCurrentFiles,
      excludedPathTouches,
      omittedDiffs,
    },
  };
}

function parentDirectory(path) {
  return posix.dirname(path);
}

function pairKey(left, right) {
  return `${left}\0${right}`;
}

function splitOrderedBands(events) {
  const names = HISTORY_SHADOW_POLICY.gates.orderedBands;
  return names.map((name, index) => {
    const start = Math.floor(index * events.length / names.length);
    const end = Math.floor((index + 1) * events.length / names.length);
    return { name, events: events.slice(start, end) };
  });
}

function countPairEvents(events, left, right) {
  let leftCount = 0;
  let rightCount = 0;
  let shared = 0;
  let opportunities = 0;
  for (const event of events) {
    const hasLeft = event.paths.includes(left);
    const hasRight = event.paths.includes(right);
    if (hasLeft) leftCount += 1;
    if (hasRight) rightCount += 1;
    if (hasLeft && hasRight) shared += 1;
    if (hasLeft || hasRight) opportunities += 1;
  }
  return {
    events: events.length,
    opportunities,
    left: leftCount,
    right: rightCount,
    shared,
  };
}

function statisticsForPair(eventsNewestFirst, left, right, mode, totalShared) {
  const scopedNewestFirst = mode === "pair-relative-v1"
    ? eventsNewestFirst.filter((event) => event.paths.includes(left) || event.paths.includes(right))
      .slice(0, HISTORY_SHADOW_POLICY.limits.pairRelativeEvents)
    : eventsNewestFirst;
  const scopedOldestFirst = [...scopedNewestFirst].reverse();
  const totals = countPairEvents(scopedOldestFirst, left, right);
  const bands = splitOrderedBands(scopedOldestFirst).map(({ name, events }) => ({
    name,
    ...countPairEvents(events, left, right),
  }));
  return {
    mode,
    paths: [left, right],
    counts: {
      opportunities: totals.opportunities,
      left: totals.left,
      right: totals.right,
      shared: totals.shared,
      sharedInRetainedWindow: totalShared,
    },
    ratios: {
      accompaniment: { numerator: totals.shared, denominator: Math.min(totals.left, totals.right) },
      overlap: { numerator: totals.shared, denominator: totals.opportunities },
    },
    bands,
  };
}

export function candidateClearsGates(candidate) {
  const { gates } = HISTORY_SHADOW_POLICY;
  const counts = candidate?.counts;
  if (!counts || !Array.isArray(candidate.bands) || candidate.bands.length !== gates.orderedBands.length) {
    return false;
  }
  if (counts.opportunities < gates.minimumOpportunities || counts.shared < gates.minimumShared) return false;
  const accompanimentDenominator = Math.min(counts.left, counts.right);
  if (accompanimentDenominator <= 0
    || counts.shared * gates.accompaniment.denominator
      < gates.accompaniment.numerator * accompanimentDenominator) return false;
  if (counts.opportunities <= 0
    || counts.shared * gates.overlap.denominator
      < gates.overlap.numerator * counts.opportunities) return false;
  return candidate.bands.every((band, index) => band.name === gates.orderedBands[index]
    && band.shared >= gates.minimumSharedPerBand);
}

function compareFractionsDescending(leftNumerator, leftDenominator, rightNumerator, rightDenominator) {
  const difference = rightNumerator * leftDenominator - leftNumerator * rightDenominator;
  return difference < 0 ? -1 : difference > 0 ? 1 : 0;
}

function compareCandidates(left, right) {
  const support = right.counts.sharedInRetainedWindow - left.counts.sharedInRetainedWindow;
  if (support !== 0) return support;
  const overlap = compareFractionsDescending(
    left.counts.shared, left.counts.opportunities,
    right.counts.shared, right.counts.opportunities,
  );
  if (overlap !== 0) return overlap;
  const accompaniment = compareFractionsDescending(
    left.counts.shared, Math.min(left.counts.left, left.counts.right),
    right.counts.shared, Math.min(right.counts.left, right.counts.right),
  );
  if (accompaniment !== 0) return accompaniment;
  return compareBytes(left.paths[0], right.paths[0]) || compareBytes(left.paths[1], right.paths[1]);
}

/** Compute one mode's bounded, deterministically ordered exact-path candidates. */
export function selectScopeCandidates(eventsNewestFirst, mode) {
  if (mode !== "pair-relative-v1" && mode !== "repository-window-v1") {
    throw new Error(`qq-index history shadow: unknown selector ${JSON.stringify(mode)}`);
  }
  const supportByPair = new Map();
  let pairObservations = 0;
  for (const event of eventsNewestFirst) {
    const paths = [...event.paths].sort(compareBytes);
    for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
        const left = paths[leftIndex];
        const right = paths[rightIndex];
        if (parentDirectory(left) === parentDirectory(right)) continue;
        pairObservations += 1;
        if (pairObservations > HISTORY_SHADOW_POLICY.limits.maxPairObservations) {
          return {
            status: "abstained",
            reason: "pair-observation-limit",
            pairObservations,
            qualifiedPairs: 0,
            candidates: [],
          };
        }
        const key = pairKey(left, right);
        const record = supportByPair.get(key);
        if (record) record.shared += 1;
        else supportByPair.set(key, { left, right, shared: 1 });
      }
    }
  }

  const qualified = [];
  for (const { left, right, shared } of supportByPair.values()) {
    if (shared < HISTORY_SHADOW_POLICY.gates.minimumShared) continue;
    const candidate = statisticsForPair(eventsNewestFirst, left, right, mode, shared);
    if (candidateClearsGates(candidate)) qualified.push(candidate);
  }
  qualified.sort(compareCandidates);

  const candidates = [];
  const usedPaths = new Set();
  for (const candidate of qualified) {
    if (candidate.paths.some((path) => usedPaths.has(path))) continue;
    candidates.push(candidate);
    for (const path of candidate.paths) usedPaths.add(path);
    if (candidates.length === HISTORY_SHADOW_POLICY.limits.outputCandidatesPerSelector) break;
  }
  return {
    status: "ok",
    pairObservations,
    qualifiedPairs: qualified.length,
    candidates,
  };
}

function candidateSupport(candidate) {
  return candidate.counts.sharedInRetainedWindow;
}

/** Future-only deterministic policy; production does not call this function. */
export function selectFutureAnnotations(baselineRoutes, candidates) {
  const selected = [];
  const usedPaths = new Set();
  const usedPairs = new Set();
  for (const route of baselineRoutes) {
    if (selected.length >= HISTORY_SHADOW_POLICY.limits.futureAnnotations) break;
    if (!route || route.independentlyJustified !== true || typeof route.path !== "string") continue;
    if (usedPaths.has(route.path)) continue;

    const choices = candidates
      .filter((candidate) => candidateClearsGates(candidate) && candidate.paths.includes(route.path))
      .map((candidate) => ({
        candidate,
        companion: candidate.paths[0] === route.path ? candidate.paths[1] : candidate.paths[0],
      }))
      .filter(({ companion }) => companion !== route.path)
      .sort((left, right) => compareCandidates(left.candidate, right.candidate));
    if (choices.length === 0) continue;

    const winner = choices[0];
    const runnerUp = choices[1];
    if (runnerUp && candidateSupport(winner.candidate) - candidateSupport(runnerUp.candidate)
      < HISTORY_SHADOW_POLICY.gates.runnerUpSharedMargin) continue;
    if (usedPaths.has(winner.companion)
      || usedPairs.has(pairKey(winner.candidate.paths[0], winner.candidate.paths[1]))) continue;

    selected.push({ route: route.path, companion: winner.companion, observation: winner.candidate });
    usedPaths.add(route.path);
    usedPaths.add(winner.companion);
    usedPairs.add(pairKey(winner.candidate.paths[0], winner.candidate.paths[1]));
  }
  return selected;
}

function sanitizedGitEnvironment() {
  const env = { ...process.env };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_WORK_TREE",
  ]) delete env[name];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function errorText(error) {
  return String(error?.stderr || error?.stdout || error?.message || error).trim().slice(0, 4_096);
}

function execFileWithInput(file, args, options, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFileCallback(file, args, options, (error, stdout, stderr) => {
      if (error) rejectPromise(Object.assign(error, { stdout, stderr }));
      else resolvePromise({ stdout, stderr });
    });
    child.stdin.on("error", rejectPromise);
    child.stdin.end(input);
  });
}

async function git(root, args, options = {}) {
  const gitArgs = [
    "--no-pager", "--no-replace-objects", "-c", "core.attributesFile=/dev/null", "-C", root, ...args,
  ];
  try {
    const { input, ...extraOptions } = options;
    const executionOptions = {
      encoding: null,
      env: sanitizedGitEnvironment(),
      maxBuffer: HISTORY_SHADOW_POLICY.limits.maxGitOutputBytes,
      timeout: HISTORY_SHADOW_POLICY.limits.maxGitCommandMilliseconds,
      windowsHide: true,
      ...extraOptions,
    };
    return input === undefined
      ? await execFile("git", gitArgs, executionOptions)
      : await execFileWithInput("git", gitArgs, executionOptions, input);
  } catch (error) {
    const detail = errorText(error);
    throw new Error(`qq-index history shadow: git ${args[0]} failed${detail ? `: ${detail}` : ""}`, { cause: error });
  }
}

function parseHeadTree(value) {
  const regularPaths = [];
  for (const record of nulStrings(value, "HEAD tree")) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("qq-index history shadow: malformed HEAD tree; safely abstaining");
    const metadata = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (metadata.length !== 3) throw new Error("qq-index history shadow: malformed HEAD tree; safely abstaining");
    const [mode, type] = metadata;
    if ((mode === "100644" || mode === "100755") && type === "blob") regularPaths.push(path);
  }
  return regularPaths.sort(compareBytes);
}

function parseRevisions(value, head) {
  const lines = decodeUtf8(value, "revision list").split("\n").filter(Boolean);
  const hashPattern = new RegExp(`^[0-9a-f]{${head.length}}$`);
  return lines.map((line, index) => {
    const fields = line.split(" ");
    if (!hashPattern.test(fields[0]) || fields.slice(1).some((field) => !hashPattern.test(field))) {
      throw new Error("qq-index history shadow: malformed revision list; safely abstaining");
    }
    if (index === 0 && fields[0] !== head) {
      throw new Error("qq-index history shadow: revision list did not begin at HEAD; safely abstaining");
    }
    return { revision: fields[0], parent: fields[1] };
  });
}

function parseAttributes(value, expectedPaths) {
  const fields = nulStrings(value, "attribute output");
  if (fields.length !== expectedPaths.length * ATTRIBUTE_NAMES.length * 3) {
    throw new Error("qq-index history shadow: malformed attribute output; safely abstaining");
  }
  const attributesByPath = new Map(expectedPaths.map((path) => [path, {}]));
  for (let index = 0; index < fields.length; index += 3) {
    const [path, attribute, attributeValue] = fields.slice(index, index + 3);
    if (!attributesByPath.has(path) || !ATTRIBUTE_NAMES.includes(attribute)) {
      throw new Error("qq-index history shadow: unexpected attribute output; safely abstaining");
    }
    attributesByPath.get(path)[attribute] = attributeValue;
  }
  return attributesByPath;
}

async function attributesAtRevision(root, revision, currentPaths) {
  if (currentPaths.length === 0) return new Map();
  const input = Buffer.from(`${currentPaths.join("\0")}\0`, "utf8");
  if (input.length > HISTORY_SHADOW_POLICY.limits.maxGitOutputBytes) {
    throw new Error("qq-index history shadow: tracked path input exceeds the resource contract; safely abstaining");
  }
  const result = await git(root, [
    "check-attr", `--source=${revision}`, "-z", ...ATTRIBUTE_NAMES, "--stdin",
  ], { input });
  return parseAttributes(result.stdout, currentPaths);
}

async function mapBounded(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function readRevisionEvents(root, revisions) {
  return mapBounded(revisions, 4, async ({ revision, parent }) => {
    const args = parent
      ? ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "--no-ext-diff", "-r", "-z", parent, revision]
      : ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "--no-ext-diff", "-r", "--root", "-z", revision];
    const result = await git(root, args);
    return { revision, paths: nulStrings(result.stdout, `diff ${revision}`) };
  });
}

function baseReport(root, head) {
  return {
    schemaVersion: HISTORY_SHADOW_POLICY.schemaVersion,
    policyVersion: HISTORY_SHADOW_POLICY.version,
    repository: root,
    head,
    shadowOnly: true,
    publicationEnabled: false,
    primarySelector: HISTORY_SHADOW_POLICY.primarySelector,
    challengerSelector: HISTORY_SHADOW_POLICY.challengerSelector,
    evaluationArms: HISTORY_SHADOW_POLICY.evaluationArms,
  };
}

/** Analyze one local repository without writes, model invocation, or publication. */
export async function analyzeRepository(repository) {
  const root = resolve(repository);
  const headResult = await git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const head = decodeUtf8(headResult.stdout, "HEAD").trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) {
    throw new Error("qq-index history shadow: HEAD is not a supported object id; safely abstaining");
  }

  const treeResult = await git(root, ["ls-tree", "-r", "--full-tree", "-z", head]);
  const currentPaths = parseHeadTree(treeResult.stdout);
  if (currentPaths.length > HISTORY_SHADOW_POLICY.limits.maxTrackedRegularFiles) {
    return { ...baseReport(root, head), status: "abstained", reason: "tracked-file-limit", selectors: {} };
  }
  for (const path of currentPaths) assertSafePath(path);
  const totalPathBytes = currentPaths.reduce((total, path) => total + pathBytes(path) + 1, 0);
  if (totalPathBytes > HISTORY_SHADOW_POLICY.limits.maxGitOutputBytes) {
    return { ...baseReport(root, head), status: "abstained", reason: "tracked-path-bytes-limit", selectors: {} };
  }

  const [attributeMap, revisionsResult] = await Promise.all([
    attributesAtRevision(root, head, currentPaths),
    git(root, [
      "rev-list", "--first-parent", `--max-count=${HISTORY_SHADOW_POLICY.limits.scanRevisions}`,
      "--parents", head,
    ]),
  ]);
  const revisions = parseRevisions(revisionsResult.stdout, head);
  const revisionEvents = await readRevisionEvents(root, revisions);
  const retained = retainEligibleEvents({ currentPaths, attributesByPath: attributeMap, revisionEvents });
  if (retained.status !== "ok") {
    return { ...baseReport(root, head), status: "abstained", reason: retained.reason, selectors: {} };
  }

  return {
    ...baseReport(root, head),
    status: "ok",
    trackedRegularFiles: currentPaths.length,
    history: retained.audit,
    selectors: {
      "pair-relative-v1": selectScopeCandidates(retained.events, "pair-relative-v1"),
      "repository-window-v1": selectScopeCandidates(retained.events, "repository-window-v1"),
    },
    futureAnnotationContract: {
      active: false,
      maximumEntries: HISTORY_SHADOW_POLICY.limits.futureAnnotations,
      routeMustBeIndependentlyJustified: true,
      maximumCompanionsPerRoute: 1,
      pathReuseAllowed: false,
      runnerUpSharedMargin: HISTORY_SHADOW_POLICY.gates.runnerUpSharedMargin,
      wording: "observed with",
      caveat: FUTURE_ANNOTATION_CAVEAT,
      replacementMustBeLengthNeutral: true,
    },
  };
}

export const internals = Object.freeze({
  ATTRIBUTE_NAMES,
  compareBytes,
  nulStrings,
  parseAttributes,
  parseHeadTree,
  parseRevisions,
  splitOrderedBands,
  statisticsForPair,
});
