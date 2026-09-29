/**
 * Cluster launcher and snapshot.
 *
 * The operator writes ONE direction file and starts the cluster. Nothing is
 * assigned to anyone: no task list, no roles, no dependency graph. Everything
 * after that is read from the shared store.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clusterPaths,
  readConfig,
  readState,
  readLog,
  writeConfig,
  writeDirection,
  writeState,
} from "./store.js";
import { selectNeighbours, convergenceEstimate } from "./neighbours.js";
import { runAgent, isIdleAction } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROMPT_DIR = path.resolve(__dirname, "..", "prompts");

export const DEFAULT_CONFIG = {
  algorithm: "amorphous",
  neighbourRadius: 1,
  swarmK: 3,
  loopIntervalSeconds: 0,
  autopause: true,
};

export async function startCluster({
  root,
  clusterId,
  direction,
  concurrency,
  config = {},
  runner,
  signal,
  onEvent = () => {},
  promptDir = PROMPT_DIR,
  maxIterations = 0,
  /** Max agent turns in flight. A real DSH agent is far heavier than an HTTP call. */
  maxInflight = 2,
  staggerMs = 500,
}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const paths = clusterPaths(root, clusterId, concurrency);

  if (direction !== undefined) writeDirection(paths, direction);
  writeConfig(paths, cfg);
  writeState(paths, "starting", "operator");

  // Carry-over control: a previous run's artifacts must not be read as current
  // context. Mirrors the AWS "carry-over" failure mode.
  const history = path.join(paths.base, "history");
  fs.mkdirSync(history, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const f of fs.readdirSync(paths.env)) {
    if (f === ".gitkeep") continue;
    fs.renameSync(path.join(paths.env, f), path.join(history, `${stamp}__${f}`));
  }

  const limitedRunner = withConcurrencyLimit(runner, maxInflight);
  onEvent({
    type: "start",
    clusterId,
    concurrency,
    algorithm: cfg.algorithm,
    radius: cfg.neighbourRadius,
    maxInflight,
  });

  const tasks = [];
  for (let n = 0; n < concurrency; n++) {
    tasks.push(
      runAgent({
        root, clusterId, n, concurrency,
        defaults: cfg,
        runner: limitedRunner,
        promptDir,
        signal,
        onEvent,
        maxIterations,
      }),
    );
    if (staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs));
  }
  const results = await Promise.allSettled(tasks);
  return { clusterId, results, paths };
}

/** Bound how many agents run at once — a real agent turn is expensive. */
export function withConcurrencyLimit(fn, limit) {
  if (!limit || limit <= 0) return fn;
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { args, resolve, reject } = queue.shift();
    Promise.resolve().then(() => fn(args)).then(resolve, reject).finally(() => { active--; next(); });
  };
  return (args) => {
    if (active < limit) {
      active++;
      return Promise.resolve().then(() => fn(args)).finally(() => { active--; next(); });
    }
    return new Promise((resolve, reject) => queue.push({ args, resolve, reject }));
  };
}

export function snapshot(root, clusterId, concurrency) {
  const paths = clusterPaths(root, clusterId, concurrency);
  const cfg = readConfig(paths, DEFAULT_CONFIG);
  const state = readState(paths);
  const agents = [];
  for (let n = 0; n < concurrency; n++) {
    const log = readLog(paths, n);
    agents.push({ n, entries: log.length, last: log[log.length - 1] ?? null });
  }
  const idle = agents.filter((a) => isIdleAction(a.last?.action)).length;
  const reported = agents.filter((a) => a.last !== null).length;
  const artifacts = fs.existsSync(paths.env)
    ? fs.readdirSync(paths.env).filter((f) => f !== ".gitkeep")
    : [];
  return {
    clusterId,
    state: state.state,
    config: cfg,
    agents,
    idle,
    reported,
    artifacts,
    converged: reported > 0 && idle === reported,
  };
}

export function render(snap) {
  const lines = [];
  const { propagation, consensusLow, consensusHigh } = convergenceEstimate(
    snap.agents.length,
    snap.config.neighbourRadius,
  );
  lines.push(
    `cluster ${snap.clusterId}  state=${snap.state}  algorithm=${snap.config.algorithm}  radius=${snap.config.neighbourRadius}`,
  );
  lines.push(`convergence: propagate ${propagation} iterations, consensus ${consensusLow}-${consensusHigh}`);
  lines.push(`progress: ${snap.reported}/${snap.agents.length} reported, ${snap.idle} idle, ${snap.artifacts.length} artifacts`);
  lines.push("");
  for (const a of snap.agents) {
    const short = (s, w) => (s.length > w ? s.slice(0, w - 1) + "…" : s);
    if (!a.last) lines.push(`  agent-${a.n}  (no log yet)`);
    else
      lines.push(
        `  agent-${a.n}  it=${String(a.last.iteration).padStart(2)}  ` +
          `${short(a.last.action, 26).padEnd(27)} ${short(a.last.result, 58)}`,
      );
  }
  if (snap.artifacts.length) {
    lines.push("");
    lines.push(`artifacts: ${snap.artifacts.join(", ")}`);
  }
  return lines.join("\n");
}
