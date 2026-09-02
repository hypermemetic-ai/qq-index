import {
  VIEW_MODULE_ABI_VERSION, deepFreeze, defineViewModuleV1, exactObject, integer,
  plainObject, text, toWireAuthority, validatePublicQueryEnvelope,
} from "./registry.mjs";

const manifest = deepFreeze({
  id: "qq.test.exact-range", version: 1,
  digest: "sha256:528222f54ca28386148f2a2f0d3443a1f1078ac615dd5fc584e2e63eaec2e365",
  buildId: "exact-range-v1-physical-1", sourceContract: "generated-test-source/v1",
  sourceStateVersion: "generated-exact-range-projection-v1", partitionKey: "bucket",
  rowSchema: "generated-exact-range-row-v1", authorizationContract: "workspace-token-set/v1",
  maximumPartitionRows: 1_024,
  maximumPartitionBytes: 900 * 1_024,
  physicalSchema: "generated-exact-range-sqlite-v1", testOnly: true,
  accesses: [{ name: "exact-range", maximumResults: 32, maximumWorkUnits: 32, authorization: "workspace-token-set/v1:pre-result" }],
});

export const exactRangeTestViewV1 = defineViewModuleV1({
  abiVersion: VIEW_MODULE_ABI_VERSION,
  manifest,
  prepareQuery(request, { deriveWorkspaceScopeToken } = {}) {
    validatePublicQueryEnvelope(request, { id: manifest.id, version: 1, access: "exact-range" });
    exactObject(request.params, ["exactKey", "minimum", "maximum", "limit"], [], "exact-range params");
    text(request.params.exactKey, "exact-range exactKey", 1, 256);
    integer(request.params.minimum, "exact-range minimum", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    integer(request.params.maximum, "exact-range maximum", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (request.params.minimum > request.params.maximum) throw new TypeError("exact-range minimum must not exceed maximum");
    integer(request.params.limit, "exact-range limit", 1, 32);
    return deepFreeze({
      version: request.version, view: structuredClone(request.view), access: request.access,
      params: structuredClone(request.params),
      authority: toWireAuthority(request.authority.workspaceIds, deriveWorkspaceScopeToken),
      freshness: structuredClone(request.freshness),
    });
  },
  validateResult(request, response) {
    plainObject(response.result, "exact-range result");
    exactObject(response.result, ["rows"], [], "exact-range result");
    if (!Array.isArray(response.result.rows) || response.result.rows.length > request.params.limit) throw new TypeError("exact-range rows exceed limit");
    for (const row of response.result.rows) {
      exactObject(row, ["rowKey", "ordinal", "value"], [], "exact-range row");
      text(row.rowKey, "exact-range rowKey", 1, 256);
      integer(row.ordinal, "exact-range ordinal", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      text(row.value, "exact-range value", 0, 4_096);
    }
    return deepFreeze(structuredClone(response));
  },
});
