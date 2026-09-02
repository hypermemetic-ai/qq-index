/**
 * Alpha.4 source reconciliation for one compiled view.
 *
 * Query serving never imports or calls this adapter. It is a private materializer
 * using stock dsh-v0.1.2-alpha.4 observeSession leases. Projection semantics stay
 * in the supplied compiled view projector.
 */

const DEFAULT_MAX_PARTITIONS = 100_000;
const DEFAULT_BATCH_SIZE = 32;
const MAX_TIMING_RECORDS = 64;

export function createDshAlpha4ViewSource(options) {
  exactObject(options, [
    "sessionQuery", "subscribe", "client", "view", "projectObservation", "sourceIdentity",
  ], ["listSourceRecords", "maxPartitions", "batchSize", "now"], "alpha4 view source options");
  object(options.sessionQuery, "sessionQuery");
  callable(options.sessionQuery.observeSession, "sessionQuery.observeSession");
  callable(options.sessionQuery.listSessions, "sessionQuery.listSessions");
  callable(options.subscribe, "subscribe");
  object(options.client, "client");
  for (const method of ["viewPartitionState", "mutateView", "setViewLifecycle"]) callable(options.client[method], `client.${method}`);
  validateView(options.view);
  callable(options.projectObservation, "projectObservation");
  callable(options.sourceIdentity, "sourceIdentity");
  if (options.listSourceRecords !== undefined) callable(options.listSourceRecords, "listSourceRecords");
  const maxPartitions = boundedInteger(options.maxPartitions, DEFAULT_MAX_PARTITIONS, 1, DEFAULT_MAX_PARTITIONS, "maxPartitions");
  const batchSize = boundedInteger(options.batchSize, DEFAULT_BATCH_SIZE, 1, 64, "batchSize");
  const now = options.now ?? (() => Date.now());
  callable(now, "now");

  let phase = "idle";
  let disposed = false;
  let subscription = null;
  let startPromise = null;
  let tail = Promise.resolve();
  let buffered = new Map();
  let counters = freshCounters();
  const timings = [];
  const abortController = new AbortController();

  const status = () => deepFreeze({
    phase,
    ...counters,
    bufferedPartitions: buffered.size,
    timings: timings.map((record) => ({ ...record })),
  });

  const recordTiming = (operation, started, outcome, counts = {}) => {
    const elapsedMs = Math.max(0, now() - started);
    const boundedCounts = {};
    for (const [key, value] of Object.entries(counts)) {
      if (Number.isSafeInteger(value) && value >= 0) boundedCounts[key] = value;
    }
    timings.push(Object.freeze({ operation, outcome, elapsedMs, counts: Object.freeze(boundedCounts) }));
    if (timings.length > MAX_TIMING_RECORDS) timings.splice(0, timings.length - MAX_TIMING_RECORDS);
  };

  const scheduleBuffered = () => {
    if (disposed || phase !== "live" || buffered.size === 0) return;
    const pending = [...buffered.values()];
    buffered = new Map();
    for (const change of pending) {
      tail = tail.then(() => reconcileChange(change)).catch((error) => fail(error));
    }
  };

  const enqueue = (change) => {
    if (disposed) return;
    const normalized = normalizeChange(change);
    if (normalized === null) return;
    buffered.set(normalized.sessionId, normalized);
    scheduleBuffered();
  };

  async function listSourceRecords(signal) {
    if (options.listSourceRecords !== undefined) return options.listSourceRecords(signal);
    const records = await options.sessionQuery.listSessions(signal);
    if (!Array.isArray(records)) throw new TypeError("sessionQuery.listSessions must return an array");
    return records.map((record) => ({
      sessionId: sessionIdOf(record?.header, "session record header"),
      record,
    }));
  }

  async function start() {
    if (disposed) throw coded("source_disposed", "alpha4 view source is disposed");
    if (startPromise !== null) return startPromise;
    startPromise = (async () => {
      const started = now();
      phase = "subscribing";
      try {
        // Load-bearing order: subscribe before discovering the backfill fence.
        subscription = normalizeDisposer(await options.subscribe(enqueue));
        phase = "backfill";
        const records = await listSourceRecords(abortController.signal);
        validateSourceRecords(records, maxPartitions);
        counters.recordsListed += records.length;
        for (let offset = 0; offset < records.length; offset += batchSize) {
          throwIfAborted(abortController.signal);
          const batch = records.slice(offset, offset + batchSize);
          const states = await options.client.viewPartitionState({
            view: options.view,
            partitionKeys: batch.map(({ sessionId }) => sessionId),
          }, { signal: abortController.signal });
          const byPartition = new Map(states.partitions.map((state) => [state.partitionKey, state]));
          for (const record of batch) await reconcileRecord(record, byPartition.get(record.sessionId));
        }
        phase = "catching-up";
        while (buffered.size > 0) {
          const pending = [...buffered.values()];
          buffered = new Map();
          for (const change of pending) await reconcileChange(change);
        }
        const sourceFence = fenceFor(records, now);
        await options.client.setViewLifecycle({
          view: options.view,
          state: "ready",
          sourceFence,
          lagMs: 0,
        }, { signal: abortController.signal });
        // No await may separate this transition from scheduling leftovers: a
        // callback during lifecycle activation was buffered while catching up,
        // while every subsequent callback observes live and schedules itself.
        phase = "live";
        scheduleBuffered();
        recordTiming("startup-reconciliation", started, "ok", {
          listed: records.length,
          observed: counters.partitionsObserved,
          skipped: counters.partitionsSkipped,
          committed: counters.partitionsCommitted,
        });
        return status();
      } catch (error) {
        // close() is the only transition that sets disposed. Its abort ends any
        // in-flight startup work, but must not poison the last committed build.
        // All errors observed before that transition remain fail-closed.
        const closed = disposed;
        if (!closed) phase = "failed";
        recordTiming("startup-reconciliation", started, closed ? "disposed" : "error", {
          observed: counters.partitionsObserved,
          committed: counters.partitionsCommitted,
        });
        if (!closed) await markFailed().catch(() => {});
        throw error;
      }
    })();
    return startPromise;
  }

  async function reconcileRecord(record, durable) {
    const started = now();
    const sourceIdentity = checkedIdentity(options.sourceIdentity(record.record ?? record));
    if (canSkip(record, durable, sourceIdentity)) {
      counters.partitionsSkipped += 1;
      recordTiming("partition-reconciliation", started, "unchanged", { observed: 0, committed: 0 });
      return;
    }
    await replaceObserved(record.sessionId, sourceIdentity);
    recordTiming("partition-reconciliation", started, "replaced", { observed: 1, committed: 1 });
  }

  async function reconcileChange(change) {
    const started = now();
    if (change.kind === "delete") {
      const states = await options.client.viewPartitionState({
        view: options.view,
        partitionKeys: [change.sessionId],
      }, { signal: abortController.signal });
      const durable = states.partitions[0];
      if (durable === undefined) {
        recordTiming("live-reconciliation", started, "missing", { committed: 0 });
        return;
      }
      await options.client.mutateView({
        kind: "deletePartition",
        view: options.view,
        partitionKey: change.sessionId,
        expectedCursor: durable.nextCursor,
        sourceIdentity: durable.sourceIdentity,
        sourceFence: `alpha4-delete:${now()}`,
        lagMs: 0,
      }, { signal: abortController.signal });
      counters.partitionsDeleted += 1;
      recordTiming("live-reconciliation", started, "deleted", { committed: 1 });
      return;
    }
    const sourceIdentity = checkedIdentity(options.sourceIdentity(change.source ?? { id: change.sessionId }));
    await replaceObserved(change.sessionId, sourceIdentity);
    recordTiming("live-reconciliation", started, "replaced", { observed: 1, committed: 1 });
  }

  async function replaceObserved(sessionId, sourceIdentity) {
    throwIfAborted(abortController.signal);
    const observation = await options.sessionQuery.observeSession(sessionId, {
      signal: abortController.signal,
      projectionMode: "all",
    });
    counters.partitionsObserved += 1;
    try {
      validateObservation(observation, sessionId);
      const projected = await options.projectObservation(observation, {
        sessionId,
        sourceIdentity,
        signal: abortController.signal,
      });
      exactObject(projected, ["rows"], ["durableRevision"], "projected observation");
      if (!Array.isArray(projected.rows) || projected.rows.length > 1_024) {
        throw new TypeError("projected observation rows must contain 0..1024 entries");
      }
      jsonBound(projected.rows, "projected observation rows");
      const durableRevision = revisionOf(projected.durableRevision ?? observation.revision, observation);
      const nextCursor = observation.cursor + 1;
      await options.client.mutateView({
        kind: "replacePartition",
        view: options.view,
        partitionKey: sessionId,
        source: {
          sourceIdentity,
          durableRevision,
          nextCursor: String(nextCursor),
          sourceFence: `alpha4-observation:${durableRevision}:${nextCursor}`,
          lagMs: 0,
        },
        rows: projected.rows,
      }, { signal: abortController.signal });
      counters.partitionsCommitted += 1;
    } finally {
      disposeObservation(observation);
    }
  }

  async function markFailed() {
    await options.client.setViewLifecycle({
      view: options.view,
      state: "failed",
      sourceFence: `alpha4-failed:${now()}`,
      lagMs: Number.MAX_SAFE_INTEGER,
    });
  }

  async function close() {
    if (disposed) return;
    disposed = true;
    phase = "disposing";
    abortController.abort(coded("source_disposed", "alpha4 view source closed"));
    await Promise.resolve(subscription?.()).catch(() => {});
    await tail.catch(() => {});
    buffered.clear();
    phase = "disposed";
  }

  async function fail(error) {
    // A close-triggered abort still rejects the queued work so close() can
    // drain it, but the durable view lifecycle and committed build stay intact.
    if (disposed) throw error;
    phase = "failed";
    await markFailed().catch(() => {});
    throw error;
  }

  return Object.freeze({ start, close, status });
}

