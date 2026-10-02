/**
 * dsh-flock — self-organizing multi-agent clusters for DeepSeek Harness.
 *
 * A host-plane plugin that gives the current session the ability to start a
 * flock: N real DSH agents coordinating through a shared append-only log with
 * **no orchestrator**. Nobody assigns tasks, no roles are pre-declared, no
 * dependency graph is built. The captain writes one direction file and the
 * cluster organizes itself.
 *
 * This is a port of aws-samples/sample-kiro-flock. The AWS original runs Kiro
 * CLI sessions on EC2 against an S3 bucket; here the agents are DSH subagents
 * and the coordination plane is a directory.
 *
 * Coordination deliberately does NOT use `send_message`: that channel is
 * restricted to the direct parent/child chain and cannot express "read my ring
 * neighbours". Agents coordinate through the shared log, which is
 * topology-independent — the same reason the AWS original uses a bucket rather
 * than a message bus.
 *
 * @module dsh-flock
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import path from "node:path";
import { startCluster, snapshot, render, DEFAULT_CONFIG, PROMPT_DIR, MAX_CLUSTER_AGENTS, resolveClusterSize } from "../src/cluster.js";
import { createSubagentRunner } from "../src/subagent-runner.js";
import { ALGORITHMS } from "../src/neighbours.js";
import { clusterPaths, writeDirection, writeConfig, writeState, readConfig, readState } from "../src/store.js";
import { boardPaths, writeDirection as boardWriteDirection, writeState as boardWriteState } from "../src/board-store.js";
import { safeClusterId } from "../src/ids.js";
import { startBoard, renderBoard, boardSnapshot, resolveBoardSize, MAX_BOARD_AGENTS, BOARD_PROMPT_DIR } from "../src/board-cluster.js";

export const name = "flock";
export const inject = ["tools", "subagents", "agents", "systemPrompt"];

export const Config = z.object({
  /** Where cluster state lives, relative to the workspace. */
  root: z.string().default(".flock"),
  /** Subagent provider used to materialize agents. */
  provider: z.string().default("spawn"),
  /** Defaults applied when a tool call omits them. */
  defaultAgents: z.number().default(4),
  defaultAlgorithm: z.string().default("amorphous"),
  /** Hard ceiling on cluster size (see MAX_CLUSTER_AGENTS). */
  maxAgents: z.number().default(MAX_CLUSTER_AGENTS),
  /** Optional provider/model overrides for the agents. */
  agentProvider: z.string(),
  agentModel: z.string(),
  agentReasoningEffort: z.string(),
});

/**
 * Resolve the flock root for one session.
 *
 * `config.root` may be absolute or relative. A relative root is resolved
 * against the **calling session's workspace** (`agent.session.header.cwd`),
 * which is the directory the user actually opened — never `process.cwd()`.
 * That distinction is a real bug this code shipped with: a web daemon is
 * launched from `/`, so `path.resolve(process.cwd(), ".flock")` produced
 * `/.flock`, and the first mkdir died with EACCES on a read-only root.
 *
 * The workspace is per-session, so this is resolved at call time from the
 * invoking agent rather than once at mount.
 */
export function resolveRoot(config, agent) {
  if (path.isAbsolute(config.root)) return config.root;
  const sessionCwd = agent?.session?.header?.cwd;
  if (typeof sessionCwd === "string" && sessionCwd !== "") {
    return path.resolve(sessionCwd, config.root);
  }
  // No session workspace to anchor to (a headless or scripted host). Refuse to
  // guess: resolving against process.cwd() silently targets the wrong tree.
  throw new Error(
    `flock: cannot resolve the relative root "${config.root}" because the calling ` +
      `session exposes no cwd. Set an absolute root in the profile config.`,
  );
}

