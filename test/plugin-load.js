/**
 * Integration test: the plugin actually registers against a DSH context.
 *
 * This loads `lib/index.js` with the REAL `@deepseek-ai/dsh-tools` and
 * `@deepseek-ai/schemastery` packages (symlinked into node_modules by
 * `npm run link-deps`), then calls `apply()` with a mock cordis context that
 * records what gets registered. It catches the class of failure that unit tests
 * cannot: a tool definition the real `defineTool` rejects, a wrong parameter
 * descriptor, or an `apply()` that throws before registering anything.
 *
 * Run: node test/plugin-load.js
 */
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

let pass = 0;
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
};

console.log("\nplugin module");

let mod;
await ta("lib/index.js imports with the real DSH packages", async () => {
  mod = await import(path.resolve("lib/index.js"));
  assert.equal(mod.name, "flock");
  assert.deepEqual(mod.inject, ["tools", "subagents", "agents", "systemPrompt"]);
  assert.equal(typeof mod.apply, "function");
  assert.equal(typeof mod.Config, "function");
});

await ta("Config validates and applies defaults", async () => {
  const cfg = new mod.Config({});
  assert.equal(cfg.root, ".flock");
  assert.equal(cfg.provider, "spawn");
  assert.equal(cfg.defaultAlgorithm, "amorphous");
  assert.equal(cfg.maxAgents, 10);
});

console.log("\nroot resolution (the /.flock bug)");

await ta("a relative root resolves against the SESSION workspace, not process.cwd()", async () => {
  // Shipped bug: root was resolved with path.resolve(process.cwd(), ".flock").
  // A web daemon is launched from "/", so every cluster path became /.flock/...
  // and mkdir died with EACCES on a read-only root.
  const { resolveRoot } = mod;
  const agent = { session: { header: { cwd: "/Users/someone/project" } } };
  assert.equal(resolveRoot({ root: ".flock" }, agent), "/Users/someone/project/.flock");
});

await ta("an absolute root is used verbatim", async () => {
  const { resolveRoot } = mod;
  assert.equal(resolveRoot({ root: "/tmp/pinned" }, null), "/tmp/pinned");
  assert.equal(
    resolveRoot({ root: "/tmp/pinned" }, { session: { header: { cwd: "/elsewhere" } } }),
    "/tmp/pinned",
    "an absolute root must not be re-anchored",
  );
});

await ta("a session with no cwd is refused rather than silently mis-resolved", async () => {
  const { resolveRoot } = mod;
  assert.throws(() => resolveRoot({ root: ".flock" }, undefined), /no cwd/);
  assert.throws(() => resolveRoot({ root: ".flock" }, { session: { header: {} } }), /no cwd/);
});

await ta("process.cwd() is never consulted for a relative root", async () => {
  const { resolveRoot } = mod;
  const before = process.cwd();
  const got = resolveRoot({ root: ".flock" }, { session: { header: { cwd: "/tmp/ws" } } });
  assert.equal(got, "/tmp/ws/.flock");
  assert.notEqual(got, path.resolve(before, ".flock"), "must not fall back to the process cwd");
});

console.log("\napply() against a mock host context");

/** A minimal stand-in for the cordis context the host passes to a plugin. */
function mockCtx() {
  const tools = new Map();
  const sections = [];
  return {
    tools: {
      register(tool) {
        assert.ok(tool.name, "a registered tool must have a name");
        tools.set(tool.name, tool);
      },
    },
    systemPrompt: {
      section(s) { sections.push(s); },
    },
    subagents: {
      list: () => ["spawn", "fork"],
      getProvider: (n) => (n === "spawn" ? { name: "spawn", capabilities: { persona: true, toolFilter: true } } : undefined),
      startContinuable: async () => ({ childId: "child-1", messageId: "m-1" }),
      listChildren: async () => [],
      listDescendants: async () => [],
    },
    agents: {},
    logger: { debug() {}, warn() {}, info() {} },
    _tools: tools,
    _sections: sections,
  };
}

