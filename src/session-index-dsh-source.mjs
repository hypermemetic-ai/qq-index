import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export const DSH_SESSION_INDEX_PROJECTION_VERSION = "qq-session-dsh-projection-v1";
export const DSH_SESSION_INDEX_DEFAULT_BATCH_DOCUMENTS = 256;
export const DSH_SESSION_INDEX_MAX_BATCH_DOCUMENTS = 1_024;
export const DSH_SESSION_INDEX_MAX_BUFFERED_SESSIONS = 4_096;
export const DSH_SESSION_INDEX_MAX_SOURCE_STATE_SESSIONS = 32;

const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;
const MAX_SESSION_ID_BYTES = 128;
const MAX_WORKSPACE_ID_BYTES = 4_096;
const MAX_EVENT_TYPE_BYTES = 96;
const MAX_SURFACE_BYTES = 64;
const MAX_BODY_BYTES = 1_048_576;
const MAX_BATCH_PAYLOAD_BYTES = 768 * 1_024;
const MAX_CORPUS_SESSIONS = 100_000;
const MAX_EXACT_CANDIDATES = 1_024;
const MAX_EXACT_CONCURRENCY = 32;
const MAX_SNAPSHOT_GROUPS = 256;
const MAX_SNAPSHOT_COORDINATES = 256;
const MAX_SNIPPET_CODE_UNITS = 320;
const MAX_SNIPPET_BYTES = 1_280;
const MAX_TITLE_CODE_UNITS = 256;
const MAX_TITLE_BYTES = 1_024;
const MAX_TITLE_SOURCE_SEQS = 4_096;
const LIVE_TOPICS = new Set(["session/created", "session/event", "session/disposed"]);

/**
 * Derive the opaque workspace scope term attached by qq-index at ingest.
 *
 * The domain-separated digest deliberately does not expose the workspace ID and
 * contains only lowercase ASCII alphanumerics accepted by the storage contract.
 * This function derives identity only; it does not evaluate a grant or policy.
 */
export function deriveWorkspaceScopeToken(workspaceId) {
  boundedString(workspaceId, "workspaceId", 1, MAX_WORKSPACE_ID_BYTES);
  const digest = createHash("sha256")
    .update("qq-index-workspace-scope-v1\0", "utf8")
    .update(workspaceId, "utf8")
    .digest("hex");
  return `w${digest.slice(0, 63)}`;
}

/**
 * Project a complete generated/DSH session log to one contiguous index row per
 * raw sequence number. Injected helpers use the same mechanical contracts as
 * dsh-session-query's record/document/text helpers.
 */
export async function projectDshSessionLog({ sessionId, sessionLog, projectionHelpers }) {
  boundedString(sessionId, "sessionId", 1, MAX_SESSION_ID_BYTES);
  plainObject(sessionLog, "sessionLog");
  validateProjectionHelpers(projectionHelpers);

  const productionShape = isProductionSessionLog(sessionLog);
  if (productionShape && sessionLog.session.id !== sessionId) {
    throw new TypeError("session log header id does not match sessionId");
  }
  const workspaceId = productionShape
    ? usableProductionWorkspace(sessionLog.session.cwd)
    : usableGeneratedWorkspace(sessionLog);
  // A session without a policy-neutral workspace identity must never enter the
  // global derived index. This is a skip, not a source-wide failure.
  if (workspaceId === null) return [];

  const builtRecords = productionShape
    ? await projectionHelpers.buildSessionEventRecords(sessionId, sessionLog.events)
    : await projectionHelpers.buildSessionEventRecords(sessionLog);
  const records = arrayResult(builtRecords, "records", "buildSessionEventRecords");
  const builtDocuments = productionShape
    ? await projectionHelpers.buildSessionEventSearchDocuments(sessionId, sessionLog.events)
    : await projectionHelpers.buildSessionEventSearchDocuments(records, sessionLog);
  const semanticDocuments = arrayResult(
    builtDocuments,
    "documents",
    "buildSessionEventSearchDocuments",
  );
  if (records.length > Number(MAX_SQLITE_INTEGER)) {
    throw new TypeError("raw event count exceeds the supported sequence range");
  }

  const recordsBySeq = new Map();
  for (const [index, record] of records.entries()) {
    plainObject(record, `raw records[${index}]`);
    const seq = eventSequence(record, `raw records[${index}]`);
    if (seq !== BigInt(index)) {
      throw new TypeError("raw session records must be complete, ordered, and contiguous from seq zero");
    }
    recordsBySeq.set(seq.toString(), record);
  }

  const semanticBySeq = new Map();
  for (const [index, document] of semanticDocuments.entries()) {
    plainObject(document, `search documents[${index}]`);
    const seq = eventSequence(document, `search documents[${index}]`);
    const key = seq.toString();
    if (!recordsBySeq.has(key) || semanticBySeq.has(key)) {
      throw new TypeError("search documents must uniquely reference raw session records");
    }
    semanticBySeq.set(key, document);
  }

  const projected = [];
  for (const [index, record] of records.entries()) {
    const name = `raw records[${index}]`;
    const seq = BigInt(index);
    const semantic = semanticBySeq.get(seq.toString());
    const eventType = firstString(record.eventType, record.event?.eventType, record.event?.type, record.type);
    boundedString(eventType, `${name}.eventType`, 1, MAX_EVENT_TYPE_BYTES);
    const surface = firstString(record.surface, record.event?.surface);
    boundedString(surface, `${name}.surface`, 1, MAX_SURFACE_BYTES);
    const eventTimeUnixMs = eventTime(record, name);

    let body = "";
    if (semantic !== undefined) {
      // rc.7 semantic documents already own the authoritative projection text.
      // The helper remains only for generated pre-rc compatibility.
      const extracted = typeof semantic.text === "string"
        ? semantic.text
        : await projectionHelpers.extractSessionEventText(semantic, record);
      if (extracted !== null && extracted !== undefined) {
        if (typeof extracted !== "string") {
          throw new TypeError("semantic text projection must be a string, null, or undefined");
        }
        body = extracted;
      }
    }
    boundedString(body, `${name}.body`, 0, MAX_BODY_BYTES);

    const generated = {
      projectionVersion: DSH_SESSION_INDEX_PROJECTION_VERSION,
      sessionId,
      seq: seq.toString(),
      eventTimeUnixMs,
      eventType,
      surface,
      workspaceId,
      body,
    };
    const fingerprint = digestCanonical("qq-index-dsh-event-fingerprint-v1", generated);
    const sourceRevision = digestCanonical("qq-index-dsh-source-revision-v1", generated);
    projected.push({
      sessionId,
      seq: seq.toString(),
      eventTimeUnixMs,
      eventType,
      surface,
      workspaceId,
      scopeTokens: [deriveWorkspaceScopeToken(workspaceId)],
      body,
      fingerprint: `sha256:${fingerprint}`,
      sourceRevision: `sha256:${sourceRevision}`,
    });
  }
  return projected;
}

/**
 * Create a fenced, resumable DSH-to-daemon lifecycle.
 *
 * subscribe(listener) may call listener(notification) or listener(topic, payload)
 * for session/created, session/event, and session/disposed. It may return an
 * unsubscribe function or an object with unsubscribe().
 */
export function createDshSessionIndexSource(options) {
  return new DshSessionIndexSource(options);
}

