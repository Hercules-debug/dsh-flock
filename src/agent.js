/**
 * The flock agent loop, DSH flavour.
 *
 * Same coordination model as the ported AWS original — read the direction, read
 * your visible neighbours' last log lines, make one contribution, append one
 * line — with one structural difference that matters:
 *
 *   The agent is a REAL DSH agent with tools. It writes its own artifact to
 *   disk and can execute it. The loop does not synthesize file content from a
 *   JSON field; it inspects the environment afterwards to see what actually
 *   appeared. "The agent produced nothing" is therefore a real, observable
 *   outcome rather than an unverifiable claim in a log line.
 */
import fs from "node:fs";
import path from "node:path";
import {
  appendLog,
  clusterPaths,
  readConfig,
  readDirection,
  readDirective,
  readState,
  tailLog,
  writeStateConditional,
} from "./store.js";
import { selectNeighbours } from "./neighbours.js";
import { newestArtifact } from "./subagent-runner.js";

const PAUSE_POLL_INTERVAL_MS = 2_000;
const WATCH_POLL_INTERVAL_MS = 250;
const AUTOPAUSE_THRESHOLD = 3;

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Is this action an abstention? Models write "idle — reason" too. */
export function isIdleAction(action) {
  if (typeof action !== "string") return false;
  return /^idle\b/i.test(action.trim());
}

/**
 * Assemble the per-iteration task prompt handed to a fresh child agent.
 *
 * Because the child has tools, the instructions talk about *doing* rather than
 * *reporting*: read these files, write your artifact here, then append one line
 * to your log with this exact command.
 */
export function buildPrompt({
  n,
  clusterId,
  paths,
  neighbours,
  algorithm,
  direction,
  neighbourTails,
  directive,
  loopInstructions,
  algorithmFragment,
}) {
  const header = [
    `You are agent-${n} in self-organizing cluster "${clusterId}".`,
    ``,
    `Direction file:      ${paths.direction}`,
    `Your log file:       ${paths.logOf(n)}`,
    `Your environment dir: ${paths.env}`,
    `Neighbour log files: ${neighbours.length ? neighbours.map((i) => paths.logOf(i)).join(", ") : "(none visible this iteration)"}`,
  ].join("\n");

  const dirBlock = direction.trim()
    ? `\n\n## Direction (the goal — the path is yours)\n\n${direction.trim()}\n`
    : `\n\n## Direction\n\nThe direction file is empty. Do not invent a goal; append an idle line and stop.\n`;

  const neighboursBlock =
    neighbours.length === 0
      ? `\n\n## Neighbours\n\nYou have no visible neighbours this iteration. Work from the direction alone, or go idle.\n`
      : `\n\n## What your neighbours last did\n\n${neighbours
          .map((i) => {
            const t = neighbourTails[i];
            if (!t) return `- agent-${i}: (no log yet)`;
            return `- agent-${i} [iteration ${t.iteration}, action=${t.action}]: ${t.result}  -> next_intent: ${t.next_intent}`;
          })
          .join("\n")}\n`;

  const directiveBlock = directive
    ? `\n\n## Per-Agent Directive (PRIORITY — act on this)\n\n${directive}\n`
    : "";

  return [
    header,
    dirBlock,
    neighboursBlock,
    directiveBlock,
    `\n\n## Algorithm\n\n${algorithmFragment}\n`,
    `\n\n## Instructions\n\n${loopInstructions}\n`,
    `\n\n## How to work (you have tools)\n\n` +
      `1. Read the direction file and your neighbours' logs using your file tools.\n` +
      `2. Do ONE piece of real work and write it into your environment dir\n` +
      `   (\`${paths.env}\`). Write an actual file — do not merely describe one.\n` +
      `   If your artifact is code or a script, RUN it and fix it until it works.\n` +
      `3. Append EXACTLY ONE line to your log (\`${paths.logOf(n)}\`) describing what\n` +
      `   you did. Use a shell append, for example:\n` +
      `   \`\`\`sh\n` +
      `   printf '%s\\n' '{"iteration":<N>,"action":"<verb phrase>","result":"<what you produced and where>","next_intent":"<what you intend next>"}' >> ${paths.logOf(n)}\n` +
      `   \`\`\`\n` +
      `   It must be one valid JSON object on one line. Do not rewrite the file.\n` +
      `4. Stop. Your turn ends after you append that line.\n\n` +
      `If you have nothing distinct to add, append\n` +
      `\`{"iteration":<N>,"action":"idle","result":"<why>","next_intent":"remain idle unless the direction changes"}\`\n` +
      `and stop. Abstaining is a first-class outcome, not a failure.\n`,
  ].join("");
}

/**
 * Run one agent until the cluster stops or this agent converges.
 *
 * `runner` is a real DSH-subagent dispatch in production. It is only expected to
 * *cause work to happen*; what the agent produced is read back from disk, never
 * trusted from a return value.
 */
