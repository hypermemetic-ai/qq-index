import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "qq-wiki-writer-boot";
export const inject = ["agents"];

function agentsOf(ctx) {
  const host = ctx?.root && typeof ctx.root.get === "function" ? ctx.root : ctx;
  return host?.get?.("agents", false) ?? ctx?.agents ?? ctx?.get?.("agents", false) ?? null;
}

async function miniDocsSetupFor(env) {
  const workflowsRoot = env?.QQ_WIKI_WORKFLOWS_ROOT;
  if (typeof workflowsRoot !== "string" || workflowsRoot.trim() === "") {
    throw new Error("qq-wiki writer boot requires QQ_WIKI_WORKFLOWS_ROOT");
  }
  const href = pathToFileURL(resolve(workflowsRoot, "src/mini-docs.mjs")).href;
  const module = await import(href);
  if (typeof module.miniDocsSetup !== "function") {
    throw new Error(`qq-wiki writer boot requires miniDocsSetup from ${href}`);
  }
  return module.miniDocsSetup;
}

/** Mount workflows' Mini Docs adapter on every headless writer agent. */
export async function apply(ctx, config = {}) {
  if (!ctx || typeof ctx.on !== "function") {
    throw new Error("qq-wiki writer boot requires a Cordis context");
  }
  const agents = agentsOf(ctx);
  if (!agents || typeof agents.list !== "function") {
    throw new Error("qq-wiki writer boot requires the agents service");
  }

  const env = config.env ?? process.env;
  const miniDocsSetup = await miniDocsSetupFor(env);
  const mount = (agent) => {
    if (agent) miniDocsSetup(agent?.ctx ?? agent, { env });
  };

  ctx.on("agent/created", ({ agent } = {}) => mount(agent));
  for (const agent of agents.list()) mount(agent);
}
