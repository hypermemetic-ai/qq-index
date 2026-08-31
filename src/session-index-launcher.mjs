import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";

const MIN_READERS = 1;
const MAX_READERS = 16;
const MIN_QUEUE_CAPACITY = 1;
const MAX_QUEUE_CAPACITY = 1_024;
const MAX_PATH_BYTES = 4_096;

/** Parse launcher arguments/environment and return detached explicit values. */
export function launcherConfig(argv, environment = process.env, moduleDirectory = process.cwd()) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const values = new Map();
  let planOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") {
      if (planOnly) throw new TypeError("--plan may be supplied only once");
      planOnly = true;
      continue;
    }
    if (!["--daemon", "--socket", "--database", "--readers", "--queue-capacity"].includes(argument)) {
      throw new TypeError(`unexpected launcher argument ${String(argument)}`);
    }
    if (values.has(argument)) throw new TypeError(`${argument} may be supplied only once`);
    index += 1;
    if (index >= argv.length) throw new TypeError(`${argument} requires a value`);
    values.set(argument, argv[index]);
  }

  const runtimeDirectory = environment.XDG_RUNTIME_DIR;
  const stateHome = environment.XDG_STATE_HOME
    ?? (environment.HOME === undefined ? undefined : resolve(environment.HOME, ".local", "state"));
  return Object.freeze({
    daemonPath: values.get("--daemon")
      ?? environment.QQ_SESSION_INDEXD_BIN
      ?? resolve(moduleDirectory, "..", "target", "release", "qq-session-indexd"),
    socketPath: values.get("--socket")
      ?? environment.QQ_SESSION_INDEX_SOCKET
      ?? (runtimeDirectory === undefined ? undefined : resolve(runtimeDirectory, "qq-index", "session-index.sock")),
    databasePath: values.get("--database")
      ?? environment.QQ_SESSION_INDEX_DATABASE
      ?? (stateHome === undefined ? undefined : resolve(stateHome, "qq-index", "session-index.db")),
    readers: parseBoundedInteger(
      values.get("--readers") ?? environment.QQ_SESSION_INDEX_READERS ?? "4",
      "readers",
      MIN_READERS,
      MAX_READERS,
    ),
    queueCapacity: parseBoundedInteger(
      values.get("--queue-capacity") ?? environment.QQ_SESSION_INDEX_QUEUE_CAPACITY ?? "64",
      "queue-capacity",
      MIN_QUEUE_CAPACITY,
      MAX_QUEUE_CAPACITY,
    ),
    planOnly,
  });
}

/** Inspect targets without creating, deleting, renaming, or opening the database. */
export async function planSessionIndexDaemon(config) {
  plainObject(config, "launcher config");
  const daemonPath = absolutePath(config.daemonPath, "daemon path");
  const socketPath = absolutePath(config.socketPath, "socket path");
  const databasePath = absolutePath(config.databasePath, "database path");
  if (socketPath === databasePath) throw new TypeError("socket and database paths must differ");
  const readers = boundedInteger(config.readers, "readers", MIN_READERS, MAX_READERS);
  const queueCapacity = boundedInteger(
    config.queueCapacity,
    "queue-capacity",
    MIN_QUEUE_CAPACITY,
    MAX_QUEUE_CAPACITY,
  );

  await requireNoSymlinkAncestors(daemonPath, false, "daemon path");
  await requireNoSymlinkAncestors(socketPath, false, "socket path");
  await requireNoSymlinkAncestors(databasePath, false, "database path");
  await requirePrivateExecutable(daemonPath);
  await requirePrivateDirectoryParent(socketPath, "socket");
  await requireAbsent(socketPath, "socket target");
  await requirePrivateDirectoryParent(databasePath, "database");

  let mode;
  try {
    const metadata = await lstat(databasePath);
    requirePrivateRegular(metadata, databasePath, "database target");
    mode = "open";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mode = "create";
  }

  const arguments_ = Object.freeze([
    "--socket", socketPath,
    "--database", databasePath,
    mode === "create" ? "--create" : "--open",
    "--readers", String(readers),
    "--queue-capacity", String(queueCapacity),
  ]);
  return Object.freeze({
    daemonPath,
    socketPath,
    databasePath,
    mode,
    readers,
    queueCapacity,
    arguments: arguments_,
  });
}

async function requireNoSymlinkAncestors(path, includeTarget, name) {
  const root = parse(path).root;
  const components = path.slice(root.length).split(sep).filter(Boolean);
  const limit = includeTarget ? components.length : components.length - 1;
  let current = root;
  for (let index = 0; index < limit; index += 1) {
    current = resolve(current, components[index]);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new TypeError(`${name} must not have symlink ancestors`);
  }
}

async function requirePrivateExecutable(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new TypeError("daemon path must be a non-symlink regular file");
  }
  if (metadata.uid !== process.geteuid()) throw new TypeError("daemon path must be owned by this account");
  await access(path, constants.X_OK);
}

async function requirePrivateDirectoryParent(path, name) {
  const parent = dirname(path);
  const metadata = await lstat(parent);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new TypeError(`${name} parent must be a non-symlink directory`);
  }
  if (metadata.uid !== process.geteuid()) throw new TypeError(`${name} parent must be owned by this account`);
  if ((metadata.mode & 0o077) !== 0) throw new TypeError(`${name} parent must be owner-only`);
}

async function requireAbsent(path, name) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new TypeError(`${name} must not already exist`);
}

function requirePrivateRegular(metadata, path, name) {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new TypeError(`${name} must be a non-symlink regular file`);
  }
  if (metadata.uid !== process.geteuid()) throw new TypeError(`${name} must be owned by this account`);
  if (metadata.nlink !== 1) throw new TypeError(`${name} must have exactly one hard link`);
  if ((metadata.mode & 0o077) !== 0) throw new TypeError(`${name} must be owner-only`);
  // Retain the path in operational errors from this private CLI, never in the
  // runtime service status exposed to callers.
  absolutePath(path, name);
}

function absolutePath(value, name) {
  boundedString(value, name, 1, MAX_PATH_BYTES);
  if (!isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  return value;
}

function parseBoundedInteger(value, name, minimum, maximum) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return boundedInteger(Number(value), name, minimum, maximum);
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function boundedString(value, name, minimumBytes, maximumBytes) {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError(`${name} must be a NUL-free string`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw new TypeError(`${name} must contain ${minimumBytes}..${maximumBytes} UTF-8 bytes`);
  }
}

function plainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}
