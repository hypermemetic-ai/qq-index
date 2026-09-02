import assert from "node:assert/strict";

import { verifyDshSearchCandidates } from "@hypermemetic-ai/qq-index/session-index-dsh-source";

await referencedSelectionAssertions();
await emptyFusedAssertions();
await unusedThenReferencedAssertions();
await malformedReferenceAssertions();
await mismatchedReferenceAssertions();
await defaultBoundAssertions();
await productionShapedExactReadCounts();
console.log("session-index fused verifier selection: ok");

async function referencedSelectionAssertions() {
  const shared = pointer("shared", "0");
  const unused = pointer("unused", "0");
  const fusedCandidate = fused("shared", 1, [
    contribution(0, 1, shared),
    contribution(1, 1, shared),
  ]);
  const reads = [];
  const result = await verifyDshSearchCandidates({
    ...verificationOptions({
      sources: [
        { queryOrdinal: 0, ranked: [ranked(1, shared), ranked(2, unused)] },
        { queryOrdinal: 1, ranked: [ranked(1, shared)] },
      ],
      fused: [fusedCandidate],
    }, ["first literal", "second literal"]),
    sessionQuery: {
      async filterEvents(sessionId, filters) {
        reads.push(`${sessionId}:${filters[0].from}`);
        return [document(sessionId, filters[0].from, "first literal and second literal")];
      },
    },
  });

  assert.deepEqual(reads, ["shared:0"], "unused ranked hits must not be read");
  assert.deepEqual(
    result.verifiedEvidence.map(({ queryOrdinal }) => queryOrdinal),
    [0, 1],
    "duplicate coordinates referenced by separate queries retain both evidence pointers",
  );
  assert.deepEqual(result.verifiedCandidates.map(({ sessionId }) => sessionId), ["shared"]);
  assert.equal(result.verifiedCandidates[0].rank, fusedCandidate.rank);
  assert.equal(result.verifiedCandidates[0].rrfScore, fusedCandidate.rrfScore);
  assert.equal(
    result.verifiedCandidates[0].contributions,
    fusedCandidate.contributions,
    "the original fused contributions must be preserved",
  );
}

async function unusedThenReferencedAssertions() {
  const unused = pointer("unused-head", "0");
  const referenced = pointer("fused-tail", "0");
  let reads = 0;
  const result = await verifyDshSearchCandidates({
    ...verificationOptions({
      sources: [{
        queryOrdinal: 0,
        ranked: [ranked(1, unused), ranked(2, referenced)],
      }],
      fused: [fused("fused-tail", 1, [contribution(0, 2, referenced)])],
    }),
    sessionQuery: {
      async filterEvents(sessionId, filters) {
        reads += 1;
        return [document(sessionId, filters[0].from, "canonical literal")];
      },
    },
  });
  assert.equal(reads, 1, "a referenced hit after unused ranked hits must still be read");
  assert.deepEqual(result.verifiedCandidates.map(({ sessionId }) => sessionId), ["fused-tail"]);
}

async function emptyFusedAssertions() {
  let reads = 0;
  const unused = pointer("no-fused-candidate", "0");
  const result = await verifyDshSearchCandidates({
    ...verificationOptions({
      sources: [{ queryOrdinal: 0, ranked: [ranked(1, unused)] }],
      fused: [],
    }),
    sessionQuery: {
      async filterEvents() {
        reads += 1;
        return [];
      },
    },
  });

  assert.equal(reads, 0, "a source hit absent from fused contributions must cause zero reads");
  assert.deepEqual(result, { verifiedCandidates: [], verifiedEvidence: [] });
}

