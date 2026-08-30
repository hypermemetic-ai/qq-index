#!/usr/bin/env python3
"""Synthetic-only SQLite FTS5 shape benchmark for the SearchBatchV1 design.

This program has deliberately closed inputs: it generates every document and
query term itself, creates its database in a fresh temporary directory, emits
one JSON report to stdout, and removes the directory before returning.  It is
not a corpus benchmark or a production engine.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sqlite3
import statistics
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = "qq-index-synthetic-fts5-v1"
SEED = 7_311
QUERY_TERMS = ("aurora", "cobalt", "lattice", "quasar", "saffron")
VOCABULARY = (
    "amber", "anvil", "arch", "atlas", "birch", "brisk", "cedar", "circuit",
    "cloud", "comet", "copper", "coral", "crane", "dawn", "drift", "field",
    "flint", "forest", "frost", "garden", "harbor", "indigo", "island", "jade",
    "juniper", "lagoon", "maple", "meadow", "meteor", "moss", "north", "ocean",
    "orbit", "pearl", "pine", "plume", "rain", "ridge", "river", "robin",
    "silver", "solar", "sparrow", "stone", "summit", "timber", "vale", "willow",
)
SURFACES = ("conversation", "note", "summary")
ALLOWED_SURFACES = ("conversation", "summary")
WORKSPACE_FILTER = "workspace-0"


@dataclass(frozen=True)
class Mode:
    documents: int
    sessions: int
    workspaces: int
    words_per_document: int
    default_iterations: int


MODES = {
    "small": Mode(
        documents=16_000,
        sessions=400,
        workspaces=7,
        words_per_document=42,
        default_iterations=20,
    ),
    "scaled": Mode(
        documents=250_000,
        sessions=1_000,
        workspaces=7,
        words_per_document=64,
        default_iterations=40,
    ),
}

SEARCH_SQL = """
WITH hits AS MATERIALIZED (
    SELECT
        d.session_id,
        d.doc_id,
        d.seq,
        bm25(documents_fts) AS score
    FROM documents_fts
    JOIN documents AS d ON d.doc_id = documents_fts.rowid
    WHERE documents_fts MATCH ?
      AND d.workspace_id = ?
      AND d.surface IN (?, ?)
),
ranked AS (
    SELECT
        session_id,
        doc_id,
        score,
        row_number() OVER (
            PARTITION BY session_id
            ORDER BY score ASC, seq DESC, doc_id ASC
        ) AS session_rank
    FROM hits
)
SELECT session_id, doc_id, score
FROM ranked
WHERE session_rank = 1
ORDER BY score ASC, session_id ASC, doc_id ASC
LIMIT 101
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        allow_abbrev=False,
        description=(
            "Build and remove a generated temporary SQLite FTS5 fixture. "
            "No external database or query input is accepted."
        )
    )
    parser.add_argument(
        "--mode",
        choices=tuple(MODES),
        default="small",
        help="generated fixture size; scaled must be selected explicitly",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=None,
        help="timed samples (3-200); defaults are fixed per generated mode",
    )
    args = parser.parse_args()
    if args.iterations is not None and not 3 <= args.iterations <= 200:
        parser.error("--iterations must be between 3 and 200")
    return args


def elapsed_ms(start_ns: int) -> float:
    return (time.perf_counter_ns() - start_ns) / 1_000_000


def percentile(samples: Iterable[float], proportion: float) -> float:
    """Return a deterministic nearest-rank percentile."""
    ordered = sorted(samples)
    if not ordered:
        raise ValueError("percentile requires at least one sample")
    rank = max(1, math.ceil(proportion * len(ordered)))
    return ordered[rank - 1]


def distribution(samples: list[float]) -> dict[str, Any]:
    return {
        "samples": len(samples),
        "min": round(min(samples), 3),
        "p50": round(percentile(samples, 0.50), 3),
        "p95": round(percentile(samples, 0.95), 3),
        "max": round(max(samples), 3),
        "mean": round(statistics.fmean(samples), 3),
        "unit": "ms",
        "percentile_method": "nearest-rank",
    }


