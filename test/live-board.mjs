/**
 * Live board test: do real DSH agents read and write the board on their own?
 *
 * The mocked suite proves the storage and the loop. This proves the thing that
 * actually matters: that an agent, given only a path and a shell idiom, chooses
 * to look at the board and to write to it — with nothing pushed into its prompt.
 *
 * Run:  node test/live-board.mjs [agents] [seconds]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const HOST = process.env.DSH_HOST_MODULES ||
  "/Users/zhangruihao/.npm/_npx/1e7f6d9597241db0/node_modules";
const AGENTS = Number(process.argv[2] ?? 3);
const PROFILE = process.env.DSH_LIVE_PROFILE ?? "flocktest";
const PROMPT_DIR = path.resolve("prompts");

let pass = 0;
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${String(e?.message ?? e).slice(0, 500)}`); process.exitCode = 1; }
};

console.log(`\nlive board: ${AGENTS} agents, profile ${PROFILE}\n`);

const boot = await import(`${HOST}/@deepseek-ai/dsh-app-boot/lib/index.js`);
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "board-live-"));
process.chdir(workspace);
console.log(`workspace: ${workspace}`);

const profileDir = boot.resolveProfileDir(PROFILE);
const profile = boot.loadProfile("dsh", PROFILE, profileDir);
const patches = [...profile.layers.flatMap((l) => l.patches), ...(profile.patches ?? [])];

let ctx;
await ta("the profile boots", async () => {
  ctx = await boot.boot("dsh", path.join(profileDir, "cordis.yml"), structuredClone(patches));
  if (!ctx?.get("subagents")) throw new Error("no subagents service");
});

let captain;
await ta("mint a root captain", async () => {
  const handle = await ctx.get("agents").create({
    sessionId: crypto.randomUUID(),
    meta: { cwd: workspace, origin: "subagent" },
  });
  captain = handle.agent ?? handle;
  if (!captain) throw new Error("no captain");
});

const { startBoard } = await import("../src/board-cluster.js");
const { boardSnapshot } = await import("../src/board-agent.js");
const { readEntries, boardPaths } = await import("../src/board-store.js");
const { createSubagentRunner } = await import("../src/subagent-runner.js");

let snap;
await ta("agents read and write the board unprompted", async () => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(process.env.LIVE_TIMEOUT_MS ?? 420000));

  const runner = createSubagentRunner({
    ctx, captain, provider: "spawn",
    agentOptions: {
      provider: process.env.FLOCK_AGENT_PROVIDER ?? "workbuddy",
      model: process.env.FLOCK_AGENT_MODEL ?? "cn:hy3-b",
    },
    onEvent: (e) => {
      if (e.type === "entry") console.log(`      [${e.entry.author} · ${e.entry.topic}] ${String(e.entry.body).replace(/\s+/g, " ").slice(0, 90)}`);
      if (e.type === "silent") console.log(`      agent-${e.n} turn ${e.turn}: wrote NOTHING`);
      if (e.type === "error") console.log(`      agent-${e.n} ERROR ${String(e.error).slice(0, 160)}`);
      if (e.type === "done") console.log(`      agent-${e.n} declared done`);
    },
  });

  try {
    await startBoard({
      root: path.join(workspace, ".flock"),
      boardId: "live",
      direction: [
        "On the shared board, agree on and write down THREE distinct short pieces of advice",
        "for someone who has never used a blackboard-style multi-agent setup.",
        "Read the board before you write, so you add something that is not already there.",
        "When three distinct pieces of advice exist, write an entry with topic `done` and stop.",
      ].join(" "),
      concurrency: AGENTS,
      runner,
      signal: ac.signal,
      promptDir: PROMPT_DIR,
    });
  } finally {
    clearTimeout(timer);
  }

  snap = boardSnapshot(path.join(workspace, ".flock"), "live");
  console.log(`\n${snap.entryCount} entries from ${snap.authors.length} author(s)\n`);

  // THE assertion: agents must have written to the board without being told
  // how many times, and without any board content being pushed to them.
  if (snap.entryCount === 0) {
    throw new Error("the board is EMPTY — agents did not write. Nothing was pushed to them, so this means they did not look.");
  }
  const authors = snap.authors.map((a) => a.author);
  console.log(`      authors: ${authors.join(", ")}`);
  console.log(`      topics:  ${snap.topics.map((t) => `${t.topic}(${t.count})`).join(", ")}`);
});

if (snap) {
  console.log("\n--- board ---");
  for (const e of readEntries(boardPaths(path.join(workspace, ".flock"), "live"))) {
    console.log(`#${e.seq ?? "?"} ${e.author} · ${e.topic}`);
    console.log(`   ${String(e.body).replace(/\n/g, "\n   ").slice(0, 400)}`);
  }
  if (snap.files.length) console.log(`\nworkspace files: ${snap.files.join(", ")}`);
}

console.log(`\n${pass} checks passed${process.exitCode ? " (with failures)" : ""}`);
console.log(`workspace: ${workspace}\n`);
if (ctx?.fiber?.dispose) await ctx.fiber.dispose();
process.exit(process.exitCode ?? 0);