async function malformedReferenceAssertions() {
  const malformed = pointer("malformed", "0");
  malformed.seq = "01";
  let reads = 0;
  await assert.rejects(verifyDshSearchCandidates({
    ...verificationOptions({
      sources: [{ queryOrdinal: 0, ranked: [ranked(1, malformed)] }],
      fused: [fused("malformed", 1, [{
        ...contribution(0, 1, pointer("malformed", "0")),
      }])],
    }),
    sessionQuery: countingEmptyQuery(() => { reads += 1; }),
  }), /evidence seq must be a canonical unsigned integer/u);
  assert.equal(reads, 0, "malformed referenced evidence must reject before reads");

  const valid = pointer("malformed-contribution", "0");
  await assert.rejects(verifyDshSearchCandidates({
    ...verificationOptions({
      sources: [{ queryOrdinal: 0, ranked: [ranked(1, valid)] }],
      fused: [fused("malformed-contribution", 1, [{
        ...contribution(0, 1, valid),
        sourceRank: 0,
      }])],
    }),
    sessionQuery: countingEmptyQuery(() => { reads += 1; }),
  }), /contribution sourceRank must be an integer in 1\.\.100/u);
  assert.equal(reads, 0, "malformed contribution references must reject before reads");
}

async function mismatchedReferenceAssertions() {
  const evidence = pointer("mismatched", "0");
  let reads = 0;
  const crossReferenceMismatch = await verifyDshSearchCandidates({
    ...verificationOptions({
      sources: [{ queryOrdinal: 0, ranked: [ranked(1, evidence)] }],
      fused: [fused("mismatched", 1, [{
        ...contribution(0, 1, evidence),
        documentKey: "generated:mismatched:stale",
      }])],
    }),
    sessionQuery: countingEmptyQuery(() => { reads += 1; }),
  });
  assert.equal(reads, 0, "a contribution that does not resolve to its ranked pointer must not be read");
  assert.deepEqual(crossReferenceMismatch, { verifiedCandidates: [], verifiedEvidence: [] });

  const authoritativeMismatch = await verifyDshSearchCandidates({
    ...verificationOptions({
      sources: [{ queryOrdinal: 0, ranked: [ranked(1, evidence)] }],
      fused: [fused("mismatched", 1, [contribution(0, 1, evidence)])],
    }),
    sessionQuery: {
      async filterEvents() {
        reads += 1;
        return [document("different-session", 0, "canonical literal")];
      },
    },
  });
  assert.equal(reads, 1, "a resolved pointer performs one authoritative read");
  assert.deepEqual(
    authoritativeMismatch,
    { verifiedCandidates: [], verifiedEvidence: [] },
    "mismatched authoritative evidence must fail closed",
  );
}

async function defaultBoundAssertions() {
  const sources = Array.from({ length: 3 }, (_, queryOrdinal) => ({
    queryOrdinal,
    ranked: Array.from({ length: 100 }, (_, index) => ranked(
      index + 1,
      pointer(`bounded-${index}`, String(queryOrdinal)),
    )),
  }));
  const fusedCandidates = Array.from({ length: 100 }, (_, index) => fused(
    `bounded-${index}`,
    index + 1,
    sources.map((source) => contribution(
      source.queryOrdinal,
      index + 1,
      source.ranked[index].evidence,
    )),
  ));
  let reads = 0;
  const result = await verifyDshSearchCandidates({
    ...verificationOptions({ sources, fused: fusedCandidates }, [
      "first literal",
      "second literal",
      "third literal",
    ]),
    sessionQuery: countingEmptyQuery(() => { reads += 1; }),
  });

  assert.equal(reads, 256, "the default maxCandidates bound must cap referenced exact reads");
  assert.deepEqual(result, { verifiedCandidates: [], verifiedEvidence: [] });
}