def generated_body(document_id: int, words_per_document: int) -> str:
    # Integer arithmetic and a frozen vocabulary make document content stable
    # across runs and independent of any host files or random-number APIs.
    words = [
        VOCABULARY[(document_id * 17 + offset * 11 + SEED) % len(VOCABULARY)]
        for offset in range(words_per_document)
    ]
    divisors = (11, 13, 17, 19, 23)
    for index, term in enumerate(QUERY_TERMS):
        if (document_id * (index + 3) + SEED + index) % divisors[index] == 0:
            words.insert((index * 7) % (len(words) + 1), term)
    return " ".join(words)


def batches(mode: Mode, size: int = 1_000):
    for first in range(1, mode.documents + 1, size):
        records = []
        for document_id in range(first, min(mode.documents + 1, first + size)):
            session_number = (document_id * 29 + SEED) % mode.sessions
            records.append(
                (
                    document_id,
                    f"generated-session-{session_number:05d}",
                    document_id // mode.sessions,
                    f"workspace-{document_id % mode.workspaces}",
                    SURFACES[document_id % len(SURFACES)],
                    generated_body(document_id, mode.words_per_document),
                )
            )
        yield records


def configure(conn: sqlite3.Connection) -> None:
    mode = conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]
    if str(mode).lower() != "wal":
        raise RuntimeError(f"SQLite did not enter WAL mode: {mode!r}")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA foreign_keys=ON")


