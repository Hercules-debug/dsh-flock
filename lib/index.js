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
import fs from "node:fs";
import { startCluster, snapshot, render, DEFAULT_CONFIG, PROMPT_DIR } from "../src/cluster.js";
import { createSubagentRunner } from "../src/subagent-runner.js";
import { ALGORITHMS } from "../src/neighbours.js";
import { clusterPaths, writeDirection, writeConfig, writeState, readConfig, readState } from "../src/store.js";
import { safeClusterId } from "../src/ids.js";

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
  /** Cap on concurrently running agent turns. */
  maxInflight: z.number().default(2),
  /** Delay between agent starts, in ms. */
  staggerMs: z.number().default(500),
  /** Optional provider/model overrides for the agents. */
  agentProvider: z.string(),
  agentModel: z.string(),
  agentReasoningEffort: z.string(),
});

export function apply(ctx, config) {
  const root = () => path.resolve(process.cwd(), config.root);

  // A one-line mount banner. Without it a mis-mounted plugin is silent: the
  // tools simply never appear, and there is nothing in the log to explain why.
  const banner =
    `flock: mounted (root=${config.root}, provider=${config.provider}, ` +
    `agents=${config.defaultAgents}, algorithm=${config.defaultAlgorithm})`;
  ctx.logger?.info?.(banner);
  // Breadcrumb: a host that swallows stdout during boot would otherwise leave
  // no evidence that the plugin loaded at all. Best effort — never fatal.
  try {
    fs.writeFileSync(
      path.join(process.cwd(), ".flock-boot.log"),
      `${new Date().toISOString()} ${banner}\n`,
      { flag: "a" },
    );
  } catch { /* read-only workspace is fine */ }

  const agentOptions = {
    ...(config.agentProvider ? { provider: config.agentProvider } : {}),
    ...(config.agentModel ? { model: config.agentModel } : {}),
    ...(config.agentReasoningEffort ? { reasoningEffort: config.agentReasoningEffort } : {}),
  };

  ctx.tools.register(defineTool({
    name: "flock_run",
    description:
      "Start a self-organizing multi-agent cluster: N DSH agents coordinate ONLY by reading and " +
      "appending to a shared log on disk. There is no orchestrator, no task list, no assigned roles. " +
      "You supply one direction (the goal); the agents decide for themselves what to do, build on and " +
      "criticize each other's artifacts, and converge by all going idle. Use this for work that splits " +
      "into many quasi-independent contributions where diversity of approach is an asset. Do NOT use it " +
      "when steps depend on each other in a fixed order or you need a verification gate between steps — " +
      "a normal delegation is better there.",
    parameters: {
      direction: {
        type: "string",
        required: true,
        description: "The goal, in plain language. State WHAT to achieve, not how to decompose it — the path is left to the agents.",
      },
      agents: { type: "number", description: "Cluster size (default 4)." },
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
      const concurrency = Math.max(1, Math.min(64, Number(args.agents ?? config.defaultAgents)));
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
          root: root(),
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
          maxInflight: config.maxInflight,
          staggerMs: config.staggerMs,
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

      const snap = snapshot(root(), clusterId, concurrency);
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
    async execute(args) {
      const snap = snapshot(root(), safeClusterId(args.cluster), Math.max(1, Number(args.agents)));
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
    async execute(args) {
      const clusterId = safeClusterId(args.cluster);
      const paths = clusterPaths(root(), clusterId, Math.max(1, Number(args.agents)));
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

  // A short usage section so the model knows the pattern exists and when NOT
  // to reach for it.
  ctx.systemPrompt?.section?.({
    name: "flock",
    text:
      "flock starts self-organizing multi-agent clusters: N agents coordinate only through a shared " +
      "append-only log, with no orchestrator, no assigned roles, and no task graph. Reach for it when " +
      "work splits into many quasi-independent contributions and diversity of approach is an asset. " +
      "Prefer ordinary delegation when steps depend on each other in a fixed order or you need a " +
      "verification gate between steps.",
    order: 60,
  });
}

export default { name, inject, Config, apply };