async function productionShapedExactReadCounts() {
  const sourceCount = 5;
  const sourceDepth = 100;
  const fusedCount = 20;
  const uniqueTail = 80;
  const sources = Array.from({ length: sourceCount }, (_, queryOrdinal) => ({
    queryOrdinal,
    ranked: [
      ...Array.from({ length: fusedCount }, (_, index) => ranked(
        index + 1,
        pointer(`shared-${index}`, "0"),
      )),
      ...Array.from({ length: uniqueTail }, (_, index) => ranked(
        fusedCount + index + 1,
        pointer(`unique-${queryOrdinal}-${index}`, String(queryOrdinal + 1)),
      )),
    ],
  }));
  const fusedCandidates = Array.from({ length: fusedCount }, (_, index) => fused(
    `shared-${index}`,
    index + 1,
    sources.map((source) => contribution(
      source.queryOrdinal,
      index + 1,
      source.ranked[index].evidence,
    )),
  ));
  const rankedPointers = sources.reduce((count, source) => count + source.ranked.length, 0);
  const uniqueRanked = new Set();
  for (const source of sources) {
    for (const hit of source.ranked) {
      uniqueRanked.add(`${hit.evidence.sessionId}:${hit.evidence.seq}`);
    }
  }
  const previousDefaultReads = countLegacyExactReads(sources, 256);
  const previousCoreReads = countLegacyExactReads(sources, 500);
  let reads = 0;
  const started = process.hrtime.bigint();
  const result = await verifyDshSearchCandidates({
    ...verificationOptions({ sources, fused: fusedCandidates }, [
      "first literal",
      "second literal",
      "third literal",
      "fourth literal",
      "fifth literal",
    ]),
    maxCandidates: 500,
    sessionQuery: countingEmptyQuery(() => { reads += 1; }),
  });
  const elapsedNs = process.hrtime.bigint() - started;

  assert.equal(rankedPointers, 500);
  assert.equal(uniqueRanked.size, fusedCount + sourceCount * uniqueTail);
  assert.equal(previousDefaultReads, 216, "legacy default-256 walk exact-read unused ranked tails");
  assert.equal(previousCoreReads, 420, "legacy qq-core-500 walk exact-read every ranked coordinate");
  assert.equal(reads, fusedCount, "fused-only verification exact-reads each fused session once");
  assert.deepEqual(result, { verifiedCandidates: [], verifiedEvidence: [] });
  console.log(JSON.stringify({
    rankedPointers,
    uniqueRankedCoordinates: uniqueRanked.size,
    legacyExactReadsDefault256: previousDefaultReads,
    legacyExactReadsCore500: previousCoreReads,
    fusedOnlyExactReads: reads,
    fusedOnlyEmptyReadNs: Number(elapsedNs),
  }));
}

function countLegacyExactReads(sources, maxCandidates) {
  const coordinates = new Set();
  let pointersSeen = 0;
  for (const source of sources) {
    for (const hit of source.ranked) {
      if (pointersSeen >= maxCandidates) break;
      coordinates.add(`${hit.evidence.sessionId}:${hit.evidence.seq}`);
      pointersSeen += 1;
    }
  }
  return coordinates.size;
}

function verificationOptions(searchResponse, literals = ["canonical literal"]) {
  return {
    searchResponse,
    literals,
    eventTypeAllowList: ["user/message"],
    surfaceAllowList: ["current"],
  };
}

function pointer(sessionId, seq) {
  return {
    sessionId,
    documentKey: `generated:${sessionId}:${seq}`,
    seq,
    eventTimeUnixMs: 1,
    eventType: "user/message",
    surface: "current",
    snippet: null,
  };
}

function ranked(rank, evidence) {
  return { rank, sessionId: evidence.sessionId, score: 1 / rank, evidence };
}

function fused(sessionId, rank, contributions) {
  return { rank, sessionId, rrfScore: 0.2, contributions };
}

function contribution(queryOrdinal, sourceRank, evidence) {
  return {
    queryOrdinal,
    sourceRank,
    contribution: 0.1,
    documentKey: evidence.documentKey,
    seq: evidence.seq,
    snippet: null,
  };
}

function document(sessionId, seq, text) {
  return {
    sessionId,
    seq,
    type: "user/message",
    time: 1,
    surface: "current",
    text,
  };
}

function countingEmptyQuery(onRead) {
  return {
    async filterEvents() {
      onRead();
      return [];
    },
  };
}