def create_fixture(path: Path, mode: Mode) -> tuple[sqlite3.Connection, float]:
    started = time.perf_counter_ns()
    conn = sqlite3.connect(path, isolation_level=None, timeout=5)
    configure(conn)
    try:
        conn.executescript(
            """
            BEGIN IMMEDIATE;
            CREATE TABLE index_meta (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                schema_version TEXT NOT NULL,
                generation INTEGER NOT NULL,
                source_watermark INTEGER NOT NULL
            );
            INSERT INTO index_meta VALUES (1, 'qq-index-synthetic-fts5-v1', 1, 0);

            CREATE TABLE documents (
                doc_id INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                workspace_id TEXT NOT NULL,
                surface TEXT NOT NULL,
                body TEXT NOT NULL
            );
            CREATE INDEX documents_session_seq ON documents(session_id, seq);
            CREATE INDEX documents_filter ON documents(workspace_id, surface, doc_id);
            CREATE VIRTUAL TABLE documents_fts USING fts5(
                body,
                content='documents',
                content_rowid='doc_id',
                tokenize='unicode61'
            );
            CREATE TABLE snapshot_probe (
                value INTEGER PRIMARY KEY
            );
            INSERT INTO snapshot_probe VALUES (1);
            COMMIT;
            """
        )
        conn.execute("BEGIN IMMEDIATE")
        for records in batches(mode):
            conn.executemany(
                """
                INSERT INTO documents
                    (doc_id, session_id, seq, workspace_id, surface, body)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                records,
            )
            conn.executemany(
                "INSERT INTO documents_fts(rowid, body) VALUES (?, ?)",
                ((record[0], record[5]) for record in records),
            )
        conn.execute(
            "UPDATE index_meta SET source_watermark = ? WHERE singleton = 1",
            (mode.documents,),
        )
        conn.execute("COMMIT")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        return conn, elapsed_ms(started)
    except BaseException:
        conn.close()
        raise


def fts_query(conn: sqlite3.Connection, term: str) -> list[tuple[Any, ...]]:
    # Quoting keeps the generated input in literal/phrase form and mirrors the
    # normalization expected at the SearchBatchV1 boundary.
    literal = '"' + term.replace('"', '""') + '"'
    return conn.execute(
        SEARCH_SQL,
        (literal, WORKSPACE_FILTER, *ALLOWED_SURFACES),
    ).fetchall()


def generation(conn: sqlite3.Connection) -> int:
    return int(
        conn.execute(
            "SELECT generation FROM index_meta WHERE singleton = 1"
        ).fetchone()[0]
    )


def run_one_literal(conn: sqlite3.Connection) -> int:
    rows = fts_query(conn, QUERY_TERMS[0])
    if not rows:
        raise AssertionError("generated one-literal query unexpectedly returned no rows")
    return len(rows)


def run_five_literal_batch(conn: sqlite3.Connection) -> tuple[int, dict[str, Any]]:
    if conn.in_transaction:
        raise AssertionError("batch reader unexpectedly entered with an active transaction")
    begin_count = 0
    try:
        conn.execute("BEGIN")
        begin_count += 1
        before = generation(conn)
        row_count = 0
        for term in QUERY_TERMS:
            if not conn.in_transaction:
                raise AssertionError("five-literal batch escaped its read transaction")
            rows = fts_query(conn, term)
            if not rows:
                raise AssertionError("generated batch query unexpectedly returned no rows")
            row_count += len(rows)
        after = generation(conn)
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    return row_count, {
        "query_count": len(QUERY_TERMS),
        "begin_count": begin_count,
        "single_read_transaction": begin_count == 1,
        "generation_stable": before == after,
        "generation": before,
    }


def verify_wal_snapshot(path: Path) -> dict[str, Any]:
    reader = sqlite3.connect(path, isolation_level=None, timeout=5)
    writer = sqlite3.connect(path, isolation_level=None, timeout=5)
    try:
        reader.execute("PRAGMA query_only=ON")
        reader.execute("BEGIN")
        before = int(reader.execute("SELECT count(*) FROM snapshot_probe").fetchone()[0])

        writer.execute("BEGIN IMMEDIATE")
        writer.execute("INSERT INTO snapshot_probe VALUES (2)")
        writer.execute("UPDATE index_meta SET generation = generation + 1 WHERE singleton = 1")
        writer.execute("COMMIT")

        during = int(reader.execute("SELECT count(*) FROM snapshot_probe").fetchone()[0])
        reader.execute("COMMIT")
        after = int(reader.execute("SELECT count(*) FROM snapshot_probe").fetchone()[0])
        if (before, during, after) != (1, 1, 2):
            raise AssertionError(
                f"WAL snapshot check failed: expected (1, 1, 2), got {(before, during, after)!r}"
            )
        return {
            "reader_count_before_writer_commit": before,
            "reader_count_after_writer_commit_same_transaction": during,
            "reader_count_after_new_transaction": after,
            "stable_during_concurrent_commit": True,
            "new_transaction_observed_commit": True,
        }
    finally:
        if reader.in_transaction:
            reader.execute("ROLLBACK")
        if writer.in_transaction:
            writer.execute("ROLLBACK")
        reader.close()
        writer.close()


def measure_existing_reopen(path: Path, iterations: int) -> list[float]:
    samples = []
    uri = f"file:{path}?mode=ro"
    for _ in range(iterations):
        started = time.perf_counter_ns()
        conn = sqlite3.connect(uri, uri=True, isolation_level=None, timeout=5)
        try:
            conn.execute("PRAGMA query_only=ON")
            row = conn.execute(
                "SELECT schema_version, generation FROM index_meta WHERE singleton = 1"
            ).fetchone()
            if row is None or row[0] != SCHEMA_VERSION:
                raise AssertionError("existing-index validation failed")
        finally:
            conn.close()
        samples.append(elapsed_ms(started))
    return samples


def run_benchmark(path: Path, mode_name: str, mode: Mode, iterations: int) -> dict[str, Any]:
    conn, build_ms = create_fixture(path, mode)
    one_samples: list[float] = []
    batch_samples: list[float] = []
    try:
        # Warm prepared statements/pages without counting warm-up observations.
        for _ in range(3):
            run_one_literal(conn)
            run_five_literal_batch(conn)

        one_rows = 0
        batch_rows = 0
        batch_assertions: dict[str, Any] | None = None
        for _ in range(iterations):
            started = time.perf_counter_ns()
            one_rows = run_one_literal(conn)
            one_samples.append(elapsed_ms(started))

            started = time.perf_counter_ns()
            batch_rows, batch_assertions = run_five_literal_batch(conn)
            batch_samples.append(elapsed_ms(started))

        if batch_assertions is None:
            raise AssertionError("batch benchmark did not execute")
        if not batch_assertions["single_read_transaction"]:
            raise AssertionError("five-literal batch did not use one read transaction")
        if not batch_assertions["generation_stable"]:
            raise AssertionError("generation changed inside five-literal batch")

        database_bytes = path.stat().st_size
    finally:
        conn.close()

    snapshot = verify_wal_snapshot(path)
    reopen_samples = measure_existing_reopen(path, iterations)

    return {
        "schema": SCHEMA_VERSION,
        "synthetic": True,
        "mode": mode_name,
        "configuration": {
            "documents": mode.documents,
            "sessions": mode.sessions,
            "workspaces": mode.workspaces,
            "words_per_document": mode.words_per_document,
            "generated_seed": SEED,
            "query_count": len(QUERY_TERMS),
            "iterations": iterations,
            "warmup_iterations": 3,
            "database_bytes": database_bytes,
        },
        "methodology": {
            "engine": "Python stdlib sqlite3 backed by SQLite",
            "sqlite_version": sqlite3.sqlite_version,
            "index": "SQLite FTS5 external-content table with unicode61 tokenizer",
            "query_shape": (
                "literal MATCH plus workspace/surface filters, deterministic "
                "per-session row_number rank, top 101"
            ),
            "batch_shape": (
                "five serial literal queries on one connection inside one explicit "
                "read transaction"
            ),
            "timing_clock": "monotonic perf_counter_ns; execute plus fetch-all",
            "cache_state": "warm process and OS cache after three untimed warmups",
            "existing_reopen_scope": (
                "read-only handle open plus schema/generation read in the same process; "
                "not a cold-host or service-start measurement"
            ),
            "generated_inputs_only": True,
            "latency_is_observation_not_gate": True,
        },
        "results": {
            "fixture_build": {"elapsed": round(build_ms, 3), "unit": "ms"},
            "warm_one_literal": distribution(one_samples),
            "warm_five_literal_batch": distribution(batch_samples),
            "existing_index_reopen": distribution(reopen_samples),
            "last_one_literal_rows": one_rows,
            "last_five_literal_rows_total": batch_rows,
        },
        "assertions": {
            "five_literal_batch": batch_assertions,
            "wal_snapshot": snapshot,
        },
        "limitations": [
            "Generated vocabulary, selectivity, metadata, and document lengths are not production traffic.",
            "No snippets, policy evaluation, qq-core verification reads, IPC, queueing, or Rust worker costs are included.",
            "No cancellation/deadline or cold-host SLO is qualified by this microbenchmark.",
            "Percentiles from one local run are observations, not portable performance baselines.",
        ],
    }


def main() -> int:
    args = parse_args()
    mode = MODES[args.mode]
    iterations = args.iterations or mode.default_iterations
    fixture_root = Path(tempfile.mkdtemp(prefix="qq-index-generated-fts5-"))
    path = fixture_root / "generated.db"
    report: dict[str, Any] | None = None
    try:
        report = run_benchmark(path, args.mode, mode, iterations)
    finally:
        shutil.rmtree(fixture_root, ignore_errors=False)
    if fixture_root.exists():
        raise AssertionError("temporary generated fixture was not removed")
    if report is None:
        raise AssertionError("benchmark did not produce a report")
    report["cleanup"] = {
        "temporary_fixture_removed": True,
        "fixture_retained": False,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