await ta("registers the cluster and board tools", async () => {
  const ctx = mockCtx();
  mod.apply(ctx, new mod.Config({}));
  assert.deepEqual([...ctx._tools.keys()].sort(), [
    "board_direct", "board_run", "board_status",
    "flock_direct", "flock_run", "flock_status",
  ]);
});

await ta("board_run's description contrasts it with flock_run", async () => {
  const ctx = mockCtx();
  mod.apply(ctx, new mod.Config({}));
  const d = ctx._tools.get("board_run").description;
  assert.match(d, /blackboard|append-only/i);
  assert.match(d, /flock_run/, "must say how it differs from the snapshot mode");
  assert.match(d, /Do NOT|Not suited/i, "a pattern tool must document its bad-fit cases");
});

await ta("registers a system-prompt usage section", async () => {
  const ctx = mockCtx();
  mod.apply(ctx, new mod.Config({}));
  assert.equal(ctx._sections.length, 1);
  assert.match(ctx._sections[0].text, /self-organizing/i);
  assert.match(ctx._sections[0].text, /no orchestrator|no assigned roles/i);
});

await ta("flock_run's description tells the model when NOT to use it", async () => {
  const ctx = mockCtx();
  mod.apply(ctx, new mod.Config({}));
  const d = ctx._tools.get("flock_run").description;
  assert.match(d, /no orchestrator/i);
  assert.match(d, /Do NOT use it/i, "a pattern tool must document its bad-fit cases");
  assert.match(d, /depend on each other in a fixed order/i);
});

await ta("tool parameters compile to JSON Schema with the right required fields", async () => {
  const ctx = mockCtx();
  mod.apply(ctx, new mod.Config({}));
  // defineTool normalizes the authored descriptor into JSON Schema: an
  // object-typed `parameters` with a `required` array, not per-field flags.
  const run = ctx._tools.get("flock_run").parameters;
  assert.equal(run.type, "object");
  assert.deepEqual(run.required, ["direction"], "direction is the only required input");
  assert.ok(run.properties.agents, "optional knobs must still be declared");
  assert.ok(run.properties.maxRuntimeSeconds);

  const st = ctx._tools.get("flock_status").parameters;
  assert.deepEqual([...st.required].sort(), ["agents", "cluster"]);

  const direct = ctx._tools.get("flock_direct").parameters;
  assert.deepEqual([...direct.required].sort(), ["agents", "cluster"]);
  assert.ok(direct.properties.algorithm && direct.properties.direction && direct.properties.state);
});

await ta("flock_direct rejects an unknown algorithm before touching disk", async () => {
  const ctx = mockCtx();
  mod.apply(ctx, new mod.Config({}));
  const direct = ctx._tools.get("flock_direct");
  await assert.rejects(
    () => direct.execute(
      { cluster: "x", agents: 2, algorithm: "not-a-thing" },
      { agent: { session: { header: { cwd: "/tmp/ws" } } } },
    ),
    /unknown algorithm/,
  );
});

await ta("flock_direct rejects an unknown lifecycle state", async () => {
  const ctx = mockCtx();
  mod.apply(ctx, new mod.Config({}));
  const direct = ctx._tools.get("flock_direct");
  await assert.rejects(
    () => direct.execute(
      { cluster: "x", agents: 2, state: "explode" },
      { agent: { session: { header: { cwd: "/tmp/ws" } } } },
    ),
    /unknown state/,
  );
});

await ta("flock_run fails clearly when the provider is missing", async () => {
  const ctx = mockCtx();
  ctx.subagents.getProvider = () => undefined;
  mod.apply(ctx, new mod.Config({ provider: "nope" }));
  const run = ctx._tools.get("flock_run");
  await assert.rejects(
    () => run.execute({ direction: "x" }, { agent: {}, signal: new AbortController().signal }),
    /not registered/,
  );
});

await ta("flock_run requires a calling agent", async () => {
  const ctx = mockCtx();
  mod.apply(ctx, new mod.Config({}));
  const run = ctx._tools.get("flock_run");
  await assert.rejects(() => run.execute({ direction: "x" }, {}), /requires a calling agent/);
});

console.log(`\n${pass} passed${process.exitCode ? " (with failures)" : ""}\n`);
