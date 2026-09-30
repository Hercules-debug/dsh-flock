/**
 * THE live test: boot the real DSH profile, dispatch a real cluster, and check
 * whether the agents actually wrote files.
 *
 * Everything runs against the genuine host runtime — the same `ctx.subagents`
 * the plugin uses in production. It answers the one question the mocked tests
 * cannot: does a real DSH agent, dispatched through this plugin, produce
 * artifacts on disk rather than narrating them?
 *
 * The profile is composed the way the CLI composes it (bundle patches + the
 * profile's own patch layer). Passing an empty patch list boots an empty tree
 * and fails with `extension "" not supported` — the harness bug this file
 * started with.
 *
 * Run:  node test/live-cluster.mjs [agents] [algorithm]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOST = process.env.DSH_HOST_MODULES ||
  "/Users/zhangruihao/.npm/_npx/1e7f6d9597241db0/node_modules";
const AGENTS = Number(process.argv[2] ?? 3);
const ALGORITHM = process.argv[3] ?? "mesh";
const PROFILE = process.env.DSH_LIVE_PROFILE ?? "flocktest";

let pass = 0;
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${String(e?.message ?? e).slice(0, 600)}`); process.exitCode = 1; }
};

console.log(`\nlive cluster: ${AGENTS} agents, ${ALGORITHM}, profile ${PROFILE}\n`);

const boot = await import(`${HOST}/@deepseek-ai/dsh-app-boot/lib/index.js`);

// Work in a scratch workspace so a real cluster cannot scribble on the repo.
import crypto from "node:crypto";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flock-live-"));
process.chdir(workspace);
console.log(`workspace: ${workspace}`);

const profileDir = boot.resolveProfileDir(PROFILE);
const rootConfig = path.join(profileDir, "cordis.yml");
const profile = boot.loadProfile("dsh", PROFILE, profileDir);
const patches = [...profile.layers.flatMap((l) => l.patches), ...(profile.patches ?? [])];
console.log(`patches: ${patches.length} from ${profile.layers.length} bundle layer(s)`);

let ctx;
await ta("the real profile boots with the flock plugin composed in", async () => {
  ctx = await boot.boot("dsh", rootConfig, structuredClone(patches));
  if (!ctx) throw new Error("boot returned no context (loader absent)");
  if (!ctx.get("subagents")) throw new Error("subagents service unavailable");
  if (!ctx.get("tools")) throw new Error("tools service unavailable");
  if (!ctx.subagents.getProvider("spawn")) {
    throw new Error(`spawn provider missing; have: ${ctx.subagents.list().join(", ")}`);
  }
});

await ta("the flock tools are registered in the live registry", async () => {
  // The registry has no `list`; probe by name, which is also how the model's
  // tool schema is assembled.
  const wanted = ["flock_run", "flock_status", "flock_direct"];
  const missing = wanted.filter((n) => ctx.tools.get(n, {}) === undefined);
  if (missing.length) {
    throw new Error(`missing from the live registry: ${missing.join(", ")}`);
  }
  console.log(`      registered: ${wanted.join(", ")}`);
});

// Dispatch through the same code path flock_run uses.
const { startCluster, snapshot, render } = await import("../src/cluster.js");
const { createSubagentRunner } = await import("../src/subagent-runner.js");

// The captain authorizes delegation. Inside a session it is the calling agent;
// standalone we mint a root agent, which is what a session would have handed us.
let captain = ctx.get("agents")?.currentInitiator?.();
const ownsCaptain = captain === undefined;
if (!captain) {
  try {
    const handle = await ctx.get("agents").create({
      sessionId: crypto.randomUUID(),
      meta: { cwd: workspace, origin: "subagent" },
    });
    captain = handle.agent ?? handle;
    console.log(`  · minted a root captain agent (${captain.session?.id ?? "?"})`);
  } catch (err) {
    console.error(`  ! could not create a captain: ${String(err?.message ?? err).slice(0, 300)}`);
    process.exitCode = 1;
  }
}

let snap;
if (captain) {
  await ta(`a real ${AGENTS}-agent cluster writes artifacts to disk`, async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Number(process.env.LIVE_TIMEOUT_MS ?? 900000));

    const runner = createSubagentRunner({
      ctx, captain, provider: "spawn",
      agentOptions: {
        provider: process.env.FLOCK_AGENT_PROVIDER ?? "workbuddy",
        model: process.env.FLOCK_AGENT_MODEL ?? "cn:hy3-b",
      },
      onEvent: (e) => {
        if (e.type === "line") console.log(`      [${e.n}] it=${e.iteration} ${e.line.action}`);
        if (e.type === "no-log-line") console.log(`      [${e.n}] it=${e.iteration} produced NOTHING`);
        if (e.type === "error") console.log(`      [${e.n}] ERROR ${String(e.error).slice(0, 200)}`);
        if (e.type === "settle-unknown") console.log(`      [${e.n}] settle unknown`);
      },
    });

    try {
      await startCluster({
        root: path.join(workspace, ".flock"),
        clusterId: "live",
        direction: [
          "Write ONE small markdown file about log-based multi-agent coordination",
          "into your environment directory, then append exactly one line to your log.",
        ].join(" "),
        concurrency: AGENTS,
        config: { algorithm: ALGORITHM, neighbourRadius: 1, swarmK: 2, autopause: true },
        runner,
        signal: ac.signal,
        maxInflight: 2,
        staggerMs: 800,
      });
    } finally {
      clearTimeout(timer);
    }

    snap = snapshot(path.join(workspace, ".flock"), "live", AGENTS);
    console.log(`\n${render(snap)}\n`);

    // THE assertion this whole exercise exists to make.
    const envDir = path.join(workspace, ".flock", "live", "environment");
    const files = fs.existsSync(envDir) ? fs.readdirSync(envDir) : [];
    if (files.length === 0) {
      throw new Error(
        "environment/ is EMPTY — the agents narrated work instead of doing it. " +
          "This is the exact failure subagent dispatch was meant to fix.",
      );
    }
    const bytes = files.reduce((a, f) => a + fs.statSync(path.join(envDir, f)).size, 0);
    console.log(`      ${files.length} artifact(s), ${bytes} bytes: ${files.join(", ")}`);
  });
}

if (snap?.artifacts?.length) {
  const envDir = path.join(workspace, ".flock", "live", "environment");
  const first = snap.artifacts[0];
  const body = fs.readFileSync(path.join(envDir, first), "utf8");
  console.log(`--- ${first} (first 800 chars) ---\n${body.slice(0, 800)}\n`);
}

console.log(`${pass} checks passed${process.exitCode ? " (with failures)" : ""}`);
console.log(`workspace: ${workspace}\n`);

if (ctx?.fiber?.dispose) await ctx.fiber.dispose();
process.exit(process.exitCode ?? 0);
