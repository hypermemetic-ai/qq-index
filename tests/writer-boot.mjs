import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(resolve(tmpdir(), "qq-wiki-writer-boot-test-"));
const callsKey = Symbol.for("qq.wiki.writerBootTestCalls");
globalThis[callsKey] = [];

try {
  const miniDocsPath = resolve(root, "src/mini-docs.mjs");
  await mkdir(dirname(miniDocsPath), { recursive: true });
  await writeFile(miniDocsPath, `
export function miniDocsSetup(agentCtx, { env }) {
  globalThis[Symbol.for("qq.wiki.writerBootTestCalls")].push({ agentCtx, env });
}
`);

  const writerBoot = await import(`../src/writer-boot.mjs?test=${Date.now()}`);
  const liveAgentCtx = { id: "live-agent-ctx" };
  const createdAgentCtx = { id: "created-agent-ctx" };
  const liveAgent = { ctx: liveAgentCtx, session: { header: { cwd: "/tmp/repo" } } };
  const createdAgent = { ctx: createdAgentCtx, session: { header: { cwd: "/tmp/repo" } } };
  const listeners = [];
  const env = {
    QQ_WIKI_WORKFLOWS_ROOT: root,
    QQ_WIKI_WRITER_PROMPT: "writer packet",
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
  assert.deepEqual(globalThis[callsKey], [{ agentCtx: liveAgentCtx, env }]);

  const onCreated = listeners.find(({ type }) => type === "agent/created")?.fn;
  assert.equal(typeof onCreated, "function");
  onCreated({ agent: createdAgent });
  assert.deepEqual(globalThis[callsKey], [
    { agentCtx: liveAgentCtx, env },
    { agentCtx: createdAgentCtx, env },
  ]);

  const source = await readFile(new URL("../src/writer-boot.mjs", import.meta.url), "utf8");
  assert.match(source, /miniDocsSetup\(agent\?\.ctx \?\? agent, \{ env \}\)/);
  assert.doesNotMatch(source, /agentPreset|header\?\.kind|wrapMiniBash/);
  console.log("writer boot: ok");
} finally {
  delete globalThis[callsKey];
  await rm(root, { recursive: true, force: true });
}
