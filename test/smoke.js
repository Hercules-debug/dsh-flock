/**
 * Coordination invariants for the DSH plugin.
 *
 * The runner is injected: these tests exercise the coordination machinery
 * without standing up the host runtime. A fake runner plays the part of a real
 * DSH agent by *writing files and appending log lines itself*, which is exactly
 * what the real subagent does — so the loop is tested against the real
 * contract, not a convenience shim.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { amorphousNeighbours, meshNeighbours, convergenceEstimate, selectNeighbours, clampRadius } from "../src/neighbours.js";
import { clusterPaths, tailLog, readState, writeConfig, writeDirection, writeState, readLog } from "../src/store.js";
import { runAgent, isIdleAction, buildPrompt } from "../src/agent.js";
import { startCluster, snapshot, withConcurrencyLimit } from "../src/cluster.js";
import { newestArtifact, personaFor } from "../src/subagent-runner.js";
import { safeClusterId } from "../src/ids.js";

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
};
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "flock-"));
const PROMPTS = path.resolve("prompts");

/**
 * A stand-in for a real DSH agent: it uses its "tools" (node fs, here) to write
 * an artifact and append its own log line. The loop must never synthesize
 * either of those for it.
 */
function agentLikeRunner({ angles = [], contributions = 2 } = {}) {
  const done = new Map();
  return async ({ agentIndex, iteration, paths, clusterId }) => {
    const n = done.get(agentIndex) ?? 0;
    if (n >= contributions || angles.length === 0) {
      fs.appendFileSync(
        paths.logOf(agentIndex),
        JSON.stringify({
          iteration,
          action: "idle",
          result: "coverage complete across visible neighbours",
          next_intent: "remain idle unless the direction changes",
        }) + "\n",
      );
      return;
    }
    const angle = angles[(agentIndex + n * 3) % angles.length];
    const file = path.join(paths.env, `${angle}-agent${agentIndex}.md`);
    fs.writeFileSync(file, `# ${angle}\n\nReal bytes written by agent ${agentIndex}.\n`);
    fs.appendFileSync(
      paths.logOf(agentIndex),
      JSON.stringify({
        iteration,
        action: `wrote ${angle}`,
        result: `produced ${path.basename(file)}`,
        next_intent: "read neighbours",
      }) + "\n",
    );
    done.set(agentIndex, n + 1);
  };
}

console.log("\nneighbour selection (differential-tested elsewhere)");
t("amorphous radius 1 on a ring of 8 gives 2 neighbours", () => {
  assert.deepEqual(amorphousNeighbours(0, 8, 1), [1, 7]);
});
t("per-agent cost stays constant as N grows", () => {
  assert.equal(amorphousNeighbours(0, 8, 2).length, 4);
  assert.equal(amorphousNeighbours(0, 8000, 2).length, 4);
});
t("mesh sees everyone but self", () => {
  assert.equal(meshNeighbours(3, 6).length, 5);
});
t("clampRadius blocks the upstream R>=N underflow", () => {
  assert.equal(clampRadius(2, 3), 1);
  assert.equal(clampRadius(8, 99), 7);
});
t("selectNeighbours never returns a negative index", () => {
  for (const c of [2, 3, 5]) {
    for (let i = 0; i < c; i++) {
      const ns = selectNeighbours({ algorithm: "amorphous", agentIndex: i, concurrency: c, radius: 99, swarmK: 2, paths: {} });
      assert.ok(ns.every((x) => x >= 0 && x < c), `N=${c} agent=${i} -> [${ns}]`);
    }
  }
});
t("convergence math matches the AWS post", () => {
  assert.equal(convergenceEstimate(100, 2).propagation, 25);
  assert.equal(convergenceEstimate(1000, 4).propagation, 125);
});

console.log("\nidle detection");
t("recognises the ways models actually write idle", () => {
  for (const a of ["idle", "Idle", " idle ", "idle — both neighbours converged"]) {
    assert.equal(isIdleAction(a), true, `should be idle: ${JSON.stringify(a)}`);
  }
  for (const a of ["write notes", "", null, undefined, "idling"]) {
    assert.equal(isIdleAction(a), false, `should not be idle: ${JSON.stringify(a)}`);
  }
});

