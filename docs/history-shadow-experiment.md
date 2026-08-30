# History shadow experiment: `history-shadow-v1`

Status: **shadow only**. `qq-index-history-shadow` reads local Git evidence and emits JSON. It does not write a repository, invoke a model, alter the production evidence packet or prompt, call refresh, or publish README text. No candidate may be shown to the production writer until an operator approves a separate, versioned publication change.

This document and `HISTORY_SHADOW_POLICY` in [`src/history-shadow.mjs`](../src/history-shadow.mjs) are the experiment contract. Constants change only in a new global policy version, never per repository and never after inspecting an outcome that the change would affect.

## Observation and unit

The only candidate fact is: two exact paths that are regular files in the resolved `HEAD` tree occurred in the same eligible first-parent diff. A first-parent diff compares a revision with its first parent; a root is compared with the empty tree. A merge therefore contributes one delta against its first parent, and commits reachable only through its other parents are not separately traversed. Rename inference is disabled. Historical names absent from the current regular-file set cannot become candidates.

A diff is a mechanical Git boundary, not a pull request, task, release, or causal event. Ordering is **ordinal**, newest from `HEAD`; timestamps are not used. The analyzer reads no author, message, issue, PR, source prose, or network evidence.

Candidate facts do not establish dependency, required edits, task boundaries, ownership, expertise, risk, defects, test coverage, causality, semantics, or future behavior. A test-looking filename receives no special interpretation.

## Bounds and exclusions

The analyzer resolves one `HEAD`, anchors all subsequent reads to its object ID, and:

- traverses at most 400 first-parent revisions;
- retains at most the newest 200 eligible diffs;
- limits one path to 4,096 UTF-8 bytes, the current regular-file set to 50,000 paths, one diff to 100,000 paths, Git output to 32 MiB per command, a registry to 64 KiB/100 repositories, a report to 16 MiB, and pair observations to 250,000;
- bounds pair-relative history to 24 A-or-B events and JSON output to four non-path-reusing candidates per selector;
- uses bytewise UTF-8 ordering, NUL-delimited Git path formats, and integer threshold comparisons; invalid encodings, malformed output, command limits, or resource limits fail closed.

The following current paths are removed before retention and pair generation. An event containing no remaining current path does not consume the 200-diff retained window.

1. **qq-index publication/state:** exact `README.md`, `.qq-index-state`, `.qq-index-state.json`, and every path under root `.qq-index/`.
2. **Lockfile basenames at any depth:** `Cargo.lock`, `Gemfile.lock`, `Pipfile.lock`, `bun.lock`, `bun.lockb`, `composer.lock`, `npm-shrinkwrap.json`, `package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`, `uv.lock`, and `yarn.lock`.
3. **Generated directory segments:** `build`, `coverage`, `dist`, and `node_modules`.
4. **Vendored directory segments:** `third_party`, `vendor`, and `vendored`.
5. **Suppressive attributes at the resolved tree:** `generated`, `linguist-generated`, `vendored`, or `linguist-vendored` when set or equal to `true`. Attributes can only suppress evidence.

These lists are intentionally small and auditable. There is no inference from author, message, churn, extension, or content. Unknown generated output can remain; legitimate files under a listed directory can be omitted. Both are shadow-review questions, not reasons for repository-specific exceptions.

After those exclusions and intersection with current regular files, omit a bulk diff when its path count is greater than:

```text
min(100, max(20, floor(current eligible regular files / 5)))
```

Bulk removal happens before pair generation. Empty, excluded-only, non-current-only, and bulk events consume scan depth but not retention. An eligible singleton consumes retention because it is an A-without-B opportunity for pairs containing A. Unrelated singleton events do not affect pair-relative counts; they can affect repository-window band boundaries by design.

## Selectors

Both selectors use unordered pairs in different immediate parent directories. For a scope let `A` and `B` be counts touching each path, `C` shared events, and `U` events touching A or B. A pair passes only when:

- `U >= 12` and `C >= 6`;
- `C / min(A, B) >= 3/5` (accompaniment);
- `C / U >= 3/10` (overlap); and
- `C >= 1` in each of three deterministic contiguous ordinal bands (`older`, `middle`, `newer`).

Ratios are compared by integer cross multiplication. They are separate gates, not a composite score. Candidate JSON includes `A`, `B`, `C`, `U`, retained-window support, each band's event/opportunity/path/shared counts, scan depth, retained revision IDs, and exclusion/omission counts.

### `pair-relative-v1` — primary early selector

Use the newest up to 24 retained events that touch A or B. Reverse those selected events to older-to-newer order, then split them at `floor(i*N/3)` boundaries. This is pair-relative ordinal recency, not calendar recency or global durability.

