import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "qq-index-writer-boot";
export const inject = ["agents"];

const NOOP_CORE = Object.freeze({
  surface: Object.freeze({
    allow() {},
  }),
});

function agentsOf(ctx) {
  const host = ctx?.root && typeof ctx.root.get === "function" ? ctx.root : ctx;
  return host?.get?.("agents", false) ?? ctx?.agents ?? ctx?.get?.("agents", false) ?? null;
}

function ensureCoreSurface(agentCtx) {
  if (!agentCtx || typeof agentCtx.get !== "function") {
    throw new Error("qq-index writer boot requires an agent Cordis context");
  }
  if (agentCtx.get("qq-core", false) !== undefined) return;
  if (typeof agentCtx.provide !== "function") {
    throw new Error("qq-index writer boot requires agentCtx.provide");
  }
  agentCtx.provide("qq-core", NOOP_CORE);
}

async function miniDocsSetupFor(env) {
  const workflowsRoot = env?.QQ_INDEX_WORKFLOWS_ROOT;
  if (typeof workflowsRoot !== "string" || workflowsRoot.trim() === "") {
    throw new Error("qq-index writer boot requires QQ_INDEX_WORKFLOWS_ROOT");
  }
  const href = pathToFileURL(resolve(workflowsRoot, "src/mini-docs.mjs")).href;
  const module = await import(href);
  if (typeof module.miniDocsSetup !== "function") {
    throw new Error(`qq-index writer boot requires miniDocsSetup from ${href}`);
  }
  return module.miniDocsSetup;
}

/** Mount workflows' Mini Docs adapter on every headless writer agent. */
export async function apply(ctx, config = {}) {
  if (!ctx || typeof ctx.on !== "function") {
    throw new Error("qq-index writer boot requires a Cordis context");
  }
  const agents = agentsOf(ctx);
  if (!agents || typeof agents.list !== "function") {
    throw new Error("qq-index writer boot requires the agents service");
  }

  const env = config.env ?? process.env;
  const miniDocsSetup = await miniDocsSetupFor(env);
  const mount = (agent) => {
    if (!agent) return;
    const agentCtx = agent?.ctx ?? agent;
    ensureCoreSurface(agentCtx);
    miniDocsSetup(agentCtx, { env });
  };

  ctx.on("agent/created", ({ agent } = {}) => mount(agent));
  for (const agent of agents.list()) mount(agent);
}
