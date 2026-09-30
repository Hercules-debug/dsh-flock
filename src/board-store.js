/**
 * Board — a single append-only log that every agent reads and writes by choice.
 *
 * This is a DIFFERENT coordination mode from the ring/mesh/swarm cluster in
 * `store.js`.
 *
 *   old mode  (store.js)   the harness reads each neighbour's last log line
 *                          BEFORE dispatch and freezes it into the prompt.
 *                          The agent gets one snapshot and cannot refresh it.
 *
 *   board mode (this file) the harness pushes NOTHING. Each agent gets the
 *                          path and a shell idiom, and decides for itself when
 *                          to read, how much to read, and what to append.
 *
 * Layout:
 *
 *   <root>/<boardId>/board.ndjson    append-only; one JSON object per line
 *   <root>/<boardId>/direction.md    the goal
 *   <root>/<boardId>/config.json     operator knobs
 *   <root>/<boardId>/state.json      starting | running | paused | stopped
 *   <root>/<boardId>/workspace/      artifacts agents produce
 *
 * ── Concurrency ────────────────────────────────────────────────────────────
 *
 * There is no locking, no CAS, no transaction. Conflicts are designed out:
 *
 *   1. APPEND ONLY.      An entry is never edited or deleted, so two writers
 *                        can never overwrite each other. History is the state.
 *
 *   2. ONE WRITE PER    A writer must emit the whole line in a single write,
 *      LINE.             which `O_APPEND` makes atomic on a local filesystem.
 *                        Splitting a line across two writes lets it interleave
 *                        with a concurrent writer's. Measured: 6 writers doing
 *                        three writes per line corrupted 47 of 300 lines and
 *                        lost 9 more; the same load with one write per line
 *                        corrupted 0 of 1600, including 20 KB lines.
 *
 *   3. TOLERATE TORN    A reader may observe a line that is mid-write. A line
 *      READS.            that does not parse is skipped, never fatal — the
 *                        next read sees it whole. This is eventual consistency,
 *                        and it is all a blackboard needs.
 *
 * Consequence: this works on a local filesystem, where `O_APPEND` is atomic.
 * It does NOT hold on NFS/SMB (append is not reliably atomic there) or on
 * object stores like S3 (no append at all — the AWS original writes one object
 * per agent for exactly this reason).
 */
import fs from "node:fs";
import path from "node:path";

export const BOARD_FILENAME = "board.ndjson";

export function boardPaths(root, boardId) {
  const base = path.resolve(root, boardId);
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return {
    base,
    workspace,
    board: path.join(base, BOARD_FILENAME),
    state: path.join(base, "state.json"),
    config: path.join(base, "config.json"),
    direction: path.join(base, "direction.md"),
  };
}

export function writeDirection(paths, text) {
  fs.writeFileSync(paths.direction, text, "utf8");
}

export function readDirection(paths) {
  try {
    return fs.readFileSync(paths.direction, "utf8");
  } catch {
    return "";
  }
}

export function writeConfig(paths, cfg) {
  fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2), "utf8");
}

export function readConfig(paths, fallback = {}) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(paths.config, "utf8")) };
  } catch {
    return { ...fallback };
  }
}

export function readState(paths) {
  try {
    const doc = JSON.parse(fs.readFileSync(paths.state, "utf8"));
    return ["starting", "running", "paused", "stopped"].includes(doc?.state)
      ? doc
      : { state: "stopped", transitionedBy: "system" };
  } catch {
    return { state: "stopped", transitionedBy: "system" };
  }
}

export function writeState(paths, state, by = "operator", reason) {
  const doc = { state, transitionedAt: new Date().toISOString(), transitionedBy: by };
  if (reason) doc.reason = reason;
  fs.writeFileSync(paths.state, JSON.stringify(doc, null, 2), "utf8");
  return doc;
}

/**
 * Parse the board. A line that does not parse is skipped — it is almost always
 * a write observed mid-flight, and the next read will see it whole.
 *
 * Returns `{ entries, skipped, truncatedTail }` so a caller can tell "the board
 * is empty" apart from "the board is unreadable".
 */
export function parseBoard(raw) {
  const entries = [];
  let skipped = 0;
  const lines = raw.split("\n");
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object" && !Array.isArray(e)) entries.push(e);
      else skipped++;
    } catch {
      // Almost always an in-flight write seen mid-line. The next read gets it
      // whole, so this is not an error worth surfacing.
      skipped++;
    }
  }
  return {
    entries,
    skipped,
    // A trailing fragment with no newline means we caught a writer in the act.
    truncatedTail: raw !== "" && !raw.endsWith("\n"),
  };
}

export function readBoard(paths) {
  let raw;
  try {
    raw = fs.readFileSync(paths.board, "utf8");
  } catch {
    return { entries: [], skipped: 0, truncatedTail: false };
  }
  return parseBoard(raw);
}

export function readEntries(paths) {
  return readBoard(paths).entries;
}

/**
 * Append entries in ONE write call, which is what makes concurrent appends
 * safe. Callers may batch several entries; they land together or not at all.
 *
 * `fs.appendFileSync` opens with O_APPEND and issues a single write for the
 * buffer, so this satisfies the one-write-per-line rule without the caller
 * having to think about it.
 */
export function appendEntries(paths, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const stamped = entries.map((e) => ({
    ts: e.ts ?? new Date().toISOString(),
    author: e.author ?? "unknown",
    topic: e.topic ?? "general",
    body: String(e.body ?? ""),
    ...(e.refs !== undefined ? { refs: e.refs } : {}),
    ...(e.artifact !== undefined ? { artifact: e.artifact } : {}),
    ...(e.seq !== undefined ? { seq: e.seq } : {}),
  }));
  fs.appendFileSync(paths.board, stamped.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return stamped;
}

/** Assign sequence numbers to entries that lack one, in read order. */
export function withSeq(entries) {
  return entries.map((e, i) => ({ ...e, seq: typeof e.seq === "number" ? e.seq : i + 1 }));
}

/** Topic histogram — the cheapest way to see the shape of a board. */
export function topicCounts(entries) {
  const m = new Map();
  for (const e of entries) {
    const t = e.topic ?? "general";
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return [...m.entries()].map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count);
}

/** Author histogram with last-seen position. */
export function authorCounts(entries) {
  const m = new Map();
  entries.forEach((e, i) => {
    const a = e.author ?? "unknown";
    const cur = m.get(a) ?? { author: a, count: 0, lastIndex: -1, lastTs: null };
    cur.count++;
    cur.lastIndex = i;
    cur.lastTs = e.ts ?? cur.lastTs;
    m.set(a, cur);
  });
  return [...m.values()].sort((a, b) => a.author.localeCompare(b.author));
}

export function workspaceFiles(paths) {
  try {
    return fs.readdirSync(paths.workspace).filter((f) => !f.startsWith(".")).sort();
  } catch {
    return [];
  }
}
