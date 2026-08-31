import { isAbsolute } from "node:path";

import { connectSessionIndexClient } from "./session-index-client.mjs";
import { createDshSessionIndexSource } from "./session-index-dsh-source.mjs";

const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MONITOR_INTERVAL_MS = 5_000;
const DEFAULT_RESTART_INITIAL_BACKOFF_MS = 250;
const DEFAULT_RESTART_MAX_BACKOFF_MS = 10_000;
const MAX_TIMEOUT_MS = 600_000;
const STATUS_COUNTER_MAX = Number.MAX_SAFE_INTEGER;
const LIVE_TOPICS = ["session/created", "session/event", "session/disposed"];
const OPTION_KEYS = new Set(["timeoutMs", "deadlineUnixMs", "signal"]);
const OUTAGE_CODES = new Set([
  "socket_error",
  "socket_closed",
  "protocol_violation",
  "cancellation_unacknowledged",
  "client_closed",
]);

export class SessionIndexRuntimeError extends Error {
  constructor(code, message = "session-index runtime is unavailable", options = {}) {
    super(message, options);
    this.name = "SessionIndexRuntimeError";
    this.code = boundedErrorField(code, "runtime_error");
  }
}

/** Validate and detach the production runtime configuration without performing I/O. */
export function validateSessionIndexConfig(config = {}) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("config must be an object");
  }
  const raw = config.sessionIndex;
  if (raw === undefined) return Object.freeze({ enabled: false });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("config.sessionIndex must be an object");
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new TypeError("config.sessionIndex.enabled must be boolean");
  }
  if (raw.enabled !== true) return Object.freeze({ enabled: false });

  const allowed = new Set([
    "enabled",
    "socketPath",
    "connectTimeoutMs",
    "requestTimeoutMs",
    "monitorIntervalMs",
    "restartInitialBackoffMs",
    "restartMaxBackoffMs",
    "maxBatchDocuments",
    "maxBatchPayloadBytes",
    "maxBufferedSessions",
    "maxCorpusSessions",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new TypeError(`unknown config.sessionIndex option ${key}`);
  }
  boundedString(raw.socketPath, "config.sessionIndex.socketPath", 1, 4_096);
  if (!isAbsolute(raw.socketPath)) throw new TypeError("config.sessionIndex.socketPath must be absolute");

  const validated = {
    enabled: true,
    socketPath: raw.socketPath,
    connectTimeoutMs: boundedIntegerOption(
      raw.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      25,
      MAX_TIMEOUT_MS,
      "connectTimeoutMs",
    ),
    requestTimeoutMs: boundedIntegerOption(
      raw.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      25,
      MAX_TIMEOUT_MS,
      "requestTimeoutMs",
    ),
    monitorIntervalMs: boundedIntegerOption(
      raw.monitorIntervalMs,
      DEFAULT_MONITOR_INTERVAL_MS,
      100,
      MAX_TIMEOUT_MS,
      "monitorIntervalMs",
    ),
    restartInitialBackoffMs: boundedIntegerOption(
      raw.restartInitialBackoffMs,
      DEFAULT_RESTART_INITIAL_BACKOFF_MS,
      10,
      60_000,
      "restartInitialBackoffMs",
    ),
    restartMaxBackoffMs: boundedIntegerOption(
      raw.restartMaxBackoffMs,
      DEFAULT_RESTART_MAX_BACKOFF_MS,
      10,
      60_000,
      "restartMaxBackoffMs",
    ),
  };
  if (validated.restartInitialBackoffMs > validated.restartMaxBackoffMs) {
    throw new TypeError("restartInitialBackoffMs must not exceed restartMaxBackoffMs");
  }
  copyBoundedSourceOption(validated, raw, "maxBatchDocuments", 1, 1_024);
  copyBoundedSourceOption(validated, raw, "maxBatchPayloadBytes", 1_024, 900 * 1_024);
  copyBoundedSourceOption(validated, raw, "maxBufferedSessions", 1, 4_096);
  copyBoundedSourceOption(validated, raw, "maxCorpusSessions", 1, 100_000);
  return Object.freeze(validated);
}

