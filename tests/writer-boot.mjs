import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const root = await mkdtemp(resolve(tmpdir(), "qq-index-writer-boot-test-"));
const callsKey = Symbol.for("qq.index.writerBootTestCalls");
globalThis[callsKey] = [];

function agentContext(id, initialServices = []) {
  const services = new Map(initialServices);
  const provided = [];
  return {
    id,
    agent: undefined,
    provided,
    get(service) {
      return services.get(service);
    },
    provide(service, value) {
      assert.equal(services.has(service), false, `${service} must not be replaced`);
      services.set(service, value);
      provided.push({ service, value });
      return () => services.delete(service);
    },
  };
}

try {
  const miniDocsPath = resolve(root, "src/mini-docs.mjs");
  await mkdir(dirname(miniDocsPath), { recursive: true });
  await writeFile(miniDocsPath, `
export function miniDocsSetup(agentCtx, { env }) {
  const qq = agentCtx.get("qq-core");
  if (typeof qq?.surface?.allow !== "function") {
    throw new Error("qq-core surface.allow is required");
  }
  qq.surface.allow(agentCtx.agent, ["bash"]);
  globalThis[Symbol.for("qq.index.writerBootTestCalls")].push({ agentCtx, env, qq });
}
`);

  const writerBoot = await import(`../src/writer-boot.mjs?test=${Date.now()}`);
  const realAllowCalls = [];
  const realCore = {
    surface: {
      allow(agent, names) {
        realAllowCalls.push({ agent, names });
      },
    },
  };
  const liveAgentCtx = agentContext("live-agent-ctx");
  const createdAgentCtx = agentContext("created-agent-ctx");
  const coreAgentCtx = agentContext("core-agent-ctx", [["qq-core", realCore]]);
  const liveAgent = { ctx: liveAgentCtx, session: { header: { cwd: "/tmp/repo" } } };
  const createdAgent = { ctx: createdAgentCtx, session: { header: { cwd: "/tmp/repo" } } };
  const coreAgent = { ctx: coreAgentCtx, session: { header: { cwd: "/tmp/repo" } } };
  liveAgentCtx.agent = liveAgent;
  createdAgentCtx.agent = createdAgent;
  coreAgentCtx.agent = coreAgent;

  const listeners = [];
  const env = {
    QQ_INDEX_WORKFLOWS_ROOT: root,
    QQ_INDEX_WRITER_PROMPT: "writer packet",
  };
  const ctx = {
    get(service) {
      if (service === "agents") return { list: () => [liveAgent] };
      return undefined;
    },
    on(type, fn) {
      listeners.push({ type, fn });
      return () => {};
    },
  };

  await writerBoot.apply(ctx, { env });
  assert.equal(globalThis[callsKey].length, 1);
  assert.equal(globalThis[callsKey][0].agentCtx, liveAgentCtx);
  assert.equal(globalThis[callsKey][0].env, env);
  assert.equal(liveAgentCtx.provided.length, 1);
  assert.equal(liveAgentCtx.provided[0].service, "qq-core");
  const shim = liveAgentCtx.provided[0].value;
  assert.equal(globalThis[callsKey][0].qq, shim);
  assert.equal(typeof shim?.surface?.allow, "function");
  assert.equal(shim.surface.allow(liveAgent, ["bash"]), undefined);

  const onCreated = listeners.find(({ type }) => type === "agent/created")?.fn;
  assert.equal(typeof onCreated, "function");
  onCreated({ agent: createdAgent });
  assert.equal(globalThis[callsKey].length, 2);
  assert.equal(globalThis[callsKey][1].agentCtx, createdAgentCtx);
  assert.equal(createdAgentCtx.provided.length, 1);
  assert.equal(createdAgentCtx.provided[0].service, "qq-core");
  assert.equal(globalThis[callsKey][1].qq, createdAgentCtx.provided[0].value);

  onCreated();
  assert.equal(globalThis[callsKey].length, 2);
  onCreated({ agent: createdAgent });
  assert.equal(createdAgentCtx.provided.length, 1);

  onCreated({ agent: coreAgent });
  assert.equal(globalThis[callsKey].length, 4);
  assert.equal(globalThis[callsKey][3].agentCtx, coreAgentCtx);
  assert.equal(globalThis[callsKey][3].qq, realCore);
  assert.deepEqual(coreAgentCtx.provided, []);
  assert.deepEqual(realAllowCalls, [{ agent: coreAgent, names: ["bash"] }]);

  const source = await readFile(new URL("../src/writer-boot.mjs", import.meta.url), "utf8");
  assert.match(source, /ensureCoreSurface\(agentCtx\);\s+miniDocsSetup\(agentCtx, \{ env \}\)/);
  assert.doesNotMatch(source, /agentPreset|header\?\.kind|wrapMiniBash/);
  console.log("writer boot: ok");
} finally {
  delete globalThis[callsKey];
  await rm(root, { recursive: true, force: true });
}