function canSkip(record, durable, sourceIdentity) {
  if (durable === undefined) return false;
  if (record.durableRevision === undefined || record.nextCursor === undefined) return false;
  canonicalUnsigned(record.nextCursor, "source record nextCursor");
  return durable.sourceIdentity === sourceIdentity
    && durable.durableRevision === record.durableRevision
    && durable.nextCursor === String(record.nextCursor);
}

function validateSourceRecords(records, maximum) {
  if (!Array.isArray(records) || records.length > maximum) throw new TypeError(`source records exceed ${maximum}`);
  const ids = new Set();
  for (const [index, record] of records.entries()) {
    exactObject(record, ["sessionId"], ["record", "durableRevision", "nextCursor"], `source records[${index}]`);
    text(record.sessionId, `source records[${index}].sessionId`, 1, 128);
    if (!ids.add(record.sessionId)) throw new TypeError("source records contain duplicate sessionId");
    if ((record.durableRevision === undefined) !== (record.nextCursor === undefined)) {
      throw new TypeError("source record revision and nextCursor must be supplied together");
    }
    if (record.durableRevision !== undefined) text(record.durableRevision, "source durableRevision", 1, 4_096);
    if (record.nextCursor !== undefined) canonicalUnsigned(record.nextCursor, "source nextCursor");
  }
}

