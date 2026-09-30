/**
 * Board cluster launcher.
 *
 * Same shape as `cluster.js` but with no topology: every agent reads the same
 * board and can query any part of it. There is no neighbour set to compute and
 * no snapshot to pre-read.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardPaths, writeConfig, writeDirection, writeState, readConfig } from "./board-store.js";
import { runBoardAgent, boardSnapshot } from "./board-agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BOARD_PROMPT_DIR = path.resolve(__dirname, "..", "prompts");

export const BOARD_DEFAULT_CONFIG = {};

/** Hard ceiling, same reasoning as the cluster mode. */
export const MAX_BOARD_AGENTS = 10;

export function resolveBoardSize(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`agents must be a positive number, got ${JSON.stringify(requested)}`);
  }
  const size = Math.floor(n);
  if (size > MAX_BOARD_AGENTS) {
    throw new Error(
      `agents=${size} exceeds the maximum of ${MAX_BOARD_AGENTS}. ` +
        `Each agent is a full DSH session, so boards are capped.`,
    );
  }
  return size;
}

export async function startBoard({
  root,
  boardId,
  direction,
  concurrency,
  config = {},
  runner,
  signal,
  onEvent = () => {},
  promptDir = BOARD_PROMPT_DIR,
}) {
  const cfg = { ...BOARD_DEFAULT_CONFIG, ...config };
  const paths = boardPaths(root, boardId);

  if (direction !== undefined) writeDirection(paths, direction);
  writeConfig(paths, cfg);
  writeState(paths, "starting", "operator");

  // Carry-over control: a previous run's artifacts are not current context.
  const history = path.join(paths.base, "history");
  fs.mkdirSync(history, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const f of fs.readdirSync(paths.workspace)) {
    if (f.startsWith(".")) continue;
    fs.renameSync(path.join(paths.workspace, f), path.join(history, `${stamp}__${f}`));
  }

  writeState(paths, "running", "operator");
  onEvent({ type: "start", boardId, concurrency });

  // Every agent is dispatched exactly once. There is no round structure: an
  // agent decides for itself when to look at the board and when it is done,
  // and the harness never restarts it. The board tolerates concurrent appends
  // by construction, so there is nothing to stagger for either.
  const tasks = [];
  for (let n = 0; n < concurrency; n++) {
    tasks.push(
      runBoardAgent({
        root, boardId, n,
        defaults: cfg,
        runner,
        promptDir,
        signal,
        onEvent,
      }),
    );
  }
  const results = await Promise.allSettled(tasks);
  return { boardId, results, paths };
}

/** Render a board snapshot as text. */
export function renderBoard(snap) {
  const lines = [];
  lines.push(`board ${snap.boardId}   state=${snap.state}   entries=${snap.entryCount}   files=${snap.files.length}`);
  if (snap.skipped > 0) {
    lines.push(`  (${snap.skipped} unparsable line(s) skipped — usually a write caught mid-flight)`);
  }
  lines.push("");
  if (snap.topics.length) {
    lines.push("topics:");
    for (const t of snap.topics) lines.push(`  ${String(t.count).padStart(3)}  ${t.topic}`);
    lines.push("");
  }
  if (snap.authors.length) {
    lines.push("authors:");
    for (const a of snap.authors) lines.push(`  ${String(a.count).padStart(3)}  ${a.author}`);
    lines.push("");
  }
  const tail = snap.entries.slice(-12);
  if (tail.length) {
    lines.push(`last ${tail.length} entries:`);
    for (const e of tail) {
      const body = String(e.body ?? "").replace(/\s+/g, " ");
      lines.push(`  [${e.author} · ${e.topic}] ${body.slice(0, 100)}${body.length > 100 ? "…" : ""}`);
    }
  }
  if (snap.files.length) {
    lines.push("");
    lines.push(`workspace: ${snap.files.join(", ")}`);
  }
  return lines.join("\n");
}

export { boardSnapshot, readConfig };
