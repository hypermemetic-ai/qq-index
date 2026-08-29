import { INDEX_MAX_CHARS, internals, loadIndex, validateIndex } from "./index.mjs";

export { INDEX_MAX_CHARS, internals, loadIndex, validateIndex };

export const name = "qq-index";
export const inject = [];
export const provide = "qq-index";

const service = Object.freeze({ loadIndex, validateIndex });

/** Provide repository-index access under the current and compatibility names. */
export function apply(ctx) {
  ctx.provide("qq-index", service);
  ctx.provide("qq-wiki", service);
}
