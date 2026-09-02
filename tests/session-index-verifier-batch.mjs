import assert from "node:assert/strict";

import { verifyDshSearchCandidates } from "@hypermemetic-ai/qq-index/session-index-dsh-source";

await groupedCapability();
await isolatedFailures();
await malformedResponses();
await groupedCancellation();
await boundedOutput();
await completeCandidatesOnly();
await overBoundChunking();
await productionCallCount();
console.log("session-index grouped verifier: ok");

async function groupedCapability() {
  const first = pointer("grouped", "1");
  const second = pointer("grouped", "2");
  const calls = [];
  const controller = new AbortController();
  const result = await verifyDshSearchCandidates({
    ...options({
      sources: [
        { queryOrdinal: 0, ranked: [ranked(1, first), ranked(2, second)] },
        { queryOrdinal: 1, ranked: [ranked(1, first)] },
      ],
      fused: [fused("grouped", 1, [
        contribution(0, 1, first),
        contribution(0, 2, second),
        contribution(1, 1, first),
      ])],
    }, ["alpha literal", "beta literal"]),
    signal: controller.signal,
    sessionQuery: {
      async readEventDocumentSnapshots(...args) {
        calls.push(args);
        return fulfilled(args[0], new Map([
          ["grouped:1", document("grouped", 1, "alpha literal beta literal")],
          ["grouped:2", document("grouped", 2, "alpha literal")],
        ]));
      },
      async readEventDocumentsMany() {
        assert.fail("withdrawn flat API must not be detected");
      },
      async filterEvents() {
        assert.fail("grouped capability must be preferred");
      },
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], [{ sessionId: "grouped", seqs: [1, 2] }]);
  assert.equal(calls[0][1], controller.signal);
  assert.deepEqual(result.verifiedEvidence.map(({ queryOrdinal, seq }) => [queryOrdinal, seq]), [
    [0, "1"], [1, "1"], [0, "2"],
  ]);
  assert.equal(result.verifiedEvidence[0].eventTimeUnixMs, 1_700_000_000_000);

  const duplicateSameQuery = await verifyDshSearchCandidates({
    ...options({
      sources: [{ queryOrdinal: 0, ranked: [ranked(1, first), ranked(2, first)] }],
      fused: [fused("grouped", 1, [contribution(0, 1, first), contribution(0, 2, first)])],
    }, ["alpha literal"]),
    sessionQuery: {
      async readEventDocumentSnapshots(requests) {
        return fulfilled(requests, new Map([["grouped:1", document("grouped", 1, "alpha literal")]]));
      },
    },
  });
  assert.equal(duplicateSameQuery.verifiedEvidence.length, 1, "identical emitted identities are unique");

  const caseInsensitive = await verifyOne("case-fold", "NEEDLE LITERAL");
  assert.equal(caseInsensitive.verifiedEvidence[0].snippet, "NEEDLE LITERAL");

  let callsOnEmpty = 0;
  const empty = await verifyDshSearchCandidates({
    ...options({ sources: [{ queryOrdinal: 0, ranked: [ranked(1, pointer("unused", "0"))] }], fused: [] }),
    sessionQuery: {},
  });
  assert.equal(callsOnEmpty, 0);
  assert.deepEqual(empty, { verifiedCandidates: [], verifiedEvidence: [] });
}

async function isolatedFailures() {
  const result = await verifyDshSearchCandidates({
    ...options(responseFor(["good", "missing", "rejected"])),
    sessionQuery: {
      async readEventDocumentSnapshots(requests) {
        return requests.map(({ sessionId }) => {
          if (sessionId === "rejected") return { sessionId, status: "rejected", reason: new Error("gone") };
          return settlement(sessionId, sessionId === "good"
            ? [document(sessionId, 0, "canonical literal")]
            : []);
        });
      },
    },
  });
  assert.deepEqual(result.verifiedCandidates.map(({ sessionId }) => sessionId), ["good"]);
  assert.equal(result.verifiedEvidence.length, 1);
}

async function malformedResponses() {
  const response = responseFor(["batch-a", "batch-b"]);
  const valid = (requests) => fulfilled(requests, new Map(requests.map(({ sessionId }) => [
    `${sessionId}:0`, document(sessionId, 0, "canonical literal"),
  ])));
  const cases = [
    ["outer", () => ({})],
    ["missing", (requests) => valid(requests).slice(1)],
    ["duplicate", (requests) => [valid(requests)[0], valid(requests)[0]]],
    ["unrequested", (requests) => [{ ...valid(requests)[0], sessionId: "other" }, valid(requests)[1]]],
    ["order", (requests) => valid(requests).reverse()],
    ["status", (requests) => [{ ...valid(requests)[0], status: "pending" }, valid(requests)[1]]],
    ["rejection", (requests) => [{ sessionId: requests[0].sessionId, status: "rejected" }, valid(requests)[1]]],
    ["rejection-extra", (requests) => [{ sessionId: requests[0].sessionId, status: "rejected", reason: "x", value: {} }, valid(requests)[1]]],
    ["value", (requests) => [{ sessionId: requests[0].sessionId, status: "fulfilled", value: null }, valid(requests)[1]]],
    ["header-id", (requests) => { const value = valid(requests); value[0].value.session.id = "other"; return value; }],
    ["header", (requests) => { const value = valid(requests); delete value[0].value.session.createdAt; return value; }],
    ["documents", (requests) => { const value = valid(requests); value[0].value.documents = {}; return value; }],
    ["document-shape", (requests) => { const value = valid(requests); delete value[0].value.documents[0].text; return value; }],
    ["document-session", (requests) => { const value = valid(requests); value[0].value.documents[0].sessionId = "batch-b"; return value; }],
    ["document-unrequested", (requests) => { const value = valid(requests); value[0].value.documents[0].seq = 7; return value; }],
    ["document-duplicate", (requests) => { const value = valid(requests); value[0].value.documents.push({ ...value[0].value.documents[0] }); return value; }],
    ["document-time", (requests) => { const value = valid(requests); value[0].value.documents[0].time = Number.MAX_SAFE_INTEGER + 1; return value; }],
    ["document-text", (requests) => { const value = valid(requests); value[0].value.documents[0].text = "x".repeat(1_048_577); return value; }],
    ["document-field", (requests) => { const value = valid(requests); value[0].value.documents[0].extra = true; return value; }],
    ["title", (requests) => { const value = valid(requests); value[0].value.title = { title: 42 }; return value; }],
  ];
  for (const [name, mutate] of cases) {
    let fallbacks = 0;
    await assert.rejects(verifyDshSearchCandidates({
      ...options(response),
      sessionQuery: {
        async readEventDocumentSnapshots(requests) { return mutate(requests); },
        async filterEvents() { fallbacks += 1; return []; },
      },
    }), undefined, name);
    assert.equal(fallbacks, 0, `${name}: malformed batch must not fall back`);
  }

  const first = pointer("ordered", "0");
  const second = pointer("ordered", "1");
  const selected = pointer("mutated-request", "0");
  await assert.rejects(verifyDshSearchCandidates({
    ...options({
      sources: [{ queryOrdinal: 0, ranked: [ranked(1, selected)] }],
      fused: [fused("mutated-request", 1, [contribution(0, 1, selected)])],
    }),
    sessionQuery: {
      async readEventDocumentSnapshots(requests) {
        requests[0].seqs.push(7);
        return [settlement("mutated-request", [document("mutated-request", 7, "canonical literal")])];
      },
    },
  }), /not requested/u);

  await assert.rejects(verifyDshSearchCandidates({
    ...options({
      sources: [{ queryOrdinal: 0, ranked: [ranked(1, first), ranked(2, second)] }],
      fused: [fused("ordered", 1, [contribution(0, 1, first), contribution(0, 2, second)])],
    }),
    sessionQuery: {
      async readEventDocumentSnapshots() {
        return [settlement("ordered", [
          document("ordered", 1, "canonical literal"),
          document("ordered", 0, "canonical literal"),
        ])];
      },
    },
  }), /ascending/u);
}

async function groupedCancellation() {
  const controller = new AbortController();
  const reason = new Error("grouped abort identity");
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const pending = verifyDshSearchCandidates({
    ...options(responseFor(["abort-a", "abort-b"])),
    signal: controller.signal,
    sessionQuery: {
      async readEventDocumentSnapshots(requests, signal) {
        calls += 1;
        assert.equal(signal, controller.signal);
        started.resolve();
        await release.promise;
        signal.throwIfAborted();
        return fulfilled(requests, new Map());
      },
    },
  });
  await started.promise;
  controller.abort(reason);
  release.resolve();
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(calls, 1);

  const upstreamReason = new Error("upstream abort");
  upstreamReason.name = "AbortError";
  await assert.rejects(verifyDshSearchCandidates({
    ...options(responseFor(["upstream-abort"])),
    sessionQuery: { async readEventDocumentSnapshots() { throw upstreamReason; } },
  }), (error) => error === upstreamReason);
}

async function boundedOutput() {
  for (const [sessionId, text] of [
    ["ascii", `${"left ".repeat(90)}needle literal${" right".repeat(90)}`],
    ["unicode", `${"🙂 前 ".repeat(180)}needle literal${" 後 🙂".repeat(180)}`],
  ]) {
    const result = await verifyOne(sessionId, text, titleSnapshot(`  ${"界🙂".repeat(500)}  `));
    const evidence = result.verifiedEvidence[0];
    assert.ok(evidence.snippet.includes("needle literal"));
    assert.ok(evidence.snippet.startsWith("…") && evidence.snippet.endsWith("…"));
    assert.ok(evidence.snippet.length <= 320);
    assert.ok(Buffer.byteLength(evidence.snippet) <= 1280);
    assert.equal(evidence.eventTimeUnixMs, 1_700_000_000_000);
    const title = result.verifiedCandidates[0].title;
    assert.equal(title, title.trim());
    assert.ok(title.endsWith("…") && title.length <= 256 && Buffer.byteLength(title) <= 1024);
  }
  const whitespace = await verifyOne("whitespace", " before\n\tneedle   literal\r\n after ");
  assert.equal(whitespace.verifiedEvidence[0].snippet, "before needle literal after");
  assert.equal(Object.hasOwn(whitespace.verifiedCandidates[0], "title"), false);
  const spoof = await verifyOne("spoof", "needle literal", titleSnapshot(" Authoritative "), { title: "daemon spoof" });
  assert.equal(spoof.verifiedCandidates[0].title, "Authoritative");
  const absentSpoof = await verifyOne("absent-spoof", "needle literal", undefined, { title: "daemon spoof" });
  assert.equal(Object.hasOwn(absentSpoof.verifiedCandidates[0], "title"), false);
  const clippedStart = await verifyOne("start-edge", `needle literal ${"tail ".repeat(100)}`);
  assert.equal(clippedStart.verifiedEvidence[0].snippet.startsWith("…"), false);
  assert.equal(clippedStart.verifiedEvidence[0].snippet.endsWith("…"), true);
  const clippedEnd = await verifyOne("end-edge", `${"head ".repeat(100)}needle literal`);
  assert.equal(clippedEnd.verifiedEvidence[0].snippet.startsWith("…"), true);
  assert.equal(clippedEnd.verifiedEvidence[0].snippet.endsWith("…"), false);
}

async function completeCandidatesOnly() {
  const first = pointer("partial", "0");
  const second = pointer("partial", "1");
  const result = await verifyDshSearchCandidates({
    ...options({
      sources: [{ queryOrdinal: 0, ranked: [ranked(1, first), ranked(2, second)] }],
      fused: [fused("partial", 1, [contribution(0, 1, first), contribution(0, 2, second)])],
    }),
    sessionQuery: {
      async readEventDocumentSnapshots(requests) {
        return fulfilled(requests, new Map([["partial:0", document("partial", 0, "canonical literal")]]));
      },
    },
  });
  assert.deepEqual(result, { verifiedCandidates: [], verifiedEvidence: [] });
}

async function overBoundChunking() {
  const sources = Array.from({ length: 3 }, (_, queryOrdinal) => ({
    queryOrdinal,
    ranked: Array.from({ length: 100 }, (_, index) => ranked(index + 1, pointer("large", String(queryOrdinal * 100 + index)))),
  }));
  const fusedCandidates = Array.from({ length: 100 }, (_, index) => fused("large", index + 1,
    sources.map((source) => contribution(source.queryOrdinal, index + 1, source.ranked[index].evidence))));
  const calls = [];
  const result = await verifyDshSearchCandidates({
    ...options({ sources, fused: fusedCandidates }, ["first", "second", "third"]),
    maxCandidates: 300,
    sessionQuery: {
      async readEventDocumentSnapshots(requests) {
        assert.ok(requests.length <= 256);
        assert.ok(requests.reduce((count, request) => count + request.seqs.length, 0) <= 256);
        calls.push(structuredClone(requests));
        const docs = new Map();
        for (const { sessionId, seqs } of requests) for (const seq of seqs) {
          docs.set(`${sessionId}:${seq}`, document(sessionId, seq, "first second third"));
        }
        return fulfilled(requests, docs);
      },
    },
  });
  assert.deepEqual(calls.map((requests) => requests[0].seqs.length), [256, 44]);
  assert.equal(result.verifiedEvidence.length, 300);
  assert.equal(result.verifiedCandidates.length, 100);

  let rejectionCalls = 0;
  const rejected = await verifyDshSearchCandidates({
    ...options({ sources, fused: fusedCandidates }, ["first", "second", "third"]),
    maxCandidates: 300,
    sessionQuery: {
      async readEventDocumentSnapshots(requests) {
        rejectionCalls += 1;
        if (rejectionCalls === 2) return [{ sessionId: "large", status: "rejected", reason: new Error("changed") }];
        const docs = new Map();
        for (const seq of requests[0].seqs) docs.set(`large:${seq}`, document("large", seq, "first second third"));
        return fulfilled(requests, docs);
      },
    },
  });
  assert.equal(rejectionCalls, 2);
  assert.deepEqual(rejected, { verifiedCandidates: [], verifiedEvidence: [] });

  const controller = new AbortController();
  const reason = new Error("abort before queued chunk");
  let abortCalls = 0;
  await assert.rejects(verifyDshSearchCandidates({
    ...options({ sources, fused: fusedCandidates }, ["first", "second", "third"]),
    maxCandidates: 300,
    signal: controller.signal,
    sessionQuery: {
      async readEventDocumentSnapshots(requests) {
        abortCalls += 1;
        controller.abort(reason);
        return fulfilled(requests, new Map());
      },
    },
  }), (error) => error === reason);
  assert.equal(abortCalls, 1, "abort must not start a queued grouped call");
}

async function productionCallCount() {
  const sources = Array.from({ length: 5 }, (_, queryOrdinal) => ({
    queryOrdinal,
    ranked: [
      ...Array.from({ length: 20 }, (_, index) => ranked(index + 1, pointer(`shared-${index}`, "0"))),
      ...Array.from({ length: 80 }, (_, index) => ranked(index + 21, pointer(`unused-${queryOrdinal}-${index}`, "0"))),
    ],
  }));
  const fusedCandidates = Array.from({ length: 20 }, (_, index) => fused(`shared-${index}`, index + 1,
    sources.map((source) => contribution(source.queryOrdinal, index + 1, source.ranked[index].evidence))));
  let calls = 0;
  let observations = 0;
  const result = await verifyDshSearchCandidates({
    ...options({ sources, fused: fusedCandidates }, ["one", "two", "three", "four", "five"]),
    maxCandidates: 500,
    sessionQuery: {
      async readEventDocumentSnapshots(requests) {
        calls += 1;
        observations += requests.reduce((count, request) => count + request.seqs.length, 0);
        return fulfilled(requests, new Map());
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(observations, 20);
  assert.deepEqual(result, { verifiedCandidates: [], verifiedEvidence: [] });
  console.log(JSON.stringify({ productionRankedPointers: 500, fusedSelectedObservations: observations, groupedCalls: calls }));
}

async function verifyOne(sessionId, text, title, candidateExtras = {}) {
  const evidence = pointer(sessionId, "0");
  return verifyDshSearchCandidates({
    ...options({
      sources: [{ queryOrdinal: 0, ranked: [ranked(1, evidence)] }],
      fused: [{ ...fused(sessionId, 1, [contribution(0, 1, evidence)]), ...candidateExtras }],
    }, ["needle   literal"]),
    sessionQuery: {
      async readEventDocumentSnapshots() {
        return [settlement(sessionId, [document(sessionId, 0, text)], title === undefined ? {} : { title })];
      },
    },
  });
}
function options(searchResponse, literals = ["canonical literal"]) {
  return { searchResponse, literals, eventTypeAllowList: ["user/message"], surfaceAllowList: ["current"] };
}
function responseFor(sessionIds) {
  const hits = sessionIds.map((sessionId, index) => ranked(index + 1, pointer(sessionId, "0")));
  return { sources: [{ queryOrdinal: 0, ranked: hits }], fused: sessionIds.map((sessionId, index) =>
    fused(sessionId, index + 1, [contribution(0, index + 1, hits[index].evidence)])) };
}
function pointer(sessionId, seq) {
  return { sessionId, documentKey: `generated:${sessionId}:${seq}`, seq, eventTimeUnixMs: 7, eventType: "user/message", surface: "current", snippet: null };
}
function ranked(rank, evidence) { return { rank, sessionId: evidence.sessionId, score: 1 / rank, evidence }; }
function contribution(queryOrdinal, sourceRank, evidence) {
  return { queryOrdinal, sourceRank, contribution: 0.1, documentKey: evidence.documentKey, seq: evidence.seq, snippet: null };
}
function fused(sessionId, rank, contributions) { return { rank, sessionId, rrfScore: 0.1, contributions }; }
function header(sessionId) { return { version: 0, id: sessionId, createdAt: 1_699_999_999_999, cwd: "/workspace" }; }
function document(sessionId, seq, text) { return { sessionId, seq, type: "user/message", time: 1_700_000_000_000, surface: "current", text }; }
function titleSnapshot(title) { return { title, messageSeqs: [0], source: { kind: "fallback" }, eventSeq: 1, updatedAt: 1_700_000_000_001 }; }
function settlement(sessionId, documents, extra = {}) {
  return { sessionId, status: "fulfilled", value: { session: header(sessionId), documents, ...extra } };
}
function fulfilled(requests, docs) {
  return requests.map(({ sessionId, seqs }) => settlement(sessionId, seqs.flatMap((seq) => {
    const value = docs.get(`${sessionId}:${seq}`);
    return value === undefined ? [] : [value];
  })));
}
function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