export function apply(ctx, config) {
  // A one-line mount banner. Without it a mis-mounted plugin is silent: the
  // tools simply never appear, and there is nothing in the log to explain why.
  const banner =
    `flock: mounted (root=${config.root}, provider=${config.provider}, ` +
    `agents=${config.defaultAgents}, algorithm=${config.defaultAlgorithm})`;
  ctx.logger?.info?.(banner);

  const agentOptions = {
    ...(config.agentProvider ? { provider: config.agentProvider } : {}),
    ...(config.agentModel ? { model: config.agentModel } : {}),
    ...(config.agentReasoningEffort ? { reasoningEffort: config.agentReasoningEffort } : {}),
  };

  ctx.tools.register(defineTool({
    name: "flock_run",
    description:
      "Start a SNAPSHOT cluster: N DSH agents coordinate through a shared log, and the harness reads " +
      "each neighbour's last entry and bakes it into the agent's prompt before dispatch. The agent gets " +
      "one frozen view of its peers and cannot refresh it. A ring/mesh/swarm topology decides who can " +
      "see whom, and the cluster stops when every visible agent reports idle. " +
      "PREFER board_run over this: it pushes nothing and lets each agent read the shared log whenever " +
      "it likes, which suits how an agent actually works and does not depend on an idle handshake that " +
      "agents rarely volunteer. Choose this one only when you specifically want a bounded peer set " +
      "(an amorphous ring keeps per-agent context constant as the cluster grows) or an automatic " +
      "harness-decided stop. Do NOT use either mode when steps depend on each other in a fixed order " +
      "or you need a verification gate between steps — ordinary delegation is better there.",
    parameters: {
      direction: {
        type: "string",
        required: true,
        description: "The goal, in plain language. State WHAT to achieve, not how to decompose it — the path is left to the agents.",
      },
      agents: {
        type: "number",
        description:
          `Cluster size (default 4, hard maximum ${MAX_CLUSTER_AGENTS}). ` +
          `Agents run fully concurrently; cluster size is the only concurrency control.`,
      },
      algorithm: { type: "string", description: `One of: ${ALGORITHMS.join(", ")} (default amorphous).` },
      cluster: { type: "string", description: "Cluster name; also its directory under the flock root." },
      maxRuntimeSeconds: { type: "number", description: "Hard stop after N seconds (default 600)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          cluster: { type: "string", required: true },
          state: { type: "string", required: true },
          agents: { type: "number", required: true },
          converged: { type: "boolean", required: true },
          idle: { type: "number", required: true },
          artifacts: { type: "array", items: { type: "string" }, required: true },
          summary: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.summary }],
    },
    async execute(args, exec) {
      const captain = exec.agent;
      if (!captain) throw new Error("flock_run requires a calling agent");

      const clusterId = safeClusterId(args.cluster ?? `flock-${Date.now().toString(36)}`);
      // Refuse rather than clamp: silently running fewer agents than asked
      // would misrepresent the cluster the caller thinks they started.
      const concurrency = resolveClusterSize(args.agents ?? config.defaultAgents);
      if (concurrency > config.maxAgents) {
        throw new Error(
          `agents=${concurrency} exceeds this profile's maxAgents=${config.maxAgents}`,
        );
      }
      const algorithm = String(args.algorithm ?? config.defaultAlgorithm);
      if (!ALGORITHMS.includes(algorithm)) {
        throw new Error(`unknown algorithm "${algorithm}"; expected one of ${ALGORITHMS.join(", ")}`);
      }

      const runner = createSubagentRunner({
        ctx, captain,
        provider: config.provider,
        agentOptions,
      });

      // A hard deadline: an orphaned cluster retrying a dead endpoint is a real
      // and expensive failure mode.
      const ac = new AbortController();
      const limitMs = Math.max(30, Number(args.maxRuntimeSeconds ?? 600)) * 1000;
      const timer = setTimeout(() => ac.abort(), limitMs);
      const onAbort = () => ac.abort();
      exec.signal?.addEventListener("abort", onAbort, { once: true });

      let events = 0;
      let lastKind = "";
      try {
        await startCluster({
          root: resolveRoot(config, captain),
          clusterId,
          direction: args.direction,
          concurrency,
          config: {
            algorithm,
            neighbourRadius: algorithm === "amorphous" ? 1 : DEFAULT_CONFIG.neighbourRadius,
            swarmK: DEFAULT_CONFIG.swarmK,
          },
          runner,
          signal: ac.signal,
          promptDir: PROMPT_DIR,
          onEvent: (e) => {
            events++;
            lastKind = e.type;
            ctx.logger?.debug?.(`flock: ${e.type} agent-${e.n ?? "-"}`);
          },
        });
      } finally {
        clearTimeout(timer);
        exec.signal?.removeEventListener("abort", onAbort);
      }

      const snap = snapshot(resolveRoot(config, captain), clusterId, concurrency);
      const summary = render(snap) + `\n\n(events: ${events}, last: ${lastKind})`;

      return {
        cluster: clusterId,
        state: snap.state,
        agents: concurrency,
        converged: snap.converged,
        idle: snap.idle,
        artifacts: snap.artifacts,
        summary,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "flock_status",
    description:
      "Inspect a flock cluster without changing it: lifecycle state, algorithm, each agent's last log " +
      "line, and which artifacts exist on disk. Use it to watch a cluster converge or to see what a " +
      "finished one produced.",
    parameters: {
      cluster: { type: "string", required: true, description: "Cluster name." },
      agents: { type: "number", required: true, description: "Cluster size the run was started with." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          state: { type: "string", required: true },
          converged: { type: "boolean", required: true },
          artifacts: { type: "array", items: { type: "string" }, required: true },
          summary: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.summary }],
    },
    async execute(args, exec) {
      const snap = snapshot(
        resolveRoot(config, exec.agent),
        safeClusterId(args.cluster),
        Math.max(1, Number(args.agents)),
      );
      return {
        state: snap.state,
        converged: snap.converged,
        artifacts: snap.artifacts,
        summary: render(snap),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "flock_direct",
    description:
      "Steer a running flock: change its coordination algorithm (hot-reloaded between iterations), " +
      "rewrite its direction, or pause/stop it. Use 'amorphous' to open exploration, 'swarm' as a " +
      "direction forms, 'mesh' to align on the final output.",
    parameters: {
      cluster: { type: "string", required: true, description: "Cluster name." },
      agents: { type: "number", required: true, description: "Cluster size the run was started with." },
      algorithm: { type: "string", description: `Switch topology to one of: ${ALGORITHMS.join(", ")}.` },
      direction: { type: "string", description: "Replace the direction file." },
      state: { type: "string", description: "Set lifecycle state: running | paused | stopped." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          applied: { type: "array", items: { type: "string" }, required: true },
          summary: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.summary }],
    },
    async execute(args, exec) {
      const clusterId = safeClusterId(args.cluster);
      const paths = clusterPaths(
        resolveRoot(config, exec.agent),
        clusterId,
        Math.max(1, Number(args.agents)),
      );
      const applied = [];

      if (args.algorithm !== undefined) {
        if (!ALGORITHMS.includes(args.algorithm)) {
          throw new Error(`unknown algorithm "${args.algorithm}"`);
        }
        const cfg = readConfig(paths, DEFAULT_CONFIG);
        writeConfig(paths, { ...cfg, algorithm: args.algorithm });
        applied.push(`algorithm=${args.algorithm}`);
      }
      if (args.direction !== undefined) {
        writeDirection(paths, args.direction);
        applied.push("direction replaced");
      }
      if (args.state !== undefined) {
        if (!["running", "paused", "stopped"].includes(args.state)) {
          throw new Error(`unknown state "${args.state}"`);
        }
        writeState(paths, args.state, "operator");
        applied.push(`state=${args.state}`);
      }
      if (applied.length === 0) applied.push("(nothing requested)");

      return { applied, summary: `flock ${clusterId}: ${applied.join(", ")}` };
    },
  }));

  // ───────────────────────────────────────────────────────────────────────
  // Board mode.
  //
  // A different coordination shape from flock_run, deliberately kept separate
  // rather than replacing it:
  //
  //   flock_run    the harness reads each neighbour's log line and BAKES IT
  //                INTO THE PROMPT. The agent gets one frozen snapshot.
  //
  //   board_run    the harness pushes NOTHING. The agent gets a file path and
  //                a shell idiom, and decides for itself when to look.
  //
  // Board agents have no tools beyond their own shell, so this works without
  // the host exposing a per-child tool hook.
  // ───────────────────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: "board_run",
    description:
      "Start a blackboard cluster. RECOMMENDED default for self-organizing work: N agents coordinate " +
      "ONLY through one shared append-only log file, and NOTHING is pushed to any agent — each one " +
      "decides for itself when to read the board and what to append, including mid-task. There is no " +
      "orchestrator, no roles, no task list, no topology, and no round structure: each agent is " +
      "dispatched exactly once and decides for itself whether the work is done. " +
      "This suits how an agent actually works — reading peers is a call it can make whenever it wants, " +
      "rather than a snapshot frozen at wake-up. It also removes the idle handshake that flock_run " +
      "depends on, which agents rarely volunteer in practice, so such clusters usually have to be " +
      "stopped by hand. Not suited to work with a fixed step order or a mandatory verification gate " +
      "between steps.",
    parameters: {
      direction: {
        type: "string",
        required: true,
        description: "The goal, in plain language. State WHAT to achieve, not how to decompose it.",
      },
      agents: {
        type: "number",
        description: `Number of agents (default 4, hard maximum ${MAX_BOARD_AGENTS}).`,
      },
      board: { type: "string", description: "Board name; also its directory under the flock root." },
      maxRuntimeSeconds: { type: "number", description: "Hard stop after N seconds (default 900)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          board: { type: "string", required: true },
          state: { type: "string", required: true },
          agents: { type: "number", required: true },
          entries: { type: "number", required: true },
          files: { type: "array", items: { type: "string" }, required: true },
          summary: { type: "string", required: true },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.summary }],
    },
    async execute(args, exec) {
      const captain = exec.agent;
      if (!captain) throw new Error("board_run requires a calling agent");

      const boardId = safeClusterId(args.board ?? `board-${Date.now().toString(36)}`);
      const concurrency = resolveBoardSize(args.agents ?? 4);

      const runner = createSubagentRunner({
        ctx, captain,
        provider: config.provider,
        agentOptions,
      });

      const ac = new AbortController();
      const limitMs = Math.max(30, Number(args.maxRuntimeSeconds ?? 900)) * 1000;
      const timer = setTimeout(() => ac.abort(), limitMs);
      const onAbort = () => ac.abort();
      exec.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        await startBoard({
          root: resolveRoot(config, captain),
          boardId,
          direction: args.direction,
          concurrency,
          runner,
          signal: ac.signal,
          promptDir: BOARD_PROMPT_DIR,
          onEvent: (e) => ctx.logger?.debug?.(`board: ${e.type} agent-${e.n ?? "-"}`),
        });
      } finally {
        clearTimeout(timer);
        exec.signal?.removeEventListener("abort", onAbort);
      }

      const snap = boardSnapshot(resolveRoot(config, captain), boardId);
      return {
        board: boardId,
        state: snap.state,
        agents: concurrency,
        entries: snap.entryCount,
        files: snap.files,
        summary: renderBoard(snap),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "board_status",
    description:
      "Read a blackboard cluster without changing it: how many entries exist, which topics and " +
      "authors are on it, the most recent entries, and which files the agents produced.",
    parameters: {
      board: { type: "string", required: true, description: "Board name." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          state: { type: "string", required: true },
          entries: { type: "number", required: true },
          files: { type: "array", items: { type: "string" }, required: true },
          summary: { type: "string", required: true },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.summary }],
    },
    async execute(args, exec) {
      const snap = boardSnapshot(resolveRoot(config, exec.agent), safeClusterId(args.board));
      return {
        state: snap.state,
        entries: snap.entryCount,
        files: snap.files,
        summary: renderBoard(snap),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "board_direct",
    description:
      "Steer a blackboard cluster: replace its direction, or pause/stop it.",
    parameters: {
      board: { type: "string", required: true, description: "Board name." },
      direction: { type: "string", description: "Replace the direction file." },
      state: { type: "string", description: "Set lifecycle state: running | paused | stopped." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          applied: { type: "array", items: { type: "string" }, required: true },
          summary: { type: "string", required: true },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.summary }],
    },
    async execute(args, exec) {
      const boardId = safeClusterId(args.board);
      const paths = boardPaths(resolveRoot(config, exec.agent), boardId);
      const applied = [];
      if (args.direction !== undefined) {
        boardWriteDirection(paths, args.direction);
        applied.push("direction replaced");
      }
      if (args.state !== undefined) {
        if (!["running", "paused", "stopped"].includes(args.state)) {
          throw new Error(`unknown state "${args.state}"`);
        }
        boardWriteState(paths, args.state, "operator");
        applied.push(`state=${args.state}`);
      }
      if (applied.length === 0) applied.push("(nothing requested)");
      return { applied, summary: `board ${boardId}: ${applied.join(", ")}` };
    },
  }));

  // A short usage section so the model knows the pattern exists and when NOT
  // to reach for it.
  ctx.systemPrompt?.section?.({
    name: "flock",
    text:
      "flock starts self-organizing multi-agent clusters: N agents coordinate only through a shared " +
      "append-only log, with no orchestrator, no assigned roles, and no task graph. " +
      "Two modes exist and they differ in one thing — who decides what an agent knows about its peers. " +
      "Prefer board_run: the harness pushes nothing into the agent's prompt, and the agent reads and " +
      "writes the shared log whenever it likes, so communication timing follows the work rather than a " +
      "schedule. Use flock_run only when you specifically want a bounded peer set (a ring/mesh/swarm " +
      "topology) and are happy for the harness to decide when the work is finished. " +
      "Prefer ordinary delegation when steps depend on each other in a fixed order or you need a " +
      "verification gate between steps.",
    order: 60,
  });
}

export default { name, inject, Config, apply };