function validateObservation(observation, expectedId) {
  object(observation, "SessionObservation");
  if (!["live", "prepared"].includes(observation.source)) throw new TypeError("SessionObservation.source is invalid");
  const observedId = sessionIdOf(observation.header, "SessionObservation.header");
  if (observedId !== expectedId) throw new TypeError("SessionObservation header id mismatch");
  if (!Array.isArray(observation.events)) throw new TypeError("SessionObservation.events must be an array");
  if (!Number.isSafeInteger(observation.cursor) || observation.cursor < -1) throw new TypeError("SessionObservation.cursor is invalid");
  if (observation.cursor + 1 !== observation.events.length) {
    throw new TypeError("SessionObservation cursor/events are not contiguous from zero");
  }
  if (observation.revision !== undefined) text(observation.revision, "SessionObservation.revision", 1, 4_096);
}

function normalizeChange(change) {
  if (change === null || change === undefined) return null;
  if (typeof change === "string") return { kind: "upsert", sessionId: change, source: { id: change } };
  object(change, "source change");
  const kind = change.kind === "delete" ? "delete" : "upsert";
  const sessionId = change.sessionId ?? change.id ?? change.header?.id;
  text(sessionId, "source change sessionId", 1, 128);
  return { kind, sessionId, source: change.source ?? change };
}