class DshSessionIndexSource {
  #sessionQuery;
  #subscribe;
  #providedClient;
  #clientFactory;
  #client = null;
  #ownsClient = false;
  #helpers;
  #unsubscribe = null;
  #abortController = null;
  #tail = Promise.resolve();
  #buffered = new Set();
  #disposed = new Set();
  #drainScheduled = false;
  #started = false;
  #paused = false;
  #closed = false;
  #maxBatchDocuments;
  #maxBatchPayloadBytes;
  #maxBufferedSessions;
  #maxCorpusSessions;
  #state = {
    phase: "idle",
    sessionsScanned: 0,
    eventsCommitted: 0,
    documentsCommitted: 0,
    watermark: "0",
    lastError: null,
  };

  constructor(options) {
    plainObject(options, "options");
    plainObject(options.sessionQuery, "options.sessionQuery");
    callable(options.sessionQuery.listSessions, "options.sessionQuery.listSessions");
    callable(options.sessionQuery.readSession, "options.sessionQuery.readSession");
    if (options.subscribe !== undefined) callable(options.subscribe, "options.subscribe");
    if (options.client === undefined && options.clientFactory === undefined) {
      throw new TypeError("options must provide client or clientFactory");
    }
    if (options.client !== undefined) validateIndexClient(options.client);
    if (options.clientFactory !== undefined) callable(options.clientFactory, "options.clientFactory");
    if (options.projectionHelpers !== undefined) validateProjectionHelpers(options.projectionHelpers);

    this.#sessionQuery = options.sessionQuery;
    this.#subscribe = options.subscribe;
    this.#providedClient = options.client;
    this.#clientFactory = options.clientFactory;
    this.#helpers = options.projectionHelpers;
    this.#maxBatchDocuments = boundedOption(
      options.maxBatchDocuments,
      DSH_SESSION_INDEX_DEFAULT_BATCH_DOCUMENTS,
      1,
      DSH_SESSION_INDEX_MAX_BATCH_DOCUMENTS,
      "maxBatchDocuments",
    );
    this.#maxBatchPayloadBytes = boundedOption(
      options.maxBatchPayloadBytes,
      MAX_BATCH_PAYLOAD_BYTES,
      1_024,
      900 * 1_024,
      "maxBatchPayloadBytes",
    );
    this.#maxBufferedSessions = boundedOption(
      options.maxBufferedSessions,
      DSH_SESSION_INDEX_MAX_BUFFERED_SESSIONS,
      1,
      DSH_SESSION_INDEX_MAX_BUFFERED_SESSIONS,
      "maxBufferedSessions",
    );
    this.#maxCorpusSessions = boundedOption(
      options.maxCorpusSessions,
      MAX_CORPUS_SESSIONS,
      1,
      MAX_CORPUS_SESSIONS,
      "maxCorpusSessions",
    );
  }

  status() {
    return Object.freeze({
      phase: this.#state.phase,
      sessionsScanned: this.#state.sessionsScanned,
      eventsCommitted: this.#state.eventsCommitted,
      documentsCommitted: this.#state.documentsCommitted,
      bufferedSessions: this.#buffered.size,
      watermark: this.#state.watermark,
      lastError: this.#state.lastError === null
        ? null
        : Object.freeze({ ...this.#state.lastError }),
    });
  }

  async start() {
    if (this.#closed) throw new Error("DSH session-index source is closed");
    if (this.#started && !this.#paused) {
      await this.#tail;
      if (this.#state.phase === "error") throw new Error("DSH session-index source failed");
      return this.status();
    }
    this.#started = true;
    this.#paused = false;
    this.#state.lastError = null;
    this.#abortController = new AbortController();

    // The subscription is installed before the corpus listing is invoked. Awaiting
    // async subscription setup is safe because no list/read fence has started yet.
    this.#state.phase = "subscribing";
    try {
      await this.#ensureDependenciesAndSubscription();
    } catch (error) {
      this.#recordFailure(error);
      throw error;
    }
    return this.#enqueue(() => this.#runCorpusSync());
  }

  async sync() {
    if (this.#closed) throw new Error("DSH session-index source is closed");
    if (!this.#started || this.#paused) return this.start();
    return this.#enqueue(() => this.#runCorpusSync());
  }

  /** Probe the dedicated writer connection without rescanning the corpus. */
  async health(options = {}) {
    if (this.#closed || this.#paused || this.#state.phase !== "live") {
      throw new Error("DSH session-index source is not live");
    }
    if (typeof this.#client?.health !== "function") {
      throw new Error("DSH session-index source client has no health capability");
    }
    return this.#client.health(options);
  }

  async pause() {
    if (this.#closed || this.#paused) return;
    this.#paused = true;
    this.#abortController?.abort(new Error("source paused"));
    await this.#removeSubscription();
    await this.#tail.catch(() => {});
    if (!this.#closed) this.#state.phase = "paused";
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#paused = true;
    this.#state.phase = "closing";
    this.#abortController?.abort(new Error("source closed"));
    await this.#removeSubscription();
    await this.#tail.catch(() => {});
    if (this.#ownsClient && this.#client?.close) await this.#client.close().catch(() => {});
    this.#buffered.clear();
    this.#disposed.clear();
    this.#state.phase = "closed";
  }

  async #ensureDependenciesAndSubscription() {
    if (this.#helpers === undefined) {
      const imported = await import("@deepseek-ai/dsh-session-query");
      this.#helpers = {
        buildSessionEventRecords: imported.buildSessionEventRecords,
        buildSessionEventSearchDocuments: imported.buildSessionEventSearchDocuments,
        extractSessionEventText: imported.extractSessionEventText,
      };
      validateProjectionHelpers(this.#helpers);
    }
    if (this.#client === null) {
      this.#client = this.#providedClient ?? await this.#clientFactory();
      this.#ownsClient = this.#providedClient === undefined;
      validateIndexClient(this.#client);
    }
    if (this.#subscribe !== undefined && this.#unsubscribe === null) {
      const subscription = await this.#subscribe((...notification) => this.#onLive(...notification));
      if (typeof subscription === "function") this.#unsubscribe = subscription;
      else if (subscription?.unsubscribe instanceof Function) {
        this.#unsubscribe = () => subscription.unsubscribe();
      } else {
        this.#unsubscribe = async () => {};
      }
    }
  }

  async #removeSubscription() {
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    if (unsubscribe !== null) await unsubscribe();
  }

  #onLive(...notification) {
    if (this.#closed || this.#paused) return;
    try {
      const { topic, sessionId } = normalizeLiveNotification(notification);
      if (topic === "session/disposed") {
        this.#addBounded(this.#disposed, sessionId);
        return;
      }
      this.#addBounded(this.#buffered, sessionId);
      if (this.#state.phase === "live") this.#scheduleDrain();
    } catch (error) {
      this.#recordFailure(error);
      void this.#removeSubscription().catch(() => {});
    }
  }

  #addBounded(set, sessionId) {
    if (set.has(sessionId)) return;
    if (set.size >= this.#maxBufferedSessions) {
      throw new Error("bounded live session queue overflow");
    }
    set.add(sessionId);
  }

  #scheduleDrain() {
    if (this.#drainScheduled || this.#closed || this.#paused) return;
    this.#drainScheduled = true;
    void this.#enqueue(async () => {
      try {
        await this.#drainBuffered();
      } finally {
        this.#drainScheduled = false;
        if (this.#buffered.size > 0 && this.#state.phase === "live") this.#scheduleDrain();
      }
    }).catch(() => {});
  }

  #enqueue(task) {
    const result = this.#tail.then(async () => {
      if (this.#closed) return;
      try {
        return await task();
      } catch (error) {
        if (!this.#paused && !this.#closed) this.#recordFailure(error);
        throw error;
      }
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  async #runCorpusSync() {
    this.#assertActive();
    this.#state.phase = "listing";
    const listed = await this.#sessionQuery.listSessions(this.#abortController.signal);
    const sessionIds = await normalizeSessionList(listed, this.#maxCorpusSessions);

    // A later corpus sync is the only action caused by disposal. No delete is sent.
    for (const sessionId of sessionIds) this.#disposed.delete(sessionId);

    this.#state.phase = "scanning";
    const durable = await this.#readSourceStates(sessionIds);
    for (const sessionId of sessionIds) {
      this.#assertActive();
      await this.#syncSession(sessionId, durable.get(sessionId));
    }

    this.#state.phase = "draining";
    await this.#drainBuffered();
    this.#assertActive();
    this.#state.phase = "live";
    // No await occurs between the empty-queue observation in drain and this phase
    // transition, so a subsequent callback observes live and schedules another drain.
    if (this.#buffered.size > 0) this.#scheduleDrain();
    return this.status();
  }

  async #drainBuffered() {
    while (this.#buffered.size > 0) {
      this.#assertActive();
      const sessionIds = [...this.#buffered];
      this.#buffered.clear();
      for (let offset = 0; offset < sessionIds.length; offset += DSH_SESSION_INDEX_MAX_SOURCE_STATE_SESSIONS) {
        const chunk = sessionIds.slice(offset, offset + DSH_SESSION_INDEX_MAX_SOURCE_STATE_SESSIONS);
        const durable = await this.#readSourceStates(chunk);
        for (const sessionId of chunk) {
          this.#assertActive();
          await this.#syncSession(sessionId, durable.get(sessionId));
        }
      }
    }
  }

  async #readSourceStates(sessionIds) {
    const states = new Map();
    const chunks = sessionIds.length === 0
      ? [[]]
      : chunkArray(sessionIds, DSH_SESSION_INDEX_MAX_SOURCE_STATE_SESSIONS);
    for (const chunk of chunks) {
      const response = await this.#client.sourceState({ sessionIds: chunk });
      this.#observeWatermark(response.sourceWatermark);
      for (const state of response.sessions) states.set(state.sessionId, state);
    }
    return states;
  }

  async #syncSession(sessionId, durableState) {
    const sessionLog = await this.#sessionQuery.readSession(sessionId);
    const durableProduction = inspectDurableProductionSnapshot(sessionId, sessionLog, durableState);
    if (durableProduction !== null) {
      if (durableProduction.nextSeq > durableProduction.eventCount) {
        incrementCounter(this.#state, "sessionsScanned", 1);
        throw new Error("source log is shorter than its durable session cursor");
      }
      if (durableProduction.nextSeq === durableProduction.eventCount) {
        if (durableProduction.workspaceId !== durableProduction.durableWorkspaceId
            || durableProduction.workspaceScopeToken !== durableProduction.durableWorkspaceScopeToken) {
          incrementCounter(this.#state, "sessionsScanned", 1);
          throw new Error("source workspace does not match its durable session cursor");
        }
        // readSession is the authoritative, replay-validated production snapshot.
        // An exact durable cursor/workspace match proves there is no suffix to
        // project or commit. Count the completed read exactly as the full path does.
        incrementCounter(this.#state, "sessionsScanned", 1);
        return;
      }
    }

    const documents = await projectDshSessionLog({
      sessionId,
      sessionLog,
      projectionHelpers: this.#helpers,
    });
    incrementCounter(this.#state, "sessionsScanned", 1);
    const nextSeq = durableState === undefined ? 0n : parseUnsigned(durableState.nextSeq, "durable nextSeq");
    if (nextSeq > BigInt(documents.length)) {
      throw new Error("source log is shorter than its durable session cursor");
    }
    if (durableState !== undefined && documents.length > 0
        && durableState.workspaceId !== documents[0].workspaceId) {
      throw new Error("source workspace does not match its durable session cursor");
    }
    const suffix = documents.slice(Number(nextSeq));
    for (const batchDocuments of chunkDocuments(
      suffix,
      this.#maxBatchDocuments,
      this.#maxBatchPayloadBytes,
    )) {
      this.#assertActive();
      await this.#commit(batchDocuments);
    }
  }

  async #commit(documents) {
    if (documents.length === 0) return;
    const watermark = parseUnsigned(this.#state.watermark, "source watermark") + 1n;
    if (watermark > MAX_SQLITE_INTEGER) throw new Error("source watermark exhausted");
    const sourceWatermark = watermark.toString();
    const payloadFingerprint = `sha256:${digestCanonical("qq-index-dsh-batch-payload-v1", documents)}`;
    const idempotencyKey = `dshbatchv1:${digestCanonical("qq-index-dsh-batch-idempotency-v1", {
      sourceWatermark,
      payloadFingerprint,
      first: [documents[0].sessionId, documents[0].seq],
      last: [documents.at(-1).sessionId, documents.at(-1).seq],
    })}`;
    const receipt = await this.#client.applyBatch({
      idempotencyKey,
      payloadFingerprint,
      sourceWatermark,
      documents,
    });
    this.#observeWatermark(receipt.sourceWatermark);
    incrementCounter(this.#state, "eventsCommitted", documents.length);
    incrementCounter(this.#state, "documentsCommitted", documents.length);
  }

  #observeWatermark(value) {
    const observed = parseUnsigned(value, "source watermark");
    const current = parseUnsigned(this.#state.watermark, "source watermark");
    if (observed < current) throw new Error("daemon source watermark moved backwards");
    this.#state.watermark = observed.toString();
  }

  #assertActive() {
    if (this.#closed) throw new Error("DSH session-index source is closed");
    if (this.#paused || this.#abortController.signal.aborted) {
      throw new Error("DSH session-index source is paused");
    }
  }

  #recordFailure(error) {
    this.#paused = true;
    this.#abortController?.abort(new Error("source failed"));
    this.#state.phase = "error";
    this.#state.lastError = Object.freeze({
      name: boundedErrorField(error?.name, "Error"),
      code: boundedErrorField(error?.code, "source_error"),
    });
    void this.#removeSubscription().catch(() => {});
  }
}

/**
 * Exact-read verification for already-authorized search output.
 *
 * This helper never derives or grants access. The caller supplies the permitted
 * event types and surfaces. Exact reads are scheduled only for ranked source
 * pointers referenced by fused contributions; unused ranked hits cause no read.
 * Missing/stale source events and ordinary read failures are omitted (fail closed),
 * cancellation rejects the whole operation, and each (sessionId, seq) coordinate
 * is read once. options.signal is optional.
 */
export async function verifyDshSearchCandidates(options) {
  plainObject(options, "options");
  const signal = validateAbortSignal(options.signal);
  plainObject(options.searchResponse, "options.searchResponse");
  plainObject(options.sessionQuery, "options.sessionQuery");
  if (options.extractSessionEventText !== undefined) {
    callable(options.extractSessionEventText, "options.extractSessionEventText");
  }
  stringArray(options.literals, "options.literals", 1, 5, 500);
  stringArray(options.eventTypeAllowList, "options.eventTypeAllowList", 1, 32, MAX_EVENT_TYPE_BYTES);
  stringArray(options.surfaceAllowList, "options.surfaceAllowList", 1, 32, MAX_SURFACE_BYTES);
  const normalizedLiterals = options.literals.map((literal, index) => {
    const normalized = normalizeWhitespace(literal);
    if (normalized.length === 0) throw new TypeError(`options.literals[${index}] must not be whitespace-only`);
    return normalized;
  });
  const maxConcurrency = boundedOption(options.maxConcurrency, 4, 1, MAX_EXACT_CONCURRENCY, "maxConcurrency");
  const maxCandidates = boundedOption(options.maxCandidates, 256, 1, MAX_EXACT_CANDIDATES, "maxCandidates");
  if (!Array.isArray(options.searchResponse.sources)
      || options.searchResponse.sources.length < 1
      || options.searchResponse.sources.length > 5
      || !Array.isArray(options.searchResponse.fused)
      || options.searchResponse.fused.length > 100) {
    throw new TypeError("searchResponse sources/fused arrays exceed search protocol bounds");
  }
  throwIfAborted(signal);

  const allowedTypes = new Set(options.eventTypeAllowList);
  const allowedSurfaces = new Set(options.surfaceAllowList);
  const referencesBySourceHit = fusedReferencesBySourceHit(options.searchResponse.fused, signal);
  const coordinates = new Map();
  let pointersSeen = 0;
  for (const [sourceOrdinal, source] of options.searchResponse.sources.entries()) {
    throwIfAborted(signal);
    if (!Array.isArray(source.ranked) || source.ranked.length > 100) {
      throw new TypeError("search source ranked must be an array of at most 100 hits");
    }
    const queryOrdinal = Number.isSafeInteger(source.queryOrdinal)
      ? source.queryOrdinal
      : sourceOrdinal;
    for (const hit of source.ranked) {
      throwIfAborted(signal);
      plainObject(hit, "ranked search hit");
      const sourceRank = boundedIntegerValue(hit.rank, "ranked search hit rank", 1, 100);
      plainObject(hit.evidence, "search evidence");
      boundedString(hit.evidence.sessionId, "evidence sessionId", 1, MAX_SESSION_ID_BYTES);
      const seq = parseUnsigned(hit.evidence.seq, "evidence seq");
      if (queryOrdinal < 0 || queryOrdinal >= options.literals.length) continue;

      const references = referencesBySourceHit.get(sourceHitKey(queryOrdinal, sourceRank));
      if (references === undefined
          || !references.some((reference) => fusedReferenceMatchesHit(reference, hit, seq))) continue;
      if (pointersSeen >= maxCandidates) continue;

      const key = coordinateKey(hit.evidence.sessionId, seq);
      let coordinate = coordinates.get(key);
      if (coordinate === undefined) {
        coordinate = {
          sessionId: hit.evidence.sessionId,
          seq: seq.toString(),
          pointers: [],
          event: null,
          text: null,
          eventTimeUnixMs: null,
        };
        coordinates.set(key, coordinate);
      }
      coordinate.pointers.push({ queryOrdinal, sourceRank, pointer: hit.evidence });
      pointersSeen += 1;
    }
  }

  const work = [...coordinates.values()];
  const titlesBySession = new Map();
  throwIfAborted(signal);
  if (work.length > 0) {
    if (typeof options.sessionQuery.readEventDocumentSnapshots === "function") {
      await readGroupedAuthoritativeDocuments(options, work, titlesBySession, signal);
    } else if (typeof options.sessionQuery.filterEvents === "function"
        || typeof options.sessionQuery.readEvent === "function") {
      await readLegacyAuthoritativeDocuments(options, work, maxConcurrency, signal);
    } else {
      throw new TypeError(
        "sessionQuery must provide readEventDocumentSnapshots, filterEvents, or readEvent",
      );
    }
  }

  const observedEvidence = [];
  for (const coordinate of work) {
    throwIfAborted(signal);
    if (coordinate.event === null || coordinate.eventTimeUnixMs === null) continue;
    const actualType = firstString(
      coordinate.event.eventType,
      coordinate.event.event?.eventType,
      coordinate.event.event?.type,
      coordinate.event.type,
    );
    const actualSurface = firstString(coordinate.event.surface, coordinate.event.event?.surface);
    if (!allowedTypes.has(actualType) || !allowedSurfaces.has(actualSurface)) continue;
    const normalizedText = normalizeWhitespace(coordinate.text);
    if (normalizedText.length === 0) continue;
    for (const { queryOrdinal, sourceRank, pointer } of coordinate.pointers) {
      throwIfAborted(signal);
      const indexedEventTimeUnixMs = pointer.eventTimeUnixMs;
      if (!Number.isSafeInteger(indexedEventTimeUnixMs)
          || indexedEventTimeUnixMs !== coordinate.eventTimeUnixMs) continue;
      if (pointer.eventType !== actualType || pointer.surface !== actualSurface) continue;
      const literal = normalizedLiterals[queryOrdinal];
      const match = literalMatch(normalizedText, literal);
      if (match === null) continue;
      const evidence = Object.freeze({
        queryOrdinal,
        sessionId: coordinate.sessionId,
        seq: coordinate.seq,
        documentKey: pointer.documentKey,
        eventType: actualType,
        surface: actualSurface,
        eventTimeUnixMs: coordinate.eventTimeUnixMs,
        snippet: centeredSnippet(normalizedText, match.index, match.length),
      });
      observedEvidence.push({
        evidence,
        key: verificationEvidenceKey(evidence),
        contributionKey: verificationContributionKey({ ...evidence, sourceRank }),
      });
    }
  }

  // Every pointer above is checked independently. Collapse only identical
  // emitted evidence identities so the qq-core boundary never receives an
  // ambiguous duplicate; query ordinals remain part of the identity.
  const uniqueObservedEvidence = [];
  const evidenceByKey = new Map();
  for (const observed of observedEvidence) {
    if (evidenceByKey.has(observed.key)) continue;
    evidenceByKey.set(observed.key, observed.evidence);
    uniqueObservedEvidence.push(observed);
  }

  const retained = [];
  const retainedEvidenceKeys = new Set();
  // Prove each source-rank contribution before collapsing identical public
  // evidence, so a valid duplicate pointer cannot bless a stale source rank.
  const verifiedContributionKeys = new Set(observedEvidence.map(({ contributionKey }) => contributionKey));
  for (const candidate of options.searchResponse.fused) {
    throwIfAborted(signal);
    const contributionIdentities = candidate.contributions.map((contribution) => {
      const identity = {
        sessionId: candidate.sessionId,
        queryOrdinal: contribution.queryOrdinal,
        seq: parseUnsigned(contribution.seq, "contribution seq").toString(),
        documentKey: contribution.documentKey,
      };
      return {
        evidenceKey: verificationEvidenceKey(identity),
        contributionKey: verificationContributionKey({
          ...identity,
          sourceRank: contribution.sourceRank,
        }),
      };
    });
    if (!contributionIdentities.every(({ contributionKey }) => (
      verifiedContributionKeys.has(contributionKey)
    ))) continue;
    const candidateKeySet = new Set(contributionIdentities.map(({ evidenceKey }) => evidenceKey));
    const evidence = uniqueObservedEvidence
      .filter((observed) => candidateKeySet.has(observed.key))
      .map((observed) => observed.evidence);
    for (const key of candidateKeySet) retainedEvidenceKeys.add(key);
    const { title: _untrustedCandidateTitle, ...candidateWithoutTitle } = candidate;
    const authoritativeTitle = titlesBySession.get(candidate.sessionId);
    retained.push(Object.freeze({
      ...candidateWithoutTitle,
      evidence: Object.freeze(evidence),
      ...(authoritativeTitle === undefined ? {} : { title: authoritativeTitle }),
    }));
  }

  const verifiedEvidence = uniqueObservedEvidence
    .filter((observed) => retainedEvidenceKeys.has(observed.key))
    .map((observed) => observed.evidence);
  throwIfAborted(signal);
  return Object.freeze({
    verifiedCandidates: Object.freeze(retained),
    verifiedEvidence: Object.freeze(verifiedEvidence),
  });
}

function fusedReferencesBySourceHit(fusedCandidates, signal) {
  const references = new Map();
  for (const candidate of fusedCandidates) {
    throwIfAborted(signal);
    plainObject(candidate, "fused search candidate");
    boundedString(candidate.sessionId, "fused sessionId", 1, MAX_SESSION_ID_BYTES);
    if (!Array.isArray(candidate.contributions)
        || candidate.contributions.length < 1
        || candidate.contributions.length > 5) {
      throw new TypeError("fused contributions must be an array of 1..5 entries");
    }
    for (const contribution of candidate.contributions) {
      throwIfAborted(signal);
      plainObject(contribution, "fused contribution");
      const queryOrdinal = boundedIntegerValue(
        contribution.queryOrdinal,
        "contribution queryOrdinal",
        0,
        4,
      );
      const sourceRank = boundedIntegerValue(
        contribution.sourceRank,
        "contribution sourceRank",
        1,
        100,
      );
      boundedString(contribution.documentKey, "contribution documentKey", 1, 512);
      const seq = parseUnsigned(contribution.seq, "contribution seq");
      const key = sourceHitKey(queryOrdinal, sourceRank);
      const current = references.get(key) ?? [];
      current.push({
        sessionId: candidate.sessionId,
        documentKey: contribution.documentKey,
        seq,
      });
      references.set(key, current);
    }
  }
  return references;
}

function sourceHitKey(queryOrdinal, sourceRank) {
  return `${queryOrdinal}:${sourceRank}`;
}

function fusedReferenceMatchesHit(reference, hit, seq) {
  return hit.sessionId === reference.sessionId
    && hit.evidence.sessionId === reference.sessionId
    && hit.evidence.documentKey === reference.documentKey
    && seq === reference.seq;
}

async function readGroupedAuthoritativeDocuments(options, work, titlesBySession, signal) {
  const eligible = work.filter(({ seq }) => BigInt(seq) <= BigInt(Number.MAX_SAFE_INTEGER));
  const coordinatesByKey = new Map(eligible.map((coordinate) => [
    coordinateKey(coordinate.sessionId, BigInt(coordinate.seq)),
    coordinate,
  ]));
  const rejectedSessions = new Set();
  for (const requests of groupedSnapshotChunks(eligible)) {
    throwIfAborted(signal);
    const expectedRequests = requests.map(({ sessionId, seqs }) => ({ sessionId, seqs: [...seqs] }));
    let response;
    try {
      // This is the sole batch capability. Its public contract always accepts
      // the optional AbortSignal in the second position, including undefined.
      response = await options.sessionQuery.readEventDocumentSnapshots(requests, signal);
      throwIfAborted(signal);
    } catch (error) {
      rethrowCancellation(error, signal);
      // Whole-call operational failures are unexpected under the settlement
      // contract, but remain fail-closed for compatibility with ordinary reads.
      continue;
    }

    // Parsing is intentionally outside the operational failure catch: any
    // malformed batch invalidates the complete verification operation.
    const parsed = validateSnapshotSettlements(response, expectedRequests);
    for (const { sessionId, document } of parsed.documents) {
      const coordinate = coordinatesByKey.get(coordinateKey(sessionId, BigInt(document.seq)));
      if (coordinate === undefined) throw new TypeError("batch document is not a requested coordinate");
      coordinate.event = document;
      coordinate.text = document.text;
      coordinate.eventTimeUnixMs = document.time;
    }
    for (const [sessionId, title] of parsed.titles) titlesBySession.set(sessionId, title);
    for (const sessionId of parsed.rejectedSessions) rejectedSessions.add(sessionId);
  }
  if (rejectedSessions.size > 0) {
    for (const coordinate of eligible) {
      if (!rejectedSessions.has(coordinate.sessionId)) continue;
      coordinate.event = null;
      coordinate.text = null;
      coordinate.eventTimeUnixMs = null;
    }
    for (const sessionId of rejectedSessions) titlesBySession.delete(sessionId);
  }
}

function groupedSnapshotChunks(work) {
  const bySession = new Map();
  for (const coordinate of work) {
    const current = bySession.get(coordinate.sessionId) ?? [];
    current.push(Number(coordinate.seq));
    bySession.set(coordinate.sessionId, current);
  }

  const chunks = [];
  let current = [];
  let currentCoordinates = 0;
  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current);
    current = [];
    currentCoordinates = 0;
  };
  for (const [sessionId, seqs] of bySession) {
    if (seqs.length > MAX_SNAPSHOT_COORDINATES) {
      // A large session cannot fit in one upstream call. Flush first so that a
      // session is split only when its own requested coordinate count requires it.
      // Full slices stay isolated; its remainder may share space with later sessions.
      flush();
      let offset = 0;
      while (seqs.length - offset > MAX_SNAPSHOT_COORDINATES) {
        chunks.push([{
          sessionId,
          seqs: seqs.slice(offset, offset + MAX_SNAPSHOT_COORDINATES),
        }]);
        offset += MAX_SNAPSHOT_COORDINATES;
      }
      if (offset < seqs.length) {
        current.push({ sessionId, seqs: seqs.slice(offset) });
        currentCoordinates = seqs.length - offset;
      }
      continue;
    }
    if (current.length >= MAX_SNAPSHOT_GROUPS
        || currentCoordinates + seqs.length > MAX_SNAPSHOT_COORDINATES) flush();
    current.push({ sessionId, seqs: [...seqs] });
    currentCoordinates += seqs.length;
  }
  flush();
  return chunks;
}

function validateSnapshotSettlements(response, requests) {
  if (!Array.isArray(response)
      || response.length !== requests.length
      || response.length > MAX_SNAPSHOT_GROUPS) {
    throw new TypeError("batch response must contain exactly one settlement per requested session");
  }
  const documents = [];
  const titles = new Map();
  const rejectedSessions = new Set();
  for (const [index, settlement] of response.entries()) {
    const name = `batch settlements[${index}]`;
    strictRecord(settlement, name);
    boundedString(settlement.sessionId, `${name}.sessionId`, 1, MAX_SESSION_ID_BYTES);
    const request = requests[index];
    if (settlement.sessionId !== request.sessionId) {
      throw new TypeError(`${name}.sessionId must match requested session order`);
    }
    if (settlement.status === "rejected") {
      exactRecord(settlement, ["sessionId", "status", "reason"], [], name);
      rejectedSessions.add(request.sessionId);
      continue;
    }
    if (settlement.status !== "fulfilled") {
      throw new TypeError(`${name}.status must be fulfilled or rejected`);
    }
    exactRecord(settlement, ["sessionId", "status", "value"], [], name);
    const valueName = `${name}.value`;
    exactRecord(settlement.value, ["session", "documents"], ["title"], valueName);
    validateSnapshotHeader(settlement.value.session, request.sessionId, `${valueName}.session`);
    if (!Array.isArray(settlement.value.documents)
        || settlement.value.documents.length > request.seqs.length
        || settlement.value.documents.length > MAX_SNAPSHOT_COORDINATES) {
      throw new TypeError(`${valueName}.documents exceeds requested coordinates`);
    }
    const requestedSeqs = new Set(request.seqs);
    let previousSeq = -1;
    for (const [documentIndex, document] of settlement.value.documents.entries()) {
      const documentName = `${valueName}.documents[${documentIndex}]`;
      validateSnapshotDocument(document, request.sessionId, documentName);
      if (!requestedSeqs.has(document.seq)) {
        throw new TypeError(`${documentName}.seq was not requested`);
      }
      if (document.seq <= previousSeq) {
        throw new TypeError(`${valueName}.documents must be unique and in ascending seq order`);
      }
      previousSeq = document.seq;
      documents.push({ sessionId: request.sessionId, document });
    }
    if (Object.hasOwn(settlement.value, "title")) {
      titles.set(
        request.sessionId,
        validateAndFormatSnapshotTitle(settlement.value.title, `${valueName}.title`),
      );
    }
  }
  return { documents, titles, rejectedSessions };
}

function validateSnapshotHeader(header, sessionId, name) {
  strictRecord(header, name);
  for (const required of ["version", "id", "createdAt"]) {
    if (!Object.hasOwn(header, required)) throw new TypeError(`${name} is missing ${required}`);
  }
  if (!Number.isSafeInteger(header.version) || header.version < 0) {
    throw new TypeError(`${name}.version must be a non-negative safe integer`);
  }
  boundedString(header.id, `${name}.id`, 1, MAX_SESSION_ID_BYTES);
  if (header.id !== sessionId) throw new TypeError(`${name}.id must match its settlement sessionId`);
  nonnegativeSafeInteger(header.createdAt, `${name}.createdAt`);
  if (Object.hasOwn(header, "cwd")) {
    boundedString(header.cwd, `${name}.cwd`, 1, MAX_WORKSPACE_ID_BYTES);
    if (!isAbsolute(header.cwd)) throw new TypeError(`${name}.cwd must be absolute`);
  }
  if (Object.hasOwn(header, "parentSession")) {
    boundedString(header.parentSession, `${name}.parentSession`, 1, MAX_SESSION_ID_BYTES);
  }
  if (Object.hasOwn(header, "seedLength")) nonnegativeSafeInteger(header.seedLength, `${name}.seedLength`);
  if (Object.hasOwn(header, "origin") && header.origin !== "subagent") {
    throw new TypeError(`${name}.origin must be subagent`);
  }
  if (Object.hasOwn(header, "delegationDepth")) {
    nonnegativeSafeInteger(header.delegationDepth, `${name}.delegationDepth`);
  }
  if (Object.hasOwn(header, "agentPreset")) {
    boundedString(header.agentPreset, `${name}.agentPreset`, 0, MAX_WORKSPACE_ID_BYTES);
  }
}

function validateSnapshotDocument(document, sessionId, name) {
  exactRecord(document, ["sessionId", "seq", "type", "time", "surface", "text"], [], name);
  boundedString(document.sessionId, `${name}.sessionId`, 1, MAX_SESSION_ID_BYTES);
  if (document.sessionId !== sessionId) throw new TypeError(`${name}.sessionId is mismatched`);
  nonnegativeSafeInteger(document.seq, `${name}.seq`);
  if (!Number.isSafeInteger(document.time)) throw new TypeError(`${name}.time must be a safe integer`);
  boundedString(document.type, `${name}.type`, 1, MAX_EVENT_TYPE_BYTES);
  boundedString(document.surface, `${name}.surface`, 1, MAX_SURFACE_BYTES);
  boundedString(document.text, `${name}.text`, 1, MAX_BODY_BYTES);
}

function validateAndFormatSnapshotTitle(snapshot, name) {
  exactRecord(snapshot, ["title", "messageSeqs", "source", "eventSeq", "updatedAt"], [], name);
  boundedString(snapshot.title, `${name}.title`, 1, MAX_BODY_BYTES);
  const title = snapshot.title.trim();
  if (title.length === 0) throw new TypeError(`${name}.title must not be whitespace-only`);
  if (!Array.isArray(snapshot.messageSeqs) || snapshot.messageSeqs.length > MAX_TITLE_SOURCE_SEQS) {
    throw new TypeError(`${name}.messageSeqs exceeds its bound`);
  }
  let previous = -1;
  for (const [index, seq] of snapshot.messageSeqs.entries()) {
    nonnegativeSafeInteger(seq, `${name}.messageSeqs[${index}]`);
    if (seq <= previous) throw new TypeError(`${name}.messageSeqs must be unique and ascending`);
    previous = seq;
  }
  validateSnapshotTitleSource(snapshot.source, `${name}.source`);
  if ((snapshot.source.kind === "user") !== (snapshot.messageSeqs.length === 0)) {
    throw new TypeError(`${name}.messageSeqs is inconsistent with its source`);
  }
  nonnegativeSafeInteger(snapshot.eventSeq, `${name}.eventSeq`);
  nonnegativeSafeInteger(snapshot.updatedAt, `${name}.updatedAt`);
  return prefixClipWithEllipsis(title, MAX_TITLE_CODE_UNITS, MAX_TITLE_BYTES);
}

function validateSnapshotTitleSource(source, name) {
  strictRecord(source, name);
  if (source.kind === "fallback" || source.kind === "user") {
    exactRecord(source, ["kind"], [], name);
    return;
  }
  if (source.kind !== "provider") throw new TypeError(`${name}.kind is invalid`);
  exactRecord(source, ["kind", "provider"], ["model"], name);
  boundedString(source.provider, `${name}.provider`, 1, MAX_WORKSPACE_ID_BYTES);
  if (Object.hasOwn(source, "model")) {
    exactRecord(source.model, ["provider", "model"], [], `${name}.model`);
    boundedString(source.model.provider, `${name}.model.provider`, 1, MAX_WORKSPACE_ID_BYTES);
    boundedString(source.model.model, `${name}.model.model`, 1, MAX_WORKSPACE_ID_BYTES);
  }
}

async function readLegacyAuthoritativeDocuments(options, work, maxConcurrency, signal) {
  let cursor = 0;
  let cancellationError = null;
  const workers = Array.from({ length: Math.min(maxConcurrency, work.length) }, async () => {
    while (cursor < work.length) {
      throwIfAborted(signal);
      if (cancellationError !== null) throw cancellationError;
      const coordinate = work[cursor++];
      throwIfAborted(signal);
      try {
        const observation = await readAuthoritativeDocument(options, coordinate, signal);
        throwIfAborted(signal);
        if (observation === null) continue;
        const observedTime = eventTime(observation, "authoritative event");
        coordinate.event = observation;
        coordinate.text = observation.text;
        coordinate.eventTimeUnixMs = observedTime;
      } catch (error) {
        try {
          throwIfAborted(signal);
        } catch (abortError) {
          cancellationError = abortError;
          throw abortError;
        }
        if (isAbortError(error)) {
          cancellationError = error;
          throw error;
        }
        // Stale/missing/unavailable exact reads are deliberately fail-closed.
      }
    }
  });
  const workerResults = await Promise.allSettled(workers);
  throwIfAborted(signal);
  const rejectedWorker = workerResults.find(({ status }) => status === "rejected");
  if (rejectedWorker !== undefined) throw rejectedWorker.reason;
}

function verificationEvidenceKey({ sessionId, queryOrdinal, seq, documentKey }) {
  return `${Buffer.byteLength(sessionId, "utf8")}:${sessionId}:${queryOrdinal}:${seq}:`
    + `${Buffer.byteLength(documentKey, "utf8")}:${documentKey}`;
}

function verificationContributionKey(identity) {
  return `${sourceHitKey(identity.queryOrdinal, identity.sourceRank)}:${verificationEvidenceKey(identity)}`;
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, " ").trim();
}

function literalMatch(text, literal) {
  const pattern = literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(pattern, "iu").exec(text);
  return match === null ? null : { index: match.index, length: match[0].length };
}

function centeredSnippet(text, matchIndex, literalLength) {
  if (text.length <= MAX_SNIPPET_CODE_UNITS
      && Buffer.byteLength(text, "utf8") <= MAX_SNIPPET_BYTES) return text;
  const points = [];
  let offset = 0;
  for (const value of text) {
    const units = value.length;
    points.push({ value, start: offset, end: offset + units, units, bytes: Buffer.byteLength(value, "utf8") });
    offset += units;
  }
  const prefixUnits = [0];
  const prefixBytes = [0];
  for (const point of points) {
    prefixUnits.push(prefixUnits.at(-1) + point.units);
    prefixBytes.push(prefixBytes.at(-1) + point.bytes);
  }
  const matchEnd = matchIndex + literalLength;
  let left = points.findIndex(({ end }) => end > matchIndex);
  if (left < 0) left = points.length - 1;
  let right = left;
  while (right + 1 < points.length && points[right + 1].start < matchEnd) right += 1;
  const fits = (from, to) => {
    const edgeUnits = (from > 0 ? 1 : 0) + (to < points.length - 1 ? 1 : 0);
    const edgeBytes = (from > 0 ? 3 : 0) + (to < points.length - 1 ? 3 : 0);
    return prefixUnits[to + 1] - prefixUnits[from] + edgeUnits <= MAX_SNIPPET_CODE_UNITS
      && prefixBytes[to + 1] - prefixBytes[from] + edgeBytes <= MAX_SNIPPET_BYTES;
  };
  if (!fits(left, right)) {
    const center = matchIndex + literalLength / 2;
    left = points.findIndex(({ end }) => end >= center);
    if (left < 0) left = points.length - 1;
    right = left;
  }
  const center = matchIndex + literalLength / 2;
  while (left > 0 || right < points.length - 1) {
    const canLeft = left > 0 && fits(left - 1, right);
    const canRight = right < points.length - 1 && fits(left, right + 1);
    if (!canLeft && !canRight) break;
    if (canLeft && canRight) {
      const leftContext = center - points[left].start;
      const rightContext = points[right].end - center;
      if (leftContext <= rightContext) left -= 1;
      else right += 1;
    } else if (canLeft) left -= 1;
    else right += 1;
  }
  return `${left > 0 ? "…" : ""}${points.slice(left, right + 1).map(({ value }) => value).join("")}`
    + `${right < points.length - 1 ? "…" : ""}`;
}

function prefixClipWithEllipsis(value, maximumCodeUnits, maximumBytes) {
  if (value.length <= maximumCodeUnits && Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let prefix = "";
  let units = 0;
  let bytes = 0;
  for (const point of value) {
    const pointUnits = point.length;
    const pointBytes = Buffer.byteLength(point, "utf8");
    if (units + pointUnits + 1 > maximumCodeUnits || bytes + pointBytes + 3 > maximumBytes) break;
    prefix += point;
    units += pointUnits;
    bytes += pointBytes;
  }
  return `${prefix.trimEnd()}…`;
}

function nonnegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function exactRecord(value, required, optional, name) {
  strictRecord(value, name);
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${name} contains an unknown field`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${name} is missing ${key}`);
  }
}

function strictRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype
          && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

async function readAuthoritativeDocument(options, coordinate, signal) {
  throwIfAborted(signal);
  const numericSeq = Number(coordinate.seq);
  if (!Number.isSafeInteger(numericSeq)) return null;

  if (typeof options.sessionQuery.filterEvents === "function") {
    // dsh-session-query rc.7 exposes exactly (sessionId, filters) here. Keep
    // those positional semantics and enforce cancellation around the read.
    const documents = await options.sessionQuery.filterEvents(coordinate.sessionId, [{
      kind: "seq",
      from: numericSeq,
      to: numericSeq,
    }]);
    throwIfAborted(signal);
    if (!Array.isArray(documents) || documents.length !== 1) return null;
    const document = documents[0];
    if (document === null || typeof document !== "object" || Array.isArray(document)) return null;
    if (eventSequence(document, "filtered event") !== BigInt(coordinate.seq)) return null;
    if (document.sessionId !== undefined && document.sessionId !== coordinate.sessionId) return null;
    if (typeof document.type !== "string" || typeof document.surface !== "string"
        || typeof document.text !== "string") return null;
    throwIfAborted(signal);
    return document;
  }

  // Generated compatibility only. Production readEvent returns a window whose
  // raw target has no authoritative surface, so such a target fails closed
  // unless the generated target itself explicitly carries a surface.
  let observed;
  try {
    const request = {
      sessionId: coordinate.sessionId,
      seq: numericSeq,
      before: 0,
      after: 0,
    };
    observed = signal === undefined
      ? await options.sessionQuery.readEvent(request)
      : await options.sessionQuery.readEvent(request, signal);
    throwIfAborted(signal);
  } catch (error) {
    rethrowCancellation(error, signal);
    // Preserve the existing generated positional fallback without adding an
    // unsupported third argument.
    try {
      throwIfAborted(signal);
      observed = await options.sessionQuery.readEvent(coordinate.sessionId, coordinate.seq);
      throwIfAborted(signal);
    } catch (fallbackError) {
      rethrowCancellation(fallbackError, signal);
      throw fallbackError;
    }
  }
  const event = observed?.target ?? observed;
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
  if (event.seq !== undefined && eventSequence(event, "source event") !== BigInt(coordinate.seq)) return null;
  throwIfAborted(signal);
  const text = typeof event.text === "string"
    ? event.text
    : await options.extractSessionEventText?.(event);
  throwIfAborted(signal);
  if (typeof text !== "string") return null;
  return { ...event, text };
}

function validateAbortSignal(signal) {
  if (signal === undefined) return undefined;
  if (signal === null
      || (typeof signal !== "object" && typeof signal !== "function")
      || typeof signal.aborted !== "boolean"
      || typeof signal.throwIfAborted !== "function"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function") {
    throw new TypeError("options.signal must be an AbortSignal");
  }
  return signal;
}

function throwIfAborted(signal) {
  if (signal === undefined || !signal.aborted) return;
  signal.throwIfAborted();
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("operation was aborted");
  error.name = "AbortError";
  throw error;
}

function rethrowCancellation(error, signal) {
  throwIfAborted(signal);
  if (isAbortError(error)) throw error;
}

function isAbortError(error) {
  return error?.name === "AbortError"
    || error?.code === "ABORT_ERR"
    || error?.code === "SESSION_QUERY_ABORTED";
}

/**
 * Recognize only the concrete, replay-validated production snapshot and durable
 * state contracts. Returning null deliberately delegates every unverifiable or
 * compatibility shape to projectDshSessionLog and its existing validation.
 */
function inspectDurableProductionSnapshot(sessionId, sessionLog, durableState) {
  if (durableState === undefined) return null;
  try {
    exactRecord(sessionLog, ["session", "events"], [], "production session log");
    if (!Array.isArray(sessionLog.events)
        || Object.getPrototypeOf(sessionLog.events) !== Array.prototype
        || !Number.isSafeInteger(sessionLog.events.length)
        || sessionLog.events.length < 0) return null;

    exactRecord(
      sessionLog.session,
      ["version", "id", "createdAt", "cwd"],
      ["parentSession", "seedLength", "origin", "delegationDepth", "agentPreset"],
      "production session header",
    );
    validateSnapshotHeader(sessionLog.session, sessionId, "production session header");
    const workspaceId = usableProductionWorkspace(sessionLog.session.cwd);
    if (workspaceId === null) return null;

    exactRecord(
      durableState,
      ["sessionId", "nextSeq", "workspaceId", "headerRevision"],
      [],
      "durable production state",
    );
    boundedString(durableState.sessionId, "durable production state.sessionId", 1, MAX_SESSION_ID_BYTES);
    if (durableState.sessionId !== sessionId || typeof durableState.nextSeq !== "string") return null;
    const nextSeq = parseUnsigned(durableState.nextSeq, "durable nextSeq");
    boundedString(
      durableState.workspaceId,
      "durable production state.workspaceId",
      1,
      MAX_WORKSPACE_ID_BYTES,
    );
    boundedString(durableState.headerRevision, "durable production state.headerRevision", 1, 256);

    const eventCount = BigInt(sessionLog.events.length);
    if (eventCount > MAX_SQLITE_INTEGER) return null;
    return {
      nextSeq,
      eventCount,
      workspaceId,
      durableWorkspaceId: durableState.workspaceId,
      workspaceScopeToken: deriveWorkspaceScopeToken(workspaceId),
      durableWorkspaceScopeToken: deriveWorkspaceScopeToken(durableState.workspaceId),
    };
  } catch {
    return null;
  }
}

function isProductionSessionLog(sessionLog) {
  return sessionLog.session !== null
    && typeof sessionLog.session === "object"
    && !Array.isArray(sessionLog.session)
    && Array.isArray(sessionLog.events);
}

function usableProductionWorkspace(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0") || !isAbsolute(cwd)) return null;
  boundedString(cwd, "session.cwd", 1, MAX_WORKSPACE_ID_BYTES);
  return cwd;
}

function usableGeneratedWorkspace(sessionLog) {
  const workspaceId = firstString(
    sessionLog.workspaceId,
    sessionLog.workspace?.id,
    sessionLog.header?.workspaceId,
  );
  if (workspaceId === undefined || workspaceId.length === 0) return null;
  boundedString(workspaceId, "session workspaceId", 1, MAX_WORKSPACE_ID_BYTES);
  return workspaceId;
}

function validateProjectionHelpers(helpers) {
  plainObject(helpers, "projectionHelpers");
  callable(helpers.buildSessionEventRecords, "buildSessionEventRecords");
  callable(helpers.buildSessionEventSearchDocuments, "buildSessionEventSearchDocuments");
  callable(helpers.extractSessionEventText, "extractSessionEventText");
}

function validateIndexClient(client) {
  if (client === null || (typeof client !== "object" && typeof client !== "function")) {
    throw new TypeError("session-index client must be an object");
  }
  callable(client.sourceState, "client.sourceState");
  callable(client.applyBatch, "client.applyBatch");
}

function normalizeLiveNotification(notification) {
  let topic;
  let payload;
  if (typeof notification[0] === "string") {
    [topic, payload] = notification;
  } else {
    payload = notification[0];
    plainObject(payload, "live notification");
    topic = payload.type ?? payload.topic ?? payload.name;
  }
  if (!LIVE_TOPICS.has(topic)) throw new TypeError("unsupported live notification topic");
  payload ??= {};
  const sessionId = firstString(payload.sessionId, payload.session?.sessionId, payload.session?.id, payload.id);
  boundedString(sessionId, "live notification sessionId", 1, MAX_SESSION_ID_BYTES);
  return { topic, sessionId };
}

async function normalizeSessionList(listed, maximum) {
  let values;
  if (listed?.[Symbol.asyncIterator] instanceof Function) {
    values = [];
    for await (const value of listed) {
      if (values.length >= maximum) throw new TypeError("listed session count exceeds its bound");
      values.push(value);
    }
  } else if (Array.isArray(listed)) values = listed;
  else if (Array.isArray(listed?.sessions)) values = listed.sessions;
  else throw new TypeError("listSessions must return an array, async iterable, or { sessions }");
  if (values.length > maximum) throw new TypeError("listed session count exceeds its bound");
  const unique = new Set();
  for (const [index, value] of values.entries()) {
    const sessionId = typeof value === "string"
      ? value
      : firstString(value?.header?.id, value?.sessionId, value?.id);
    boundedString(sessionId, `listed sessions[${index}]`, 1, MAX_SESSION_ID_BYTES);
    if (unique.has(sessionId)) throw new TypeError("listed sessions must not contain duplicates");
    unique.add(sessionId);
  }
  return [...unique];
}

function arrayResult(value, property, name) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[property])) return value[property];
  throw new TypeError(`${name} must return an array or { ${property} }`);
}

function eventSequence(value, name) {
  const raw = value.seq ?? value.sequence ?? value.event?.seq ?? value.event?.sequence;
  return parseUnsigned(raw, `${name}.seq`);
}

function eventTime(record, name) {
  const raw = record.eventTimeUnixMs
    ?? record.timeUnixMs
    ?? record.time
    ?? record.event?.eventTimeUnixMs
    ?? record.event?.timeUnixMs
    ?? record.timestamp
    ?? record.event?.timestamp;
  if (Number.isSafeInteger(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (raw instanceof Date && Number.isSafeInteger(raw.getTime())) return raw.getTime();
  throw new TypeError(`${name}.eventTimeUnixMs must be a safe integer or valid timestamp`);
}

function chunkDocuments(documents, maximumDocuments, maximumBytes) {
  const chunks = [];
  let current = [];
  let currentBytes = 2;
  for (const document of documents) {
    const bytes = Buffer.byteLength(JSON.stringify(document), "utf8") + 1;
    if (bytes > maximumBytes) throw new TypeError("one projected event exceeds the bounded daemon batch payload");
    if (current.length >= maximumDocuments || currentBytes + bytes > maximumBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(document);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function chunkArray(values, size) {
  const chunks = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

function digestCanonical(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function coordinateKey(sessionId, seq) {
  return `${Buffer.byteLength(sessionId, "utf8")}:${sessionId}:${seq}`;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string");
}

function parseUnsigned(value, name) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be unsigned`);
    value = String(value);
  } else if (typeof value === "bigint") {
    if (value < 0n) throw new TypeError(`${name} must be unsigned`);
    value = value.toString();
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`${name} must be a canonical unsigned integer`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SQLITE_INTEGER) throw new TypeError(`${name} exceeds the SQLite integer range`);
  return parsed;
}

function stringArray(value, name, minimum, maximum, maximumBytes) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${name} length must be ${minimum}..${maximum}`);
  }
  const unique = new Set();
  for (const [index, item] of value.entries()) {
    boundedString(item, `${name}[${index}]`, 1, maximumBytes);
    if (unique.has(item)) throw new TypeError(`${name} must not contain duplicates`);
    unique.add(item);
  }
}

function boundedIntegerValue(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function boundedOption(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function incrementCounter(state, property, amount) {
  state[property] = Math.min(Number.MAX_SAFE_INTEGER, state[property] + amount);
}

function boundedErrorField(value, fallback) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/gu, "_");
}

function callable(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
}

function plainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function boundedString(value, name, minimumBytes, maximumBytes) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError(`${name} must be a NUL-free string`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw new TypeError(`${name} must contain ${minimumBytes}..${maximumBytes} UTF-8 bytes`);
  }
}