console.log("\ncluster id safety");
t("cluster ids cannot escape the flock root", () => {
  assert.equal(safeClusterId("../../etc/passwd"), "etc-passwd");
  assert.equal(safeClusterId("/abs/path"), "abs-path");
  assert.equal(safeClusterId(""), "cluster");
  assert.equal(safeClusterId("My Cluster!"), "my-cluster");
  for (const bad of ["../x", "/etc", "..", "a/b"]) {
    const got = safeClusterId(bad);
    assert.ok(!got.includes("/") && !got.includes(".."), `escaped: ${bad} -> ${got}`);
  }
});

console.log("\nartifact inspection");
await ta("newestArtifact finds what an agent actually wrote", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "old.md"), "old");
  await new Promise((r) => setTimeout(r, 20));
  const cutoff = Date.now();
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(dir, "new.md"), "fresh bytes");
  const found = newestArtifact(dir, cutoff);
  assert.equal(found.name, "new.md");
  assert.equal(found.bytes, "fresh bytes".length);
});
await ta("newestArtifact returns null when nothing was written", async () => {
  assert.equal(newestArtifact(tmp(), Date.now()), null);
});

console.log("\nthe loop reads back from disk, it does not trust a return value");
await ta("an agent that writes its own log line is recorded", async () => {
  const root = tmp();
  const ac = new AbortController();
  await startCluster({
    root, clusterId: "c", concurrency: 2, direction: "x",
    config: { algorithm: "mesh", neighbourRadius: 1, swarmK: 2, autopause: true },
    runner: agentLikeRunner({ angles: ["alpha", "beta"] }),
    signal: ac.signal, promptDir: PROMPTS, maxIterations: 2, staggerMs: 0, maxInflight: 2,
  });
  const snap = snapshot(root, "c", 2);
  assert.equal(snap.reported, 2, "both agents must have appended a log line");
  assert.ok(snap.artifacts.length >= 2, `expected artifacts, got ${snap.artifacts}`);
});

await ta("an agent that claims work but writes nothing is NOT recorded as progress", async () => {
  // This is the defect that made the first port's blackboard empty: the agent
  // narrated a file that never existed. Now the loop inspects the disk, so the
  // claim cannot enter the log.
  const root = tmp();
  const ac = new AbortController();
  const events = [];
  await startCluster({
    root, clusterId: "liar", concurrency: 1, direction: "x",
    config: { algorithm: "mesh", neighbourRadius: 1, swarmK: 2, autopause: false },
    runner: async () => { /* does nothing at all, like an agent with no tools */ },
    signal: ac.signal, promptDir: PROMPTS, maxIterations: 1, staggerMs: 0,
    onEvent: (e) => events.push(e),
  });
  const p = clusterPaths(root, "liar", 1);
  assert.equal(readLog(p, 0).length, 0, "no log line may be synthesized for a passive agent");
  assert.ok(events.some((e) => e.type === "no-log-line"), "the silence must be surfaced as an event");
  assert.equal(snapshot(root, "liar", 1).artifacts.length, 0);
});

await ta("a runner that throws is surfaced, not swallowed", async () => {
  const root = tmp();
  const ac = new AbortController();
  const events = [];
  await startCluster({
    root, clusterId: "boom", concurrency: 1, direction: "x",
    config: { algorithm: "mesh", neighbourRadius: 1, swarmK: 2, autopause: false },
    runner: async () => { throw new Error("provider unavailable"); },
    signal: ac.signal, promptDir: PROMPTS, maxIterations: 1, staggerMs: 0,
    onEvent: (e) => events.push(e),
  });
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "the dispatch failure must be reported");
  assert.match(err.error, /provider unavailable/);
});

