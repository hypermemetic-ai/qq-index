import { createHash } from "node:crypto";

export const VIEW_MODULE_ABI_VERSION = "qq-index-view-module/v1";
export const VIEW_QUERY_VERSION = "qq-index-query/v1";

export class ViewContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ViewContractError";
    this.code = code;
  }
}

/** Define one trusted compiled view module; no runtime SQL or expressions are accepted. */
export function defineViewModuleV1(definition) {
  exactObject(definition, ["abiVersion", "manifest", "prepareQuery", "validateResult"], [], "view module");
  equal(definition.abiVersion, VIEW_MODULE_ABI_VERSION, "view module ABI");
  validateManifest(definition.manifest);
  callable(definition.prepareQuery, "view module prepareQuery");
  callable(definition.validateResult, "view module validateResult");
  return deepFreeze({
    abiVersion: definition.abiVersion,
    manifest: structuredClone(definition.manifest),
    prepareQuery: definition.prepareQuery,
    validateResult: definition.validateResult,
  });
}

export function createViewRegistry(modules) {
  if (!Array.isArray(modules) || modules.length === 0 || modules.length > 64) {
    throw new TypeError("view modules must contain 1..64 entries");
  }
  const byIdentity = new Map();
  for (const module of modules) {
    const validated = defineViewModuleV1(module);
    const key = identityKey(validated.manifest);
    if (byIdentity.has(key)) throw new TypeError(`duplicate compiled view ${key}`);
    byIdentity.set(key, validated);
  }
  const manifests = deepFreeze([...byIdentity.values()].map(({ manifest }) => structuredClone(manifest)));
  return Object.freeze({
    capabilities: () => manifests,
    prepareQuery(request, dependencies) {
      plainObject(request, "view request");
      validateIdentity(request.view, "view request view");
      const module = byIdentity.get(identityKey(request.view));
      if (module === undefined) {
        throw new ViewContractError("unsupported_view", `unsupported view ${request.view.id}@${request.view.version}`);
      }
      return module.prepareQuery(request, dependencies);
    },
    validateResult(request, response) {
      const module = byIdentity.get(identityKey(request.view));
      if (module === undefined) throw new ViewContractError("unsupported_view", "unsupported view response");
      return module.validateResult(request, response);
    },
  });
}

function validateManifest(manifest) {
  exactObject(manifest, [
    "id", "version", "digest", "buildId", "sourceContract", "sourceStateVersion",
    "partitionKey", "rowSchema", "authorizationContract", "physicalSchema",
    "maximumPartitionRows", "maximumPartitionBytes", "testOnly", "accesses",
  ], [], "view manifest");
  validateIdentity(manifest, "view manifest");
  if (!/^sha256:[0-9a-f]{64}$/u.test(manifest.digest)) throw new TypeError("view manifest digest is invalid");
  const expectedDigest = manifestDigest(manifest);
  if (manifest.digest !== expectedDigest) {
    throw new TypeError(`view manifest digest mismatch: expected ${expectedDigest}`);
  }
  for (const key of ["buildId", "sourceContract", "sourceStateVersion", "partitionKey", "rowSchema", "authorizationContract", "physicalSchema"]) {
    text(manifest[key], `view manifest ${key}`, 1, 256);
  }
  integer(manifest.maximumPartitionRows, "view manifest maximumPartitionRows", 1, 1_024);
  integer(manifest.maximumPartitionBytes, "view manifest maximumPartitionBytes", 1_024, 900 * 1_024);
  if (typeof manifest.testOnly !== "boolean") throw new TypeError("view manifest testOnly must be boolean");
  if (!Array.isArray(manifest.accesses) || manifest.accesses.length === 0 || manifest.accesses.length > 32) {
    throw new TypeError("view manifest accesses must contain 1..32 entries");
  }
  const seen = new Set();
  for (const access of manifest.accesses) {
    exactObject(access, ["name", "maximumResults", "maximumWorkUnits", "authorization"], [], "view access");
    text(access.name, "view access name", 1, 128);
    integer(access.maximumResults, "view access maximumResults", 1, 10_000);
    integer(access.maximumWorkUnits, "view access maximumWorkUnits", 1, 1_000_000);
    text(access.authorization, "view access authorization", 1, 128);
    if (seen.has(access.name)) throw new TypeError("view access names must be unique");
    seen.add(access.name);
  }
}

export function validatePublicQueryEnvelope(request, expected) {
  exactObject(request, ["version", "view", "access", "params", "authority", "freshness"], [], "view request");
  equal(request.version, VIEW_QUERY_VERSION, "view request version");
  validateIdentity(request.view, "view request view");
  equal(request.view.id, expected.id, "view request id");
  equal(request.view.version, expected.version, "view request view version");
  equal(request.access, expected.access, "view request access");
  exactObject(request.authority, ["kind", "workspaceIds"], [], "view request authority");
  equal(request.authority.kind, "workspace-set/v1", "view request authority kind");
  stringList(request.authority.workspaceIds, "view request workspaceIds", 1, 16, 4_096);
  if (new Set(request.authority.workspaceIds).size !== request.authority.workspaceIds.length) {
    throw new TypeError("view request workspaceIds must be unique");
  }
  exactObject(request.freshness, ["mode", "maxLagMs"], [], "view request freshness");
  equal(request.freshness.mode, "caught-up", "view request freshness mode");
  integer(request.freshness.maxLagMs, "view request maxLagMs", 0, Number.MAX_SAFE_INTEGER);
}

export function toWireAuthority(workspaceIds, deriveWorkspaceScopeToken) {
  callable(deriveWorkspaceScopeToken, "deriveWorkspaceScopeToken");
  const tokens = [...new Set(workspaceIds.map((workspaceId) => deriveWorkspaceScopeToken(workspaceId)))];
  if (tokens.length === 0) throw new ViewContractError("authorization_required", "workspace authority is required");
  return Object.freeze({ kind: "workspace-token-set/v1", scopeTokens: Object.freeze(tokens) });
}

export function exactObject(value, required, optional, name) {
  plainObject(value, name);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${name}.${key} is required`);
}

export function plainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

export function text(value, name, minimum, maximum) {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError(`${name} must be a NUL-free string`);
  const length = Buffer.byteLength(value, "utf8");
  if (length < minimum || length > maximum) throw new TypeError(`${name} must contain ${minimum}..${maximum} UTF-8 bytes`);
}

export function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be an integer in ${minimum}..${maximum}`);
}

export function stringList(value, name, minimum, maximum, maximumBytes) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${name} must contain ${minimum}..${maximum} entries`);
  }
  for (const [index, entry] of value.entries()) text(entry, `${name}[${index}]`, 1, maximumBytes);
}

export function equal(actual, expected, name) {
  if (actual !== expected) throw new TypeError(`${name} must equal ${JSON.stringify(expected)}`);
}

export function callable(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
}

export function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function manifestDigest(manifest) {
  const { digest: _digest, ...identity } = manifest;
  const encoded = JSON.stringify(canonicalJson(identity));
  return `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function validateIdentity(identity, name) {
  plainObject(identity, name);
  text(identity.id, `${name}.id`, 1, 128);
  integer(identity.version, `${name}.version`, 1, 0xffff_ffff);
}

function identityKey({ id, version }) { return `${id}\0${version}`; }