/**
 * Create the qq-session-index runtime and its frozen qq-core-facing service.
 * Dependencies are injectable only so generated tests never touch production data.
 */
export function createSessionIndexRuntime(config = {}, dependencies = {}) {
  return new SessionIndexRuntime(validateSessionIndexConfig(config), dependencies);
}

class SessionIndexRuntime {
  #config;
  #connectClient;
  #createSource;
  #setTimer;
  #clearTimer;
  #binding = null;
  #source = null;
  #sourceClosePromise = Promise.resolve();
  #timer = null;
  #restartPromise = null;
  #activeClients = new Set();
  #disposed = false;
  #ready = false;
  #capabilityValidated = false;
  #phase;
  #healthSummary = null;
  #lastError = null;
  #restartCount = 0;
  #consecutiveFailures = 0;
  #backoffMs;
  #service;

  constructor(config, dependencies) {
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      throw new TypeError("runtime dependencies must be an object");
    }
    this.#config = config;
    this.#connectClient = dependencies.connectClient ?? connectSessionIndexClient;
    this.#createSource = dependencies.createSource ?? createDshSessionIndexSource;
    this.#setTimer = dependencies.setTimeout ?? setTimeout;
    this.#clearTimer = dependencies.clearTimeout ?? clearTimeout;
    callable(this.#connectClient, "connectClient");
    callable(this.#createSource, "createSource");
    callable(this.#setTimer, "setTimeout");
    callable(this.#clearTimer, "clearTimeout");
    this.#backoffMs = config.enabled ? config.restartInitialBackoffMs : 0;
    this.#phase = config.enabled ? "waiting-session-query" : "disabled";
    this.#service = Object.freeze({
      status: () => this.status(),
      ready: () => this.ready(),
      health: (options) => this.health(options),
      searchBatch: (request, options) => this.searchBatch(request, options),
      restart: () => this.restart(),
    });
  }

  get service() {
    return this.#service;
  }

  status() {
    const sourceStatus = this.#source?.status?.();
    return deepFreeze({
      enabled: this.#config.enabled,
      phase: this.#phase,
      ready: this.#ready,
      capabilityValidated: this.#capabilityValidated,
      health: this.#healthSummary === null ? null : { ...this.#healthSummary },
      source: sourceStatus === undefined ? null : redactSourceStatus(sourceStatus),
      restarts: boundedCounter(this.#restartCount),
      consecutiveFailures: boundedCounter(this.#consecutiveFailures),
      activeClients: boundedCounter(this.#activeClients.size),
      lastError: this.#lastError === null ? null : { ...this.#lastError },
    });
  }

  ready() {
    return this.#ready && !this.#disposed;
  }

  /** Bind one currently mounted optional DSH service. Returns an identity token. */
  bind(sessionQuery, lifecycleContext) {
    if (!this.#config.enabled || this.#disposed) return null;
    if (sessionQuery === null || typeof sessionQuery !== "object" || Array.isArray(sessionQuery)) {
      throw new TypeError("sessionQuery must be an object");
    }
    callable(sessionQuery.listSessions, "sessionQuery.listSessions");
    callable(sessionQuery.readSession, "sessionQuery.readSession");
    const subscribe = createCordisSubscription(lifecycleContext);
    const token = Symbol("qq-session-index-binding");
    this.#binding = { token, sessionQuery, subscribe };
    this.#ready = false;
    this.#capabilityValidated = false;
    this.#phase = "starting";
    this.#schedule(0);
    return token;
  }

  /** Unbind only the matching optional-service generation. */
  unbind(token) {
    if (token === null || this.#binding?.token !== token) return;
    this.#binding = null;
    this.#cancelTimer();
    this.#ready = false;
    this.#capabilityValidated = false;
    this.#healthSummary = null;
    this.#phase = this.#disposed ? "disposed" : "waiting-session-query";
    const source = this.#source;
    this.#source = null;
    void this.#retireSource(source);
  }

  async health(options = {}) {
    this.#requireEnabledAndBound(false);
    const detached = validateOperationOptions(options);
    const client = await this.#openShortLivedClient(detached);
    try {
      const response = await client.health(operationOptions(detached, this.#config.requestTimeoutMs));
      this.#setHealthSummary(response);
      return deepFreeze(structuredClone(response));
    } catch (error) {
      if (isOutage(error)) this.#markOutage(error);
      throw error;
    } finally {
      await this.#closeTrackedClient(client);
    }
  }

  async searchBatch(request, options = {}) {
    this.#requireEnabledAndBound(true);
    const detached = validateOperationOptions(options);
    const client = await this.#openShortLivedClient(detached);
    try {
      // Re-check after the asynchronous connect/health boundary. A concurrent
      // monitor failure or disposal must not send a search through stale readiness.
      this.#requireEnabledAndBound(true);
      return await client.searchBatch(request, operationOptions(detached, this.#config.requestTimeoutMs));
    } catch (error) {
      if (isOutage(error)) this.#markOutage(error);
      throw error;
    } finally {
      await this.#closeTrackedClient(client);
    }
  }

  restart() {
    try {
      this.#requireEnabledAndBound(false);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#restartPromise !== null) return this.#restartPromise;
    this.#cancelTimer();
    const restart = this.#reattach();
    let wrapped;
    wrapped = restart.finally(() => {
      if (this.#restartPromise !== wrapped) return;
      this.#restartPromise = null;
      // A new injected service may have replaced the generation while the old
      // restart was awaiting I/O. Its immediate timer observed the serialized
      // old promise, so arm it again once that promise has actually retired.
      if (!this.#disposed && this.#binding !== null && !this.#ready && this.#timer === null) {
        this.#schedule(0);
      }
    });
    this.#restartPromise = wrapped;
    return wrapped;
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#phase = "disposing";
    this.#ready = false;
    this.#capabilityValidated = false;
    this.#binding = null;
    this.#cancelTimer();
    const source = this.#source;
    this.#source = null;
    const sourceClose = this.#retireSource(source);
    const clients = [...this.#activeClients];
    await Promise.allSettled([
      sourceClose,
      ...clients.map((client) => client.close?.()),
      this.#restartPromise,
    ].filter(Boolean));
    this.#activeClients.clear();
    this.#healthSummary = null;
    this.#phase = "disposed";
  }

  async #reattach() {
    const binding = this.#binding;
    if (binding === null || this.#disposed) throw unavailable("session_query_unavailable");
    this.#phase = this.#consecutiveFailures === 0 ? "starting" : "recovering";
    this.#ready = false;
    this.#capabilityValidated = false;

    const previous = this.#source;
    this.#source = null;
    await this.#retireSource(previous);

    let validationClient = null;
    let source = null;
    try {
      validationClient = await this.#openConfiguredClient();
      const health = await validationClient.health({ timeoutMs: this.#config.requestTimeoutMs });
      this.#setHealthSummary(health);
      this.#capabilityValidated = true;
      await this.#closeTrackedClient(validationClient);
      validationClient = null;
      this.#assertBinding(binding);

      const sourceOptions = {
        sessionQuery: binding.sessionQuery,
        subscribe: binding.subscribe,
        clientFactory: () => this.#openConfiguredClient(false),
      };
      for (const key of [
        "maxBatchDocuments",
        "maxBatchPayloadBytes",
        "maxBufferedSessions",
        "maxCorpusSessions",
      ]) {
        if (this.#config[key] !== undefined) sourceOptions[key] = this.#config[key];
      }
      source = this.#createSource(sourceOptions);
      callable(source.start, "source.start");
      callable(source.close, "source.close");
      callable(source.status, "source.status");
      await source.start();
      this.#assertBinding(binding);
      if (source.status().phase !== "live") throw unavailable("source_not_live");

      this.#source = source;
      this.#ready = true;
      this.#phase = "live";
      this.#lastError = null;
      this.#restartCount = Math.min(STATUS_COUNTER_MAX, this.#restartCount + 1);
      this.#consecutiveFailures = 0;
      this.#backoffMs = this.#config.restartInitialBackoffMs;
      this.#schedule(this.#config.monitorIntervalMs);
      return this.status();
    } catch (error) {
      await this.#closeTrackedClient(validationClient);
      await source?.close?.().catch(() => {});
      this.#ready = false;
      this.#capabilityValidated = false;
      if (this.#binding === binding && !this.#disposed) {
        this.#phase = "recovering";
        this.#recordError(error);
        this.#consecutiveFailures = Math.min(STATUS_COUNTER_MAX, this.#consecutiveFailures + 1);
        this.#scheduleBackoff();
      }
      throw error;
    }
  }

  async #tick() {
    if (this.#disposed || this.#binding === null) return;
    if (!this.#ready || this.#source === null) {
      await this.restart().catch(() => {});
      return;
    }
    try {
      if (this.#source.status().phase !== "live") throw unavailable("source_not_live");
      callable(this.#source.health, "source.health");
      const response = await this.#source.health({ timeoutMs: this.#config.requestTimeoutMs });
      this.#setHealthSummary(response);
      this.#schedule(this.#config.monitorIntervalMs);
    } catch (error) {
      this.#markOutage(error);
    }
  }

  #markOutage(error) {
    if (this.#disposed || this.#binding === null) return;
    this.#ready = false;
    this.#capabilityValidated = false;
    this.#phase = "recovering";
    this.#recordError(error);
    this.#scheduleBackoff();
  }

  #scheduleBackoff() {
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#config.restartMaxBackoffMs, Math.max(
      this.#config.restartInitialBackoffMs,
      this.#backoffMs * 2,
    ));
    this.#schedule(delay);
  }

  #schedule(delay) {
    if (this.#disposed || this.#binding === null || !this.#config.enabled) return;
    this.#cancelTimer();
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.#tick().catch((error) => this.#markOutage(error));
    }, delay);
    this.#timer?.unref?.();
  }

  #cancelTimer() {
    if (this.#timer === null) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
  }

  async #openConfiguredClient(track = true, boundary = {}) {
    const deadlineUnixMs = minimumDefined(
      boundary.deadlineUnixMs,
      Date.now() + Math.min(boundary.timeoutMs ?? MAX_TIMEOUT_MS, this.#config.connectTimeoutMs),
    );
    const client = await this.#connectClient({
      socketPath: this.#config.socketPath,
      timeoutMs: this.#config.requestTimeoutMs,
      deadlineUnixMs,
      ...(boundary.signal === undefined ? {} : { signal: boundary.signal }),
    });
    if (track) this.#activeClients.add(client);
    return client;
  }

  #openShortLivedClient(boundary) {
    return this.#openConfiguredClient(true, boundary);
  }

  #retireSource(source) {
    if (source === null || source === undefined) return this.#sourceClosePromise;
    this.#sourceClosePromise = this.#sourceClosePromise
      .then(() => source.close?.())
      .catch(() => {});
    return this.#sourceClosePromise;
  }

  async #closeTrackedClient(client) {
    if (client === null || client === undefined) return;
    this.#activeClients.delete(client);
    await client.close?.().catch(() => {});
  }

  #setHealthSummary(response) {
    const capabilities = response?.capabilities;
    this.#healthSummary = deepFreeze({
      generation: boundedUnsigned(response?.generation),
      sourceWatermark: boundedUnsigned(response?.sourceWatermark),
      readerCount: boundedCounter(capabilities?.readerCount),
      queueCapacity: boundedCounter(capabilities?.queueCapacity),
      readerRetirements: boundedCounter(capabilities?.readerRetirements),
      activeReaders: boundedCounter(capabilities?.activeReaders),
      peakActiveReaders: boundedCounter(capabilities?.peakActiveReaders),
    });
  }

  #recordError(error) {
    this.#lastError = Object.freeze({
      class: boundedErrorField(error?.name, "Error"),
      code: boundedErrorField(error?.code, "runtime_error"),
    });
  }

  #assertBinding(binding) {
    if (this.#disposed) throw unavailable("disposing");
    if (this.#binding !== binding) throw unavailable("binding_replaced");
  }

  #requireEnabledAndBound(requireReady) {
    if (!this.#config.enabled) throw unavailable("disabled");
    if (this.#disposed || this.#phase === "disposing") throw unavailable("disposing");
    if (this.#binding === null) throw unavailable("session_query_unavailable");
    if (requireReady && (!this.#ready || !this.#capabilityValidated || this.#source?.status?.().phase !== "live")) {
      throw unavailable("not_ready");
    }
  }
}

/** Subscribe to the real Cordis event shape and return one aggregate disposer. */
function createCordisSubscription(ctx) {
  if (ctx === null || typeof ctx !== "object" || typeof ctx.on !== "function") {
    throw new TypeError("session-index runtime requires lifecycleContext.on");
  }
  return async (listener) => {
    const disposers = [];
    try {
      for (const topic of LIVE_TOPICS) {
        disposers.push(normalizeDisposer(ctx.on(topic, (...values) => {
          // Real DSH events put the Session first; the adapter needs only its id.
          listener(topic, values[0]);
        })));
      }
    } catch (error) {
      await Promise.allSettled(disposers.reverse().map((dispose) => dispose()));
      throw error;
    }
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled(disposers.reverse().map((dispose) => dispose()));
    };
  };
}

function normalizeDisposer(value) {
  if (typeof value === "function") return value;
  if (typeof value?.dispose === "function") return () => value.dispose();
  if (typeof value?.unsubscribe === "function") return () => value.unsubscribe();
  return () => {};
}

function validateOperationOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("operation options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw new TypeError(`unknown operation option ${key}`);
  }
  const detached = {};
  if (options.timeoutMs !== undefined) {
    detached.timeoutMs = boundedIntegerOption(options.timeoutMs, 0, 1, MAX_TIMEOUT_MS, "timeoutMs");
  }
  if (options.deadlineUnixMs !== undefined) {
    if (!Number.isSafeInteger(options.deadlineUnixMs) || options.deadlineUnixMs <= 0) {
      throw new TypeError("deadlineUnixMs must be a positive safe integer");
    }
    detached.deadlineUnixMs = options.deadlineUnixMs;
  }
  if (options.signal !== undefined) {
    if (!(options.signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
    detached.signal = options.signal;
  }
  return detached;
}

function operationOptions(boundary, fallbackTimeoutMs) {
  return {
    timeoutMs: boundary.timeoutMs ?? fallbackTimeoutMs,
    ...(boundary.deadlineUnixMs === undefined ? {} : { deadlineUnixMs: boundary.deadlineUnixMs }),
    ...(boundary.signal === undefined ? {} : { signal: boundary.signal }),
  };
}

function redactSourceStatus(status) {
  return {
    phase: boundedErrorField(status?.phase, "unknown"),
    sessionsScanned: boundedCounter(status?.sessionsScanned),
    eventsCommitted: boundedCounter(status?.eventsCommitted),
    documentsCommitted: boundedCounter(status?.documentsCommitted),
    bufferedSessions: boundedCounter(status?.bufferedSessions),
    watermark: boundedUnsigned(status?.watermark),
    lastError: status?.lastError === null || status?.lastError === undefined
      ? null
      : {
          class: boundedErrorField(status.lastError.name, "Error"),
          code: boundedErrorField(status.lastError.code, "source_error"),
        },
  };
}

function unavailable(code) {
  return new SessionIndexRuntimeError(code);
}

function isOutage(error) {
  return OUTAGE_CODES.has(error?.code);
}

function boundedUnsigned(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/u.test(value)) return value;
  return "0";
}

function boundedCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(STATUS_COUNTER_MAX, value) : 0;
}

function boundedErrorField(value, fallback) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/gu, "_");
}

function boundedIntegerOption(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function copyBoundedSourceOption(target, raw, key, minimum, maximum) {
  if (raw[key] !== undefined) {
    target[key] = boundedIntegerOption(raw[key], 0, minimum, maximum, key);
  }
}

function boundedString(value, name, minimumBytes, maximumBytes) {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError(`${name} must be a NUL-free string`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw new TypeError(`${name} must contain ${minimumBytes}..${maximumBytes} UTF-8 bytes`);
  }
}

function minimumDefined(...values) {
  return Math.min(...values.filter((value) => value !== undefined));
}

function callable(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
