# Production session-index runtime and daemon

This is the production lifecycle for QQ's derived DSH session-history index. It is separate from the existing `qq-index` README refresh service and timer. It does not grant workspace access or make an index hit authoritative; qq-core remains responsible for authorization and presentation, and exact DSH verification remains required for returned candidates. The injected canonical helpers provide a package-resolution-independent boundary for consumers such as qq-core; this repository change does not by itself claim that qq-core's `/find-session` cutover is complete.

## Plugin configuration and service contract

The plugin still has `name = "qq-index"`, `inject = []`, `provide = "qq-index"`, and provides the frozen `{ loadIndex, validateIndex }` service unchanged. It additionally always provides a separate frozen `qq-session-index` capability service:

- `status()` is synchronous. It returns only `enabled`, phase/readiness, capability validation, bounded daemon/source counters, active-client/restart counters, and bounded error class/code. It never returns socket/database/corpus paths, session ids, query literals, result bodies, or raw errors/stacks.
- `ready()` is a synchronous bounded readiness observation. It is true only after daemon protocol/schema/capability validation **and** subscribe-before-list source sync reaches `live`.
- `health({ timeoutMs?, deadlineUnixMs?, signal? }?)` opens a short-lived client, validates daemon health, returns the validated path-free health response, and always closes the client. It may be used while the source is recovering; it is not readiness.
- `searchBatch(request, { timeoutMs?, deadlineUnixMs?, signal? }?)` is the policy-neutral daemon request. It fails closed unless ready and capability-valid, opens one independent short-lived client per call, forwards abort/deadline controls, and always closes it. Concurrent calls can therefore occupy different daemon readers; the source writer connection is never used for search.
- `restart()` serializes callers onto one immediate source/daemon reattachment. It fails closed when disabled, disposing, or `sessionQuery` is absent.
- `deriveWorkspaceScopeToken(workspaceId)` is the canonical policy-neutral, domain-separated workspace identity derivation used at ingest. The service property is the existing exported helper itself, not a duplicate implementation.
- `verifyDshSearchCandidates({ searchResponse, sessionQuery, literals, eventTypeAllowList, surfaceAllowList, maxConcurrency?, maxCandidates?, signal?, extractSessionEventText? })` is the canonical bounded exact-source verifier. It omits stale, malformed, mismatched, or ordinarily unreadable evidence; cancellation rejects the complete operation rather than returning partial candidates. The service property is the existing exported helper itself.

Session indexing is inert unless the boolean is exactly true. Enabled configuration requires an explicit absolute socket path:

```js
{
  sessionIndex: {
    enabled: true,
    socketPath: `/run/user/${process.getuid()}/qq-index/session-index.sock`,
    connectTimeoutMs: 2_000,             // 25..600000
    requestTimeoutMs: 5_000,             // 25..600000
    monitorIntervalMs: 5_000,            // 100..600000
    restartInitialBackoffMs: 250,         // 10..60000
    restartMaxBackoffMs: 10_000,          // 10..60000, >= initial
    // Optional source bounds:
    maxBatchDocuments: 256,               // 1..1024
    maxBatchPayloadBytes: 786_432,         // 1024..921600
    maxBufferedSessions: 4_096,            // 1..4096
    maxCorpusSessions: 100_000,            // 1..100000
  },
}
```

With `enabled: false` or no `sessionIndex` block, the capability service reports `disabled` and no injection, timer, socket, database, corpus list/read, daemon, or client is touched. The pure `deriveWorkspaceScopeToken` and caller-supplied, bounded `verifyDshSearchCandidates` capabilities remain available in this state; they do not depend on daemon lifecycle or readiness. `searchBatch`, `health`, and `restart` continue to reject as disabled. With `enabled: true` but no optional `sessionQuery` service, it reports `waiting-session-query`; the original README service continues to work.

The runtime uses Cordis `ctx.inject(["sessionQuery"], ...)`, subscribes to `session/created`, `session/event`, and `session/disposed` before listing, and removes all three listeners when the injected generation or plugin is disposed. One unref'd monitor/backoff timer probes the dedicated writer connection. A daemon restart invalidates that connection, makes searches fail closed, and triggers bounded reattachment without restarting the DSH host.

## DSH rc.7 projection and verification

`@deepseek-ai/dsh-session-query` is pinned exactly to `0.1.0-rc.7` in `package.json`; `package-lock.json` pins its complete required peer/dependency closure and integrity hashes. Use `npm ci`, not a sibling checkout's `node_modules`.

The source accepts production `SessionRecord.header.id` listings and `readSession(id) -> { session, events }`. It calls both projection helpers as `(sessionId, events)`, uses record/document `type`, `time`, and `surface`, and uses semantic-document `text` as authoritative. Every contiguous raw sequence still receives an index row; structural rows have an empty body. `session.cwd` must be a usable absolute workspace identity. A missing or relative production cwd is skipped and never receives a global scope. The existing opaque digest token is derived from cwd without exposing it.

