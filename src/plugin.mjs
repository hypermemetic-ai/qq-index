import {
  INDEX_MAX_CHARS,
  INDEX_TRUNCATION_MARKER,
  MAX_INJECTED_INDEX_CODE_POINTS,
  internals,
  loadIndex,
  validateIndex,
} from "./index.mjs";
import { compiledViewCapabilities } from "./views/catalog.mjs";
import {
  SessionIndexRuntimeError,
  createSessionIndexRuntime,
  validateSessionIndexConfig,
} from "./session-index-runtime.mjs";

export {
  INDEX_MAX_CHARS,
  INDEX_TRUNCATION_MARKER,
  MAX_INJECTED_INDEX_CODE_POINTS,
  internals,
  loadIndex,
  validateIndex,
  SessionIndexRuntimeError,
  createSessionIndexRuntime,
  validateSessionIndexConfig,
  compiledViewCapabilities,
};

export const name = "qq-index";
export const inject = [];
export const provide = "qq-index";

const service = Object.freeze({ loadIndex, validateIndex });

/**
 * Provide the legacy README-index service and the separately gated session index.
 * The latter is always present for capability discovery and inert unless enabled.
 */
export function apply(ctx, config = {}) {
  ctx.provide("qq-index", service);
  const runtime = createSessionIndexRuntime(config);
  ctx.provide("qq-session-index", runtime.service);

  let injectionFiber;
  if (runtime.status().enabled) {
    const attach = (holder = ctx) => {
      const sessionQuery = serviceOf(holder, "sessionQuery");
      if (sessionQuery === undefined) return;
      const token = runtime.bind(sessionQuery, holder);
      if (token !== null && typeof holder.effect === "function") {
        holder.effect(() => () => runtime.unbind(token), "qqSessionIndex.sessionQueryBinding");
      }
    };
    if (typeof ctx.inject === "function") injectionFiber = ctx.inject(["sessionQuery"], attach);
    else attach(ctx);
  }

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await Promise.allSettled([
      injectionFiber?.dispose?.(),
      runtime.dispose(),
    ].filter(Boolean));
  };
  if (typeof ctx.effect === "function") {
    ctx.effect(() => dispose, "qqSessionIndex.runtime");
  }
  return dispose;
}

function serviceOf(ctx, name) {
  if (ctx?.[name] !== undefined) return ctx[name];
  if (typeof ctx?.get === "function") return ctx.get(name);
  return undefined;
}
