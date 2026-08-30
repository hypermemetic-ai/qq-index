import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const benchmark = resolve("benchmarks/session_history_fts5.py");
const roots = [];

async function python(args, options = {}) {
  return execFile("python3", [benchmark, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
}

try {
  const source = await readFile(benchmark, "utf8");
  assert.match(source, /tempfile\.mkdtemp/);
  assert.match(source, /shutil\.rmtree/);
  assert.doesNotMatch(source, /sqlite3\.connect\(args\./);

  const { stdout: help } = await python(["--help"]);
  assert.match(help, /generated temporary SQLite FTS5 fixture/i);
  assert.match(help, /--mode \{small,scaled\}/);
  assert.match(help, /--iterations/);
  assert.doesNotMatch(
    help,
    /--(?:database|db|corpus|repository|session|query|literal|output|path)\b/i,
    "the benchmark must not accept an external data, query, or output path",
  );

  const rejectionRoot = await mkdtemp(resolve(tmpdir(), "qq-index-benchmark-reject-"));
  roots.push(rejectionRoot);
  const marker = resolve(rejectionRoot, "must-not-be-opened.sqlite");
  const markerContents = "not a sqlite database; external inputs must be rejected\n";
  await writeFile(marker, markerContents);
  for (const args of [
    [marker],
    ["--database", marker],
    ["--corpus", marker],
    ["--session", marker],
    ["--query", "caller-controlled"],
    ["--output", marker],
  ]) {
    await assert.rejects(
      python(args),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /unrecognized arguments/i);
        return true;
      },
      `unsafe argument surface was accepted: ${args[0]}`,
    );
  }
  assert.equal(await readFile(marker, "utf8"), markerContents);

  const fixtureParent = await mkdtemp(resolve(tmpdir(), "qq-index-benchmark-temp-"));
  roots.push(fixtureParent);
  const { stdout, stderr } = await python(
    ["--iterations", "3"],
    { env: { ...process.env, TMPDIR: fixtureParent } },
  );
  assert.equal(stderr, "");
  const report = JSON.parse(stdout);

  assert.equal(report.schema, "qq-index-synthetic-fts5-v1");
  assert.equal(report.synthetic, true);
  assert.equal(report.mode, "small");
  assert.equal(report.configuration.documents, 16_000);
  assert.equal(report.configuration.query_count, 5);
  assert.equal(report.configuration.iterations, 3);
  assert.equal(report.methodology.generated_inputs_only, true);
  assert.equal(report.methodology.latency_is_observation_not_gate, true);
  assert.match(report.methodology.index, /SQLite FTS5/);
  assert.match(report.methodology.batch_shape, /one explicit read transaction/);
  assert.match(report.methodology.cache_state, /warm/i);
  assert.match(report.methodology.existing_reopen_scope, /not a cold-host/i);

  for (const key of [
    "warm_one_literal",
    "warm_five_literal_batch",
    "existing_index_reopen",
  ]) {
    const result = report.results[key];
    assert.equal(result.samples, 3);
    assert.equal(result.unit, "ms");
    assert.equal(result.percentile_method, "nearest-rank");
    for (const statistic of ["min", "p50", "p95", "max", "mean"]) {
      assert.equal(typeof result[statistic], "number");
      assert.ok(result[statistic] >= 0);
    }
    assert.ok(result.min <= result.p50);
    assert.ok(result.p50 <= result.p95);
    assert.ok(result.p95 <= result.max);
  }

  assert.ok(report.results.fixture_build.elapsed > 0);
  assert.ok(report.configuration.database_bytes > 0);
  assert.ok(report.results.last_one_literal_rows > 0);
  assert.ok(report.results.last_five_literal_rows_total > 0);
  assert.deepEqual(
    {
      query_count: report.assertions.five_literal_batch.query_count,
      begin_count: report.assertions.five_literal_batch.begin_count,
      single_read_transaction: report.assertions.five_literal_batch.single_read_transaction,
      generation_stable: report.assertions.five_literal_batch.generation_stable,
    },
    { query_count: 5, begin_count: 1, single_read_transaction: true, generation_stable: true },
  );
  assert.deepEqual(
    {
      before: report.assertions.wal_snapshot.reader_count_before_writer_commit,
      during: report.assertions.wal_snapshot.reader_count_after_writer_commit_same_transaction,
      after: report.assertions.wal_snapshot.reader_count_after_new_transaction,
      stable: report.assertions.wal_snapshot.stable_during_concurrent_commit,
      visible: report.assertions.wal_snapshot.new_transaction_observed_commit,
    },
    { before: 1, during: 1, after: 2, stable: true, visible: true },
  );
  assert.equal(report.cleanup.temporary_fixture_removed, true);
  assert.equal(report.cleanup.fixture_retained, false);
  assert.ok(report.limitations.some((item) => /not portable performance baselines/i.test(item)));
  assert.deepEqual(await readdir(fixtureParent), [], "generated temporary fixture leaked");

  await assert.rejects(
    python(["--iterations", "2"]),
    (error) => error.code === 2 && /between 3 and 200/.test(error.stderr),
  );

  console.log("session-history synthetic benchmark tests passed");
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
