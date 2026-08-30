import {
  INDEX_MAX_CHARS,
  INDEX_TRUNCATION_MARKER,
  MAX_INJECTED_INDEX_CODE_POINTS,
  internals,
  loadIndex,
  validateIndex,
} from "./index.mjs";

export {
  INDEX_MAX_CHARS,
  INDEX_TRUNCATION_MARKER,
  MAX_INJECTED_INDEX_CODE_POINTS,
  internals,
  loadIndex,
  validateIndex,
};

export const name = "qq-index";
export const inject = [];
export const provide = "qq-index";

const service = Object.freeze({ loadIndex, validateIndex });

/** Provide repository-index access through the canonical service name. */
export function apply(ctx) {
  ctx.provide("qq-index", service);
}
