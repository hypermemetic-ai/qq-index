import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const hostMap = await readFile(fixture("qq-host-map.md"), "utf8");
const jobs = JSON.parse(await readFile(fixture("architect-jobs.json"), "utf8"));

const linkedPages = new Set(
  [...hostMap.matchAll(/\]\(([^)#?]+)\.md(?:[?#][^)]*)?\)/g)]
    .map((match) => match[1].split("/").at(-1)),
);

assert.deepEqual(
  [...linkedPages].sort(),
  ["architect", "dictation", "host", "land", "relay", "sessions", "ui"],
  "the fixture remains the scored seven-page host map",
);
assert.equal(jobs.length, 12, "the historical corpus has twelve jobs");
assert.deepEqual(
  jobs.map((job) => job.preDelegateSourceReads),
  [7, 11, 18, 26, 18, 10, 8, 7, 5, 2, 42, 39],
  "the pre-delegation read scores remain encoded",
);

const pathShape = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\/]+(?:\/[^\0\\/]+)*$/;
for (const job of jobs) {
  assert.equal(typeof job.job, "string");
  assert.ok(job.job.length > 0);
  assert.ok(
    job.expectedPages.length >= 1 && job.expectedPages.length <= 2,
    `${job.job} must route to one or two pages`,
  );
  for (const page of job.expectedPages) {
    assert.ok(linkedPages.has(page), `${job.job} routes to linked page ${page}`);
  }

  // Signal files are selective landed-plan pointers. This checks path syntax,
  // deliberately not existence or complete ownership coverage.
  assert.ok(job.signalFiles.length > 0, `${job.job} has at least one signal`);
  for (const signal of job.signalFiles) {
    assert.match(signal, pathShape, `${job.job} signal is a repository-relative path`);
  }
}

// The corpus suite explicitly loads the loader suite; package.json then runs
// the refresh-program integration suite as a separate process.
console.log("corpus fixtures: ok");
await import("./index.mjs");
