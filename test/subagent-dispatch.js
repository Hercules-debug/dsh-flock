/**
 * Tests for the DSH-subagent dispatch path.
 *
 * In production `createSubagentRunner` calls `ctx.subagents.startContinuable()`
 * and gets back a real child agent with the host's full tool set. That cannot
 * run in this sandbox (installing into a profile needs write access outside the
 * workspace), so this suite drives the runner against a mock that enforces the
 * same contract shape: provider capabilities are checked, the spec's fields are
 * required, and the returned child id is what we wait on.
 *
 * What this DOES prove: our call conforms to the documented API and our error
 * paths fire correctly. What it does NOT prove: that a real agent turn produces
 * a useful artifact — that needs a live profile.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubagentRunner, newestArtifact, personaFor } from "../src/subagent-runner.js";

let pass = 0;
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
};

/** A mock host that validates the spec exactly as the real service documents. */
function mockHost({ capabilities = { persona: true, toolFilter: true }, childStates = [] } = {}) {
  const calls = [];
  let stateIdx = 0;
  return {
    calls,
    logger: { debug() {} },
    subagents: {
      list: () => ["spawn"],
      getProvider: (n) =>
        n === "spawn" ? { name: "spawn", capabilities, inheritsParentContext: false } : undefined,
      startContinuable: async (spec) => {
        // The real service requires these; assert them so a malformed call fails here.
        assert.equal(typeof spec.provider, "string");
        assert.equal(typeof spec.label, "string");
        assert.ok(spec.request, "spec.request is required");
        assert.ok(Array.isArray(spec.request.prompt), "request.prompt must be a content-block array");
        assert.equal(spec.request.prompt[0].type, "text");
        assert.ok(spec.request.parent, "request.parent (the authorizing agent) is required");
        calls.push(spec);
        return { childId: `child-${calls.length}`, messageId: `m-${calls.length}` };
      },
      // A real host lists the child it knows about; the mock advances through
      // a scripted state sequence and then holds the final value, the way a
      // settled child stays settled.
      listChildren: async () => (childStates.length
        ? [{ sessionId: "child-1", state: childStates[Math.min(stateIdx++, childStates.length - 1)] }]
        : []),
      listDescendants: async () => [],
    },
  };
}

console.log("\nsubagent dispatch");

await ta("dispatches one turn through startContinuable with the documented spec", async () => {
  const ctx = mockHost();
  const runner = createSubagentRunner({ ctx, captain: { id: "captain" }, provider: "spawn", settleGraceMs: 50 });
  await runner({ prompt: "do the thing", agentIndex: 2, clusterId: "c", iteration: 0 });
  assert.equal(ctx.calls.length, 1);
  const spec = ctx.calls[0];
  assert.equal(spec.provider, "spawn");
  assert.equal(spec.label, "flock:c:agent-2:it-0");
  assert.match(spec.request.prompt[0].text, /do the thing/);
  assert.deepEqual(spec.request.parent, { id: "captain" });
});

await ta("applies a persona so the agent knows it has no orchestrator", async () => {
  const ctx = mockHost();
  const runner = createSubagentRunner({ ctx, captain: { id: "c" }, provider: "spawn", settleGraceMs: 50 });
  await runner({ prompt: "x", agentIndex: 0, clusterId: "cl", iteration: 1 });
  const persona = ctx.calls[0].request.persona;
  assert.ok(persona, "persona must be set — it is how the agent learns it is one of a cluster");
  assert.match(persona, /no orchestrator/i);
  assert.match(persona, /shared log on disk/i);
  assert.match(persona, /agent-0/);
});

await ta("passes agentOptions only when a route override is configured", async () => {
  const ctx = mockHost();
  const plain = createSubagentRunner({ ctx, captain: { id: "c" }, provider: "spawn", settleGraceMs: 50 });
  await plain({ prompt: "x", agentIndex: 0, clusterId: "c", iteration: 0 });
  assert.equal(ctx.calls[0].request.agentOptions, undefined, "no override means inherit the parent route");

  const ctx2 = mockHost();
  const routed = createSubagentRunner({
    ctx: ctx2, captain: { id: "c" }, provider: "spawn", settleGraceMs: 50,
    agentOptions: { provider: "workbuddy", model: "cn:hy3-b" },
  });
  await routed({ prompt: "x", agentIndex: 0, clusterId: "c", iteration: 0 });
  assert.deepEqual(ctx2.calls[0].request.agentOptions, { provider: "workbuddy", model: "cn:hy3-b" });
});

await ta("fails loudly when the provider is not registered, listing what is", async () => {
  const ctx = mockHost();
  assert.throws(
    () => createSubagentRunner({ ctx, captain: { id: "c" }, provider: "ghost" }),
    (e) => /not registered/.test(e.message) && /spawn/.test(e.message),
  );
});

await ta("refuses a provider that cannot apply a persona", async () => {
  const ctx = mockHost({ capabilities: { persona: false } });
  assert.throws(
    () => createSubagentRunner({ ctx, captain: { id: "c" }, provider: "spawn" }),
    /cannot apply a persona/,
  );
});

await ta("waits for the child to go idle before returning", async () => {
  const ctx = mockHost({ childStates: ["running", "running", "idle"] });
  const runner = createSubagentRunner({ ctx, captain: { id: "c" }, provider: "spawn", settleGraceMs: 50 });
  const out = await runner({ prompt: "x", agentIndex: 0, clusterId: "c", iteration: 0 });
  assert.equal(out.settled, true);
  assert.equal(out.childId, "child-1");
});

await ta("a host that cannot list children does not hang the cluster", async () => {
  // Older hosts may not expose listing; the runner must degrade, not deadlock.
  const ctx = mockHost();
  ctx.subagents.listDescendants = async () => { throw new Error("unsupported"); };
  ctx.subagents.listChildren = async () => { throw new Error("unsupported"); };
  const runner = createSubagentRunner({ ctx, captain: { id: "c" }, provider: "spawn", settleGraceMs: 50 });
  const out = await Promise.race([
    runner({ prompt: "x", agentIndex: 0, clusterId: "c", iteration: 0 }).then(() => "returned"),
    new Promise((r) => setTimeout(() => r("hung"), 3000)),
  ]);
  assert.equal(out, "returned");
});

console.log("\nartifact inspection");

await ta("personaFor names the agent and the cluster", async () => {
  const s = personaFor("mycluster", 7);
  assert.match(s, /agent-7/);
  assert.match(s, /mycluster/);
});

await ta("newestArtifact ignores entries older than the turn's start", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "art-"));
  fs.writeFileSync(path.join(dir, "old.md"), "old");
  await new Promise((r) => setTimeout(r, 15));
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 15));
  fs.writeFileSync(path.join(dir, "new.md"), "new");
  assert.equal(newestArtifact(dir, start).name, "new.md");
  assert.equal(newestArtifact(dir).name, "new.md", "without a cutoff, newest wins");
  assert.equal(newestArtifact(dir).bytes, 3, "reports the artifact's size");
});

console.log(`\n${pass} passed${process.exitCode ? " (with failures)" : ""}\n`);
