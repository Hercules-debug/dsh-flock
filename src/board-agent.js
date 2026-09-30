/**
 * Board mode agent loop.
 *
 * The whole difference from `agent.js` is what the prompt contains.
 *
 *   agent.js  reads each neighbour's log tail and BAKES IT INTO THE PROMPT.
 *             The agent receives one snapshot, taken at wake-up, and cannot
 *             refresh it. Reading is the harness's decision.
 *
 *   this file contains ONLY paths and instructions. The agent is told where
 *             the board is and how to read it, and decides for itself when to
 *             look. Reading is the agent's decision.
 *
 * There is no topology (no ring, no mesh, no swarm), because there is nothing
 * to filter: the board is one log and every agent can query all of it. An agent
 * that wants to see only one peer's work does that with `grep`, not by the
 * harness hiding the rest.
 *
 * A "turn" is still one DSH subagent dispatch, because that is the only unit
 * the host gives us. But the agent inside that turn is free to read and write
 * the board as many times as it likes.
 */
import fs from "node:fs";
import path from "node:path";
import {
  boardPaths,
  readState,
  readEntries,
  readBoard,
  topicCounts,
  authorCounts,
  workspaceFiles,
} from "./board-store.js";

const PAUSE_POLL_INTERVAL_MS = 2_000;

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/**
 * Build the per-turn task text. Deliberately contains no board content: the
 * agent must go and look.
 */
export function buildBoardPrompt({ n, boardId, paths, direction, instructions, turn }) {
  return [
    `You are agent-${n} in blackboard cluster "${boardId}". This is turn ${turn}.`,
    ``,
    `Your board:        ${paths.board}`,
    `Shared workspace:  ${paths.workspace}`,
    `Shell variables $BOARD and $WORKSPACE already point at these.`,
    ``,
    `## Direction (the goal — the path is yours)`,
    ``,
    (direction || "").trim() || "(the direction file is empty — do not invent a goal; write that you are idle and stop)",
    ``,
    `## Your instructions`,
    ``,
    instructions,
    ``,
    `## This turn`,
    ``,
    `Nobody has told you what to do. Read the board first, then decide.`,
    `When your turn ends, make sure the board reflects what you did — an agent`,
    `that works without writing is invisible to the cluster.`,
  ].join("\n");
}

/**
 * Load the board instructions and fill in real absolute paths.
 *
 * The template must not promise shell variables the host does not set — an
 * earlier version said "$BOARD and $WORKSPACE are already set", which was
 * simply false, and every command in the prompt would have failed. Concrete
 * paths always work, whichever shell the agent uses.
 */
export function loadBoardInstructions(promptDir, { n, paths } = {}) {
  const raw = fs.readFileSync(path.join(promptDir, "board", "board-loop.md"), "utf8");
  if (!paths) return raw;
  return raw
    .replaceAll("{{BOARD}}", paths.board)
    .replaceAll("{{WORKSPACE}}", paths.workspace)
    .replaceAll("{{AGENT}}", n === undefined ? "agent-N" : `agent-${n}`);
}

/**
 * Run one agent until the board stops or the agent converges.
 *
 * Convergence here is deliberately weaker than in `agent.js`: there is no
 * `idle` handshake, because board agents have no fixed peer set to agree with.
 * Instead an agent stops when it appends an entry whose `topic` is `done`, or
 * when the turn cap is reached. The operator's runtime limit remains the real
 * backstop.
 */
export async function runBoardAgent({
  root,
  boardId,
  n,
  defaults,
  runner,
  promptDir,
  signal,
  onEvent = () => {},
}) {
  const paths = boardPaths(root, boardId);
  const instructions = loadBoardInstructions(promptDir, { n, paths });

  // Wait for the operator to release the board before doing anything.
  while (!signal.aborted) {
    const state = readState(paths);
    if (state.state === "stopped" || state.state === "stopping") {
      onEvent({ type: "exit", n, reason: state.state });
      return { n, turns: 0, reason: state.state };
    }
    if (state.state === "paused") {
      await sleep(PAUSE_POLL_INTERVAL_MS, signal);
      continue;
    }
    break;
  }
  if (signal.aborted) return { n, turns: 0, reason: "aborted" };

  const direction = (() => {
    try { return fs.readFileSync(paths.direction, "utf8"); } catch { return ""; }
  })();

  const before = readEntries(paths).length;
  const prompt = buildBoardPrompt({ n, boardId, paths, direction, instructions, turn: 0 });

  let dispatchError = null;
  try {
    await runner({ prompt, turn: 0, agentIndex: n, boardId, paths, signal });
  } catch (err) {
    dispatchError = String(err?.message ?? err);
    onEvent({ type: "error", n, turn: 0, error: dispatchError });
  }

  // Read back what actually happened. Never infer it from a return value.
  const fresh = readEntries(paths).slice(before);
  if (fresh.length > 0) {
    for (const e of fresh) onEvent({ type: "entry", n, turn: 0, entry: e });
  } else {
    onEvent({ type: "silent", n, turn: 0, error: dispatchError });
  }

  // ONE dispatch per agent, then stop.
  //
  // An earlier version looped: whenever an agent finished without writing
  // `done`, the harness immediately dispatched it again. That is a round
  // structure the agent cannot refuse — the opposite of the point of this
  // mode, where an agent decides for itself when to look at the board.
  //
  // A single dispatch does not limit the agent: inside one turn it can read
  // and write the board as many times as it likes. What it means is that
  // WHEN to stop is the agent's decision, not the harness restarting it
  // forever. `done` is now just an ordinary topic label, not an exit code.
  const reason = fresh.length > 0 ? "contributed" : "silent";
  onEvent({ type: "finished", n, reason });
  return { n, turns: 1, reason };
}

/** Snapshot for rendering. */
export function boardSnapshot(root, boardId) {
  const paths = boardPaths(root, boardId);
  const { entries, skipped, truncatedTail } = readBoard(paths);
  const state = readState(paths);
  return {
    boardId,
    state: state.state,
    entries,
    entryCount: entries.length,
    skipped,
    truncatedTail,
    topics: topicCounts(entries),
    authors: authorCounts(entries),
    files: workspaceFiles(paths),
  };
}