### `repository-window-v1` — later challenger

Use the complete retained eligible repository window. Split all retained events, including events unrelated to the pair, into the same ordered thirds. `A`, `B`, `C`, and `U` are computed over that complete retained window. This is a bounded repository-window observation, not global durability.

Qualified candidates are ordered by retained-window shared support, scoped overlap, scoped accompaniment, then bytewise paths. Lexical order provides deterministic output only. Output greedily avoids path reuse and stops at four candidates per mode. No model selects candidates.

## Future annotation contract (inactive)

Publication is not part of this experiment. The pure policy exists so a later proposal can be tested without inventing selection after seeing results:

- zero to two annotations; two is a ceiling, never a quota;
- stable baseline-route order, with each route independently justified without history;
- at most one companion per route; no reused path or redundant pair;
- every candidate independently passes the gates;
- the leading companion's retained-window shared support must exceed its per-route runner-up by at least two events, otherwise abstain;
- use only “observed with” and one shared caveat: “Same eligible first-parent diff only; not evidence of dependency, required edits, tasks, ownership, risk, test coverage, causality, or semantic coupling.”;
- show threshold predicates, not live counters; replace weaker heat/proximity prose and add no net README words, bytes, or links. Never displace identity, commands, or a major structural boundary.

## Shadow protocol and preregistered switch gate

Capture analyzer JSON outside repositories at immutable source revisions. Do not commit artifacts. Compare these arms without giving candidates to the writer or changing production output:

1. current production README/evidence behavior;
2. **hygiene-only control:** filtered history contributes no companion;
3. deterministic mock orientation with `pair-relative-v1` candidates under the inactive rendering contract;
4. the same mock orientation with `repository-window-v1`.

Reviewers are blinded to selector/arm. Use frozen historical cutoffs for routing tasks. A candidate is “usable” only if it both passes mechanically and can annotate an independently justified frozen baseline route under the future policy.

Pair-relative remains primary unless all of these minimum observation conditions are met: at least 14 calendar days; at least 20 distinct source-revision snapshots across the configured fleet; at least two snapshots for every configured repository; at least two thirds of configured repositories have a snapshot retaining 60 or more eligible diffs; and at least 10 usable primary snapshots span at least three repositories. Fractions round up. This only permits comparison; it does not cause a switch.

For every candidate, replay Git evidence. Mechanical truth must be 100%, with zero missing-current-path, self/generated/lock/vendor leak, arithmetic, or band errors. Measure and retain separately:

- abstention, qualifying yield, usable yield, pair count, output bytes, and analyzer failures;
- invariance after synthetic README-only, listed-lock-only, excluded-generated-only, unrelated eligible singleton, and bulk diffs, plus one-event window-boundary perturbations; score only invariance the policy promises;
- blinded routing-task correctness and time to name a baseline start path and one reasonable inspection companion;
- reviewer reports of dependency, required-edit, task, ownership, risk, coverage, causal, or semantic inference;
- mock README words, bytes, links, changed lines, and useful route decisions per line;
- analyzer wall time, with the preregistered rejection bound of 5 seconds at p95 or twice baseline harvest p95, whichever is larger.

A global switch to repository-window requires: the same 100% mechanical truth; no lower promised-perturbation invariance; no increase in misleading-inference rate; no increase in median words, bytes, or links and at least 90% of outputs no longer than production; and either at least a 10 percentage-point routing-correctness gain with no slower median time, or at least a 15% median-time reduction with correctness no more than two percentage points lower. It must also outperform the hygiene-only control. The decision is global and versioned, never per repository.

Reject publication and keep the hygiene-only result if candidate arms do not improve routing over both production and hygiene-only, if truth is below 100%, if misleading inference is material, if irrelevant activity commonly changes promised facts, if density grows, if fewer than three configured repositories produce reviewer-rated-useful annotations, or if latency exceeds the bound. No threshold may be tuned on held-out outcomes.

## Explicit omissions and open costs

Do not build churn/heat dashboards, line-count or age metrics, velocity/volatility, author/ownership/bus-factor measures, blame, risk/defect/coverage predictions, commit-message classification, CODEOWNERS interpretation, source/history prose inspection, learned generated classifiers, rename matching, directory rollups, co-change graphs, clustering, timelines, composite scores, network integrations, or repository-specific tuning.

The main cost is up to 400 bounded local diff queries plus at most 250,000 pair observations. First-parent diffs fit merge-mainline workflows but do not turn fast-forward commits into task units. Exact files maximize auditability but may produce low yield. Strict exclusions and limits prefer false negatives; shadow yield and latency decide whether even this small observation is worth retaining.