function fenceFor(records, now) {
  // A global alpha.4 corpus fence does not exist. Subscription-before-list and
  // drain establish this adapter-local fence; the record count is non-sensitive.
  return `alpha4-subscribe-list-drain:${now()}:${records.length}`;
}

function revisionOf(value, observation) {
  if (value === undefined) {
    // Live observations may not have a persistence revision. A compiled projector
    // must supply a deterministic cut revision in that case.
    throw new TypeError(`projector must supply durableRevision for ${observation.source} observation`);
  }
  text(value, "projected durableRevision", 1, 4_096);
  return value;
}

function disposeObservation(observation) {
  if (typeof observation?.[Symbol.dispose] === "function") observation[Symbol.dispose]();
  else if (typeof observation?.dispose === "function") observation.dispose();
  else throw new TypeError("SessionObservation must be disposable");
}

function sessionIdOf(header, name) {
  object(header, name);
  const id = header.id ?? header.sessionId;
  text(id, `${name}.id`, 1, 128);
  return id;
}

function checkedIdentity(value) {
  text(value, "source identity", 1, 4_096);
  return value;
}

function normalizeDisposer(value) {
  if (typeof value === "function") return value;
  if (typeof value?.dispose === "function") return () => value.dispose();
  if (typeof value?.unsubscribe === "function") return () => value.unsubscribe();
  throw new TypeError("subscribe must return a disposer");
}

function freshCounters() {
  return {
    recordsListed: 0,
    partitionsObserved: 0,
    partitionsSkipped: 0,
    partitionsCommitted: 0,
    partitionsDeleted: 0,
  };
}

function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason ?? coded("aborted", "operation aborted");
}

function canonicalUnsigned(value, name) {
  const string = typeof value === "number" ? String(value) : value;
  if (typeof string !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(string)) throw new TypeError(`${name} must be canonical unsigned decimal`);
  const parsed = BigInt(string);
  if (parsed > 9_223_372_036_854_775_807n) throw new TypeError(`${name} exceeds SQLite range`);
}

function jsonBound(value, name) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 900 * 1_024) throw new TypeError(`${name} exceeds payload bound`);
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be ${minimum}..${maximum}`);
  return value;
}

function validateView(view) {
  exactObject(view, ["id", "version"], [], "view");
  text(view.id, "view.id", 1, 128);
  if (!Number.isSafeInteger(view.version) || view.version < 1) throw new TypeError("view.version must be positive");
}

function exactObject(value, required, optional, name) {
  object(value, name);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${name}.${key} is required`);
}

function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
}

function text(value, name, minimum, maximum) {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError(`${name} must be a NUL-free string`);
  const size = Buffer.byteLength(value, "utf8");
  if (size < minimum || size > maximum) throw new TypeError(`${name} must contain ${minimum}..${maximum} bytes`);
}

function callable(value, name) { if (typeof value !== "function") throw new TypeError(`${name} must be a function`); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
