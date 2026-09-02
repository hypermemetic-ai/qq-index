import { conversationViewV1 } from "./conversation-v1.mjs";
import { exactRangeTestViewV1 } from "./exact-range-test-v1.mjs";
import { createViewRegistry } from "./registry.mjs";

export const compiledViewRegistry = createViewRegistry([conversationViewV1, exactRangeTestViewV1]);
export const compiledViewCapabilities = compiledViewRegistry.capabilities();
