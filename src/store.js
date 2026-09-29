/**
 * Shared environment — the coordination plane.
 *
 * Port of kiro-flock's `lambda/s3Store.ts` + `agent/s3Mcp.ts` to the local
 * filesystem. In the AWS original this is an S3 bucket; here it is a
 * directory. The contract is identical:
 *
 *   {cluster}/direction.md              the goal, written once by the operator
 *   {cluster}/config.json               algorithm / radius / swarmK / interval
 *   {cluster}/store/state.json          lifecycle: starting|running|paused|...
 *   {cluster}/store/agent-{n}.ndjson    one append-only log per agent
 *   {cluster}/environment/              artifacts agents write and read
 *
 * The append-only log line is the ENTIRE coordination message. No broker
 * delivers it, no acknowledgement comes back. That is the whole point.
 */
import fs from "node:fs";
import path from "node:path";

export const STATE_VALUES = ["starting", "running", "paused", "stopping", "stopped"];

/** Resolve the storage root for a cluster and make sure it exists. */
export function clusterPaths(root, clusterId, concurrency) {
  const base = path.resolve(root, clusterId);
  const store = path.join(base, "store");
  const env = path.join(base, "environment");
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(env, { recursive: true });
  return {
    base,
    store,
    env,
    direction: path.join(base, "direction.md"),
    config: path.join(base, "config.json"),
    state: path.join(store, "state.json"),
    logOf: (n) => path.join(store, `agent-${n}.ndjson`),
    directiveOf: (n) => path.join(store, `agent-${n}.directive.md`),
  };
}

export function readDirection(paths) {
  try {
    return fs.readFileSync(paths.direction, "utf8");
  } catch {
    return "";
  }
}

export function writeDirection(paths, text) {
  fs.writeFileSync(paths.direction, text, "utf8");
}

export function readConfig(paths, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(paths.config, "utf8")) };
  } catch {
    return { ...fallback };
  }
}

export function writeConfig(paths, cfg) {
  fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2), "utf8");
}

/** Missing state.json is treated as "stopped", same fallback as the Lambda. */
export function readState(paths) {
  try {
    const doc = JSON.parse(fs.readFileSync(paths.state, "utf8"));
    if (!STATE_VALUES.includes(doc.state)) throw new Error("bad state");
    return doc;
  } catch {
    return {
      state: "stopped",
      transitionedAt: "1970-01-01T00:00:00.000Z",
      transitionedBy: "system",
    };
  }
}

/**
 * Conditional state write. Mirrors the S3 If-Match semantics: the operator's
 * transition always wins, so an agent only changes state if it still observes
 * the value it expected.
 */
export function writeStateConditional(paths, next, expected) {
  const current = readState(paths);
  if (expected !== undefined && current.state !== expected) return false;
  fs.writeFileSync(paths.state, JSON.stringify(next, null, 2), "utf8");
  return true;
}

export function writeState(paths, state, by, reason) {
  const doc = {
    state,
    transitionedAt: new Date().toISOString(),
    transitionedBy: by,
  };
  if (reason) doc.reason = reason;
  fs.writeFileSync(paths.state, JSON.stringify(doc, null, 2), "utf8");
  return doc;
}

/**
 * Append exactly one coordination line. The line IS the message.
 * Fields follow the AWS reference: did / result / next_intent.
 */
export function appendLog(paths, n, entry) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    iteration: entry.iteration,
    action: entry.action,
    result: entry.result ?? "",
    next_intent: entry.next_intent ?? "",
  });
  fs.appendFileSync(paths.logOf(n), line + "\n", "utf8");
  return JSON.parse(line);
}

/**
 * Last entry of one agent's log. This is what neighbours read: only the most
 * recent line, never the full history. Mirrors s3Store's tail read.
 */
export function tailLog(paths, n) {
  let raw;
  try {
    raw = fs.readFileSync(paths.logOf(n), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/** Last N entries — used by the dashboard/analysis, not by agents. */
export function readLog(paths, n, limit = 50) {
  try {
    return fs
      .readFileSync(paths.logOf(n), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-limit);
  } catch {
    return [];
  }
}

export function lastModified(paths, n) {
  try {
    return fs.statSync(paths.logOf(n)).mtimeMs;
  } catch {
    return 0;
  }
}

export function readDirective(paths, n) {
  try {
    const t = fs.readFileSync(paths.directiveOf(n), "utf8").trim();
    return t === "" ? null : t;
  } catch {
    return null;
  }
}