console.log("\nconvergence and termination");
await ta("cluster converges and parks itself without an abort", async () => {
  const root = tmp();
  const ac = new AbortController();
  const angles = ["a", "b", "c", "d", "e"];
  const done = await Promise.race([
    startCluster({
      root, clusterId: "conv", concurrency: 4, direction: "x",
      config: { algorithm: "mesh", neighbourRadius: 1, swarmK: 2, autopause: true },
      runner: agentLikeRunner({ angles, contributions: 1 }),
      signal: ac.signal, promptDir: PROMPTS, staggerMs: 0, maxInflight: 2,
    }).then(() => "finished"),
    new Promise((r) => setTimeout(() => r("hung"), 8000)),
  ]);
  assert.equal(done, "finished", "cluster must terminate on its own");
  const snap = snapshot(root, "conv", 4);
  assert.equal(snap.idle, 4, `all agents should end idle, got ${snap.idle}`);
  assert.equal(snap.state, "paused");
});

await ta("--max-iterations caps a runner that never stops", async () => {
  const root = tmp();
  const ac = new AbortController();
  let calls = 0;
  await startCluster({
    root, clusterId: "cap", concurrency: 3, direction: "x",
    config: { algorithm: "mesh", neighbourRadius: 1, swarmK: 2, autopause: false },
    runner: async () => { calls++; },
    signal: ac.signal, promptDir: PROMPTS, maxIterations: 2, staggerMs: 0, maxInflight: 3,
  });
  assert.ok(calls <= 6, `expected <= 6 dispatches, got ${calls}`);
});

await ta("carry-over control: previous artifacts are archived", async () => {
  const root = tmp();
  const ac = new AbortController();
  const p = clusterPaths(root, "co", 1);
  fs.writeFileSync(path.join(p.env, "stale.md"), "old");
  await startCluster({
    root, clusterId: "co", concurrency: 1, direction: "x",
    config: { algorithm: "mesh", neighbourRadius: 1, swarmK: 2, autopause: true },
    runner: agentLikeRunner({ angles: [] }),
    signal: ac.signal, promptDir: PROMPTS, maxIterations: 1, staggerMs: 0,
  });
  assert.ok(!fs.readdirSync(p.env).includes("stale.md"), "stale artifact must not survive");
  assert.ok(fs.readdirSync(path.join(p.base, "history")).some((f) => f.endsWith("stale.md")));
});

console.log("\nconcurrency limiting");
await ta("in-flight dispatches are bounded", async () => {
  let inflight = 0, peak = 0;
  const limited = withConcurrencyLimit(async () => {
    inflight++; peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 15));
    inflight--;
  }, 2);
  await Promise.all(Array.from({ length: 12 }, () => limited({})));
  assert.ok(peak <= 2, `peak was ${peak}`);
  assert.equal(peak, 2, "should use the full allowance");
});

console.log("\nprompt construction");
t("the prompt tells the agent to write a file and append its own log line", () => {
  const paths = { direction: "/d/direction.md", logOf: (n) => `/d/store/agent-${n}.ndjson`, env: "/d/environment" };
  const p = buildPrompt({
    n: 1, clusterId: "c", paths, neighbours: [0, 2], algorithm: "mesh",
    direction: "survey it", neighbourTails: { 0: { iteration: 0, action: "wrote x", result: "made x.md", next_intent: "read" }, 2: null },
    directive: null, loopInstructions: "LOOP", algorithmFragment: "ALGO",
  });
  assert.match(p, /write it into your environment dir/i);
  assert.match(p, /do not merely describe one/i);
  assert.match(p, /RUN it and fix it/i, "agents must be told to execute, since they now can");
  assert.match(p, /agent-0\.ndjson/);
  assert.match(p, /agent-0.*iteration 0.*wrote x/s);
});

t("persona states there is no orchestrator", () => {
  const s = personaFor("c", 2);
  assert.match(s, /no orchestrator/i);
  assert.match(s, /shared log on disk/i);
});

console.log(`\n${pass} passed${process.exitCode ? " (with failures)" : ""}\n`);