Exact verification first feature-detects `readEventDocumentSnapshots(requests, signal?)`. It groups fused-referenced coordinates by session, uses one call for the normal at-most-256-coordinate set, and deterministically chunks larger configured sets without exceeding the upstream bound. Tagged session rejections and omitted seqs fail only affected candidates closed; malformed settlement/header/document/title structure rejects the complete operation. Verified evidence carries authoritative safe event time and a literal-centered whitespace-normalized snippet bounded to 320 UTF-16 code units and 1280 UTF-8 bytes. A settlement title is exposed only as a trimmed, prefix-clipped string bounded to 256 code units and 1024 bytes.

When that grouped capability is absent, verification retains the bounded `filterEvents(sessionId, [{ kind: "seq", from, to }])` / `readEvent` worker fallback. rc.7 `filterEvents` has no signal position, so abort stops new work and rejects after the at-most-`maxConcurrency` current reads settle; rc.7 `readEvent(request, signal?)` receives the signal in its supported second position. Missing, stale, duplicate, malformed, or mismatched fallback observations fail closed. The old generated positional `readEvent` shape remains compatibility-only; a real raw `readEvent({ sessionId, seq, before, after }).target` has no authoritative surface and therefore cannot by itself authorize evidence.

Current caveat: disposal does not delete durable rows and targeted surface repair is not implemented. Such current/shadowed/stale hits remain candidates only and must pass exact current-source verification. This is intentionally not a policy grant.

## Build, install, enable, and start the user daemon

The launcher defaults are:

- binary: `<package-root>/target/release/qq-session-indexd`
- socket: `$XDG_RUNTIME_DIR/qq-index/session-index.sock` (normally `%t/qq-index/session-index.sock`)
- database: `${XDG_STATE_HOME:-$HOME/.local/state}/qq-index/session-index.db`
- readers: `4`; queue capacity: `64`

Perform the release build once after checkout/update:

```sh
cd "$HOME/projects/qq-index"
npm ci
cargo build --release --locked --package qq-session-indexd --bin qq-session-indexd
```

Install and start the dedicated unit (do not replace the unrelated `qq-index.service` README refresh oneshot):

```sh
install -d -m 0700 "$HOME/.config/systemd/user"
install -m 0600 systemd/user/qq-session-indexd.service \
  "$HOME/.config/systemd/user/qq-session-indexd.service"
systemctl --user daemon-reload
systemctl --user enable --now qq-session-indexd.service
systemctl --user status qq-session-indexd.service
```

The user unit sets `UMask=0077`, requests owner-only `RuntimeDirectory=qq-index` and `StateDirectory=qq-index`, uses `Restart=on-failure` with a two-second delay and bounded systemd start burst, forwards `SIGTERM`, and gives graceful shutdown 15 seconds. The Rust socket guard unlinks only the same owner-owned socket inode it bound, so shutdown cannot unlink a replacement.

The launcher only inspects and plans. A missing database receives explicit `--create`; a private owner-owned single-link regular file receives explicit `--open`, whose application-id/schema validation is performed by the daemon before use. Symlink, non-regular, hard-linked, permissive, foreign-owner, relative, pre-existing socket, and out-of-range resource inputs are rejected. It never creates a parent, adopts/deletes an arbitrary file, or unlinks a socket occupant.

Preview a plan without starting a child:

```sh
bin/qq-session-indexd-launch --plan
```

Absolute overrides are available as `QQ_SESSION_INDEXD_BIN`, `QQ_SESSION_INDEX_SOCKET`, `QQ_SESSION_INDEX_DATABASE`, `QQ_SESSION_INDEX_READERS`, and `QQ_SESSION_INDEX_QUEUE_CAPACITY`. For custom socket/database parents, create owner-only directories first. Set overrides with a user-unit drop-in, then reload/restart:

```ini
# systemctl --user edit qq-session-indexd.service
[Service]
Environment=QQ_SESSION_INDEXD_BIN=/absolute/path/qq-session-indexd
Environment=QQ_SESSION_INDEX_SOCKET=/absolute/private/runtime/session-index.sock
Environment=QQ_SESSION_INDEX_DATABASE=/absolute/private/state/session-index.db
Environment=QQ_SESSION_INDEX_READERS=4
Environment=QQ_SESSION_INDEX_QUEUE_CAPACITY=64
```

```sh
systemctl --user daemon-reload
systemctl --user restart qq-session-indexd.service
```

Do not manually remove an unexplained socket/database. After an unclean kill, inspect ownership/type and the journal before removing only a known stale generated socket; the launcher deliberately refuses to make that decision.

## Rollback

First set `sessionIndex.enabled` to `false` (there is no fallback to the old DSH FTS provider) and reload the host. Then stop/disable and remove only this dedicated unit:

```sh
systemctl --user disable --now qq-session-indexd.service
rm -f "$HOME/.config/systemd/user/qq-session-indexd.service"
systemctl --user daemon-reload
systemctl --user reset-failed qq-session-indexd.service
```

Restore the prior qq-index package revision if needed. Leave the derived database in place for investigation or a later reopen; rollback never requires deleting it. Remove it only through an explicit operator decision after verifying the exact private regular target.