export async function runAgent({
  root,
  clusterId,
  n,
  concurrency,
  defaults,
  runner,
  promptDir,
  signal,
  onEvent = () => {},
  maxIterations = 0,
}) {
  const paths = clusterPaths(root, clusterId, concurrency);
  let consecutiveAllIdle = 0;
  let iteration = 0;
  let lastSignature = null;
  let currentNeighbours = selectNeighbours({
    algorithm: defaults.algorithm,
    agentIndex: n,
    concurrency,
    radius: defaults.neighbourRadius,
    swarmK: defaults.swarmK,
    paths,
  });

  while (!signal.aborted) {
    if (maxIterations > 0 && iteration >= maxIterations) {
      onEvent({ type: "exit", n, reason: "max-iterations" });
      return { n, iterations: iteration, reason: "max-iterations" };
    }

    // --- between-iteration state machine -------------------------------
    const state = readState(paths);
    if (state.state === "stopped" || state.state === "stopping") {
      onEvent({ type: "exit", n, reason: state.state });
      return { n, iterations: iteration, reason: state.state };
    }
    if (state.state === "paused") {
      if (state.reason === "converged" || state.reason === "autopause") {
        onEvent({ type: "exit", n, reason: state.reason });
        return { n, iterations: iteration, reason: state.reason };
      }
      await sleep(PAUSE_POLL_INTERVAL_MS, signal);
      continue;
    }
    if (state.state === "starting") {
      writeStateConditional(
        paths,
        { state: "running", transitionedAt: new Date().toISOString(), transitionedBy: `agent-${n}` },
        "starting",
      );
    }

    // --- hot-reload config each iteration ------------------------------
    const cfg = readConfig(paths, defaults);
    if (cfg.algorithm !== defaults.algorithm || cfg.neighbourRadius !== defaults.neighbourRadius) {
      currentNeighbours = selectNeighbours({
        algorithm: cfg.algorithm,
        agentIndex: n,
        concurrency,
        radius: cfg.neighbourRadius,
        swarmK: cfg.swarmK,
        paths,
      });
      onEvent({ type: "topology", n, algorithm: cfg.algorithm, neighbours: currentNeighbours });
    }

    // --- new-information gate -------------------------------------------
    // Idle with an unchanged neighbourhood: no new signal, so re-running the
    // agent would burn a full agent turn for nothing. Watch instead.
    const myTail = tailLog(paths, n);
    const signature = JSON.stringify({
      self: myTail ? `${myTail.iteration}:${myTail.action}` : null,
      peers: currentNeighbours.map((i) => {
        const t = tailLog(paths, i);
        return `${i}:${t ? `${t.iteration}:${t.action}` : "-"}`;
      }),
    });
    if (myTail && isIdleAction(myTail.action) && signature === lastSignature) {
      await sleep(WATCH_POLL_INTERVAL_MS, signal);
      continue;
    }
    lastSignature = signature;

    const { loopInstructions, algorithmFragment } = loadPrompts(promptDir, cfg.algorithm);
    const neighbourTails = {};
    for (const i of currentNeighbours) neighbourTails[i] = tailLog(paths, i);

    const prompt = buildPrompt({
      n,
      clusterId,
      paths,
      neighbours: currentNeighbours,
      algorithm: cfg.algorithm,
      direction: readDirection(paths),
      neighbourTails,
      directive: readDirective(paths, n),
      loopInstructions,
      algorithmFragment,
    });

    // --- dispatch: a real DSH agent does the work ------------------------
    const before = Date.now();
    const logLinesBefore = countLogLines(paths, n);
    let dispatchError = null;
    try {
      await runner({ prompt, iteration, agentIndex: n, clusterId, paths, signal });
    } catch (err) {
      dispatchError = String(err?.message ?? err);
      onEvent({ type: "error", n, iteration, error: dispatchError, err });
    }

    // --- read back what actually happened -------------------------------
    // The agent has tools, so the truth is on disk. We never synthesize the
    // log line for it: an agent that claimed work but wrote no log line did
    // not coordinate, and that must be visible rather than papered over.
    const wrote = countLogLines(paths, n) > logLinesBefore;
    const artifact = newestArtifact(paths.env, before);

    if (wrote) {
      const line = tailLog(paths, n);
      onEvent({ type: "line", n, iteration, line, artifact: artifact?.name ?? null });
    } else {
      onEvent({
        type: "no-log-line",
        n,
        iteration,
        artifact: artifact?.name ?? null,
        error: dispatchError,
      });
    }

    // --- convergence ----------------------------------------------------
    // Convergence is a property of the LOGS, not of this turn's activity: the
    // cluster is done when every agent this one can see has appended an idle
    // line and nothing new has appeared. Judging it by whether *this* agent
    // moved would be wrong — an agent that just went idle has, by definition,
    // moved, and would never let the cluster settle.
    if (cfg.autopause !== false) {
      const visible = [n, ...currentNeighbours];
      const tails = visible.map((i) => tailLog(paths, i));
      const allIdle = tails.every((t) => t !== null && isIdleAction(t.action));
      consecutiveAllIdle = allIdle ? consecutiveAllIdle + 1 : 0;

      const selfIdle = isIdleAction(tailLog(paths, n)?.action);
      if ((selfIdle && allIdle) || consecutiveAllIdle >= AUTOPAUSE_THRESHOLD) {
        const flipped = writeStateConditional(
          paths,
          {
            state: "paused",
            transitionedAt: new Date().toISOString(),
            transitionedBy: `agent-${n}`,
            reason: "converged",
          },
          "running",
        );
        onEvent({ type: "converged", n, iteration, flipped });
        return { n, iterations: iteration + 1, reason: "converged" };
      }
    }

    iteration += 1;
    if (signal.aborted) break;
    await sleep(Math.max(0, (cfg.loopIntervalSeconds ?? 0) * 1000), signal);
  }

  return { n, iterations: iteration, reason: "aborted" };
}

function countLogLines(paths, n) {
  try {
    return fs.readFileSync(paths.logOf(n), "utf8").split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return 0;
  }
}

export function loadPrompts(promptDir, algorithm) {
  const read = (f) => fs.readFileSync(path.join(promptDir, f), "utf8");
  return {
    loopInstructions: read("agent-loop.md"),
    algorithmFragment: read(`algorithms/${algorithm}.md`),
  };
}
