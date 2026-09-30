/**
 * Board mode: storage invariants and coordination behaviour.
 *
 * The concurrency tests here encode the measurements that justify the
 * "append only, one write per line" protocol. They run real child processes,
 * because the guarantee comes from the OS, not from our code.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  boardPaths,
  appendEntries,
  readEntries,
  readBoard,
  parseBoard,
  topicCounts,
  authorCounts,
  writeDirection,
  writeState,
  readState,
  workspaceFiles,
  BOARD_FILENAME,
} from "../src/board-store.js";
import { buildBoardPrompt, loadBoardInstructions, runBoardAgent, boardSnapshot } from "../src/board-agent.js";
import { startBoard, resolveBoardSize, MAX_BOARD_AGENTS, renderBoard } from "../src/board-cluster.js";

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
};
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "board-"));
const PROMPTS = path.resolve("prompts");

console.log("\nappend-only storage");

t("an entry is one line and reads back whole", () => {
  const p = boardPaths(tmp(), "b");
  appendEntries(p, [{ author: "agent-0", topic: "x", body: "hello" }]);
  const rows = readEntries(p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, "hello");
  assert.equal(rows[0].author, "agent-0");
});

t("bodies with quotes, newlines and backslashes survive", () => {
  const p = boardPaths(tmp(), "b");
  const nasty = 'he said "hi"\nand \\ then\n\ttabbed — 中文 ✓';
  appendEntries(p, [{ author: "agent-1", topic: "x", body: nasty }]);
  assert.equal(readEntries(p)[0].body, nasty, "body must round-trip byte-for-byte");
});

t("appends accumulate; nothing is ever overwritten", () => {
  const p = boardPaths(tmp(), "b");
  for (let i = 0; i < 5; i++) appendEntries(p, [{ author: "a", topic: `t${i}`, body: `${i}` }]);
  const rows = readEntries(p);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.topic), ["t0", "t1", "t2", "t3", "t4"]);
});

t("entries carry a timestamp and default topic/author", () => {
  const p = boardPaths(tmp(), "b");
  appendEntries(p, [{ body: "bare" }]);
  const e = readEntries(p)[0];
  assert.ok(e.ts && !Number.isNaN(Date.parse(e.ts)), "ts must be a real timestamp");
  assert.equal(e.topic, "general");
  assert.equal(e.author, "unknown");
});

t("a torn final line is skipped, not fatal", () => {
  const p = boardPaths(tmp(), "b");
  appendEntries(p, [{ author: "a", topic: "ok", body: "complete" }]);
  fs.appendFileSync(p.board, '{"author":"b","topic":"half","bod', "utf8");
  const { entries, skipped, truncatedTail } = readBoard(p);
  assert.equal(entries.length, 1, "the complete entry still reads");
  assert.equal(skipped, 1, "the fragment is counted as skipped");
  assert.equal(truncatedTail, true, "a missing trailing newline marks an in-flight write");
});

t("a completely empty board reads as empty, not as an error", () => {
  const p = boardPaths(tmp(), "b");
  const r = readBoard(p);
  assert.deepEqual(r.entries, []);
  assert.equal(r.skipped, 0);
  assert.equal(r.truncatedTail, false);
});

t("blank lines are ignored", () => {
  const p = boardPaths(tmp(), "b");
  fs.writeFileSync(p.board, '\n\n{"author":"a","topic":"t","body":"b"}\n\n\n', "utf8");
  assert.equal(readEntries(p).length, 1);
});

t("a JSON array or scalar line is rejected, not accepted as an entry", () => {
  const p = boardPaths(tmp(), "b");
  fs.writeFileSync(p.board, '[1,2,3]\n"a string"\n42\n{"author":"a","topic":"t","body":"real"}\n', "utf8");
  const { entries, skipped } = readBoard(p);
  assert.equal(entries.length, 1);
  assert.equal(skipped, 3);
});

console.log("\nread-write concurrency (real processes)");

await ta("one write per line: concurrent appends never corrupt", async () => {
  const dir = tmp();
  const p = boardPaths(dir, "b");
  // Real concurrency: launch all writers at once and wait for the group.
  const script = `
import os, sys, json
tag, count, payload = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
body = "z" * payload
for i in range(count):
    line = json.dumps({"author": tag, "topic": "t", "body": body, "seq": i}) + "\\n"
    fd = os.open(sys.argv[4], os.O_WRONLY | os.O_APPEND | os.O_CREAT)
    os.write(fd, line.encode())
    os.close(fd)
`;
  const writers = 8, count = 200;
  const children = [];
  for (let i = 0; i < writers; i++) {
    children.push(
      new Promise((resolve, reject) => {
        const c = spawn("python3", ["-c", script, `agent-${i}`, String(count), "160", p.board], { stdio: "ignore" });
        c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${i} exited ${code}`))));
      }),
    );
  }
  await Promise.all(children);

  const { entries, skipped } = readBoard(p);
  assert.equal(skipped, 0, "no line may be corrupt when each writer issues one write per line");
  assert.equal(entries.length, writers * count, `expected ${writers * count} entries`);
  const byAuthor = new Map();
  for (const e of entries) byAuthor.set(e.author, (byAuthor.get(e.author) ?? 0) + 1);
  assert.equal(byAuthor.size, writers, "every writer's lines survive");
  for (const [a, n] of byAuthor) assert.equal(n, count, `${a} lost lines`);
});

await ta("split writes DO corrupt — the protocol is load-bearing, not superstition", async () => {
  const dir = tmp();
  const p = boardPaths(dir, "b");
  const script = `
import os, sys, json, time
tag, count = sys.argv[1], int(sys.argv[2])
for i in range(count):
    line = json.dumps({"author": tag, "topic": "t", "body": "z"*200, "seq": i}) + "\\n"
    fd = os.open(sys.argv[3], os.O_WRONLY | os.O_APPEND | os.O_CREAT)
    os.write(fd, line[:len(line)//2].encode())
    time.sleep(0.00005)
    os.write(fd, line[len(line)//2:].encode())
    os.close(fd)
`;
  const writers = 6, count = 50;
  const children = [];
  for (let i = 0; i < writers; i++) {
    children.push(
      new Promise((resolve) => {
        const c = spawn("python3", ["-c", script, `agent-${i}`, String(count), p.board], { stdio: "ignore" });
        c.on("exit", () => resolve());
      }),
    );
  }
  await Promise.all(children);

  const { skipped } = readBoard(p);
  assert.ok(
    skipped > 0,
    "splitting a line across writes must be shown to corrupt; if this passes with 0, " +
      "the environment's append semantics changed and the protocol note needs revisiting",
  );
  console.log(`      (measured: ${skipped} corrupted line(s) out of ${writers * count})`);
});

console.log("\nqueries");

await ta("topic and author histograms", async () => {
  const p = boardPaths(tmp(), "b");
  appendEntries(p, [
    { author: "agent-0", topic: "a" },
    { author: "agent-0", topic: "a" },
    { author: "agent-1", topic: "b" },
  ]);
  const rows = readEntries(p);
  assert.deepEqual(topicCounts(rows), [{ topic: "a", count: 2 }, { topic: "b", count: 1 }]);
  const au = authorCounts(rows);
  assert.deepEqual(au.map((x) => x.author), ["agent-0", "agent-1"]);
  assert.equal(au[0].count, 2);
});

await ta("workspace listing ignores dotfiles", async () => {
  const p = boardPaths(tmp(), "b");
  fs.writeFileSync(path.join(p.workspace, "a.md"), "x");
  fs.writeFileSync(path.join(p.workspace, ".hidden"), "x");
  assert.deepEqual(workspaceFiles(p), ["a.md"]);
});

console.log("\nthe prompt pushes NOTHING");

t("the prompt contains paths and instructions, never board content", () => {
  const p = boardPaths(tmp(), "b");
  appendEntries(p, [{ author: "agent-0", topic: "secret", body: "SECRET-BOARD-CONTENT" }]);
  const prompt = buildBoardPrompt({
    n: 1, boardId: "b", paths: p,
    direction: "do the thing",
    instructions: loadBoardInstructions(PROMPTS, { n: 1, paths: p }),
    turn: 0,
  });
  assert.match(prompt, /do the thing/, "direction is included");
  assert.match(prompt, /board\.ndjson/, "the board path is included");
  assert.ok(
    !prompt.includes("SECRET-BOARD-CONTENT"),
    "board content must NOT be pre-read into the prompt — the agent has to go and look",
  );
});

t("the instructions teach one-write-per-line and warn against splitting", () => {
  const text = loadBoardInstructions(PROMPTS);
  assert.match(text, /一次写完|one write/i, "must state the atomicity rule");
  assert.match(text, /交错|corrupt/i, "must warn what splitting does");
  assert.match(text, /printf|python3/i, "must give a concrete safe idiom");
  assert.match(text, /BOARD/, "must reference the shell variable");
});

t("no shell variable is promised that the host never sets", () => {
  const p2 = boardPaths(tmp(), "b");
  const text = loadBoardInstructions(PROMPTS, { n: 2, paths: p2 });
  assert.ok(!/\$BOARD|\$WORKSPACE/.test(text), "must not reference unset shell variables");
  assert.ok(text.includes(p2.board), "the real board path must appear literally");
  assert.ok(text.includes(p2.workspace), "the real workspace path must appear literally");
  assert.ok(text.includes("agent-2"), "the agent's own id must be filled in");
  assert.ok(!text.includes("{{"), "no placeholder may survive");
});

t("the prompt tells the agent it is responsible for deciding when to stop", () => {
  const text = loadBoardInstructions(PROMPTS);
  assert.match(text, /不会自动停止|no external (judge|stopping)/i);
});

console.log("\nboard cluster");

t("size is capped, and refusing beats silently clamping", () => {
  assert.equal(MAX_BOARD_AGENTS, 10);
  assert.equal(resolveBoardSize(3), 3);
  assert.equal(resolveBoardSize(10), 10);
  assert.throws(() => resolveBoardSize(11), /exceeds the maximum/);
  assert.throws(() => resolveBoardSize(0), /positive number/);
  assert.throws(() => resolveBoardSize("many"), /positive number/);
});

await ta("agents write to one shared board and can see each other's entries", async () => {
  const root = tmp();
  const ac = new AbortController();
  // A stand-in agent: reads the board, appends one entry, stops after 1 turn.
  const runner = async ({ agentIndex, paths }) => {
    const seen = readEntries(paths).map((e) => e.topic);
    appendEntries(paths, [{
      author: `agent-${agentIndex}`,
      topic: `from-${agentIndex}`,
      body: `I saw: ${seen.join(",") || "(empty)"}`,
    }]);
  };
  await startBoard({
    root, boardId: "shared", concurrency: 3,
    direction: "x", runner, signal: ac.signal,
    promptDir: PROMPTS, maxTurns: 1,
  });
  const snap = boardSnapshot(root, "shared");
  assert.equal(snap.entryCount, 3, "all three agents must have appended");
  const authors = snap.authors.map((a) => a.author).sort();
  assert.deepEqual(authors, ["agent-0", "agent-1", "agent-2"]);
  console.log(`      entries: ${snap.entries.map((e) => `${e.author}:${e.topic}`).join(", ")}`);
});

await ta("an agent that writes nothing is reported as silent", async () => {
  const root = tmp();
  const ac = new AbortController();
  const events = [];
  await startBoard({
    root, boardId: "quiet", concurrency: 1, direction: "x",
    runner: async () => {},  // does nothing at all
    signal: ac.signal, promptDir: PROMPTS, maxTurns: 1,
    onEvent: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.type === "silent"), "silence must be surfaced, not hidden");
  assert.equal(boardSnapshot(root, "quiet").entryCount, 0);
});

await ta("a `done` entry ends that agent", async () => {
  const root = tmp();
  const ac = new AbortController();
  let calls = 0;
  const runner = async ({ agentIndex, paths }) => {
    calls++;
    appendEntries(paths, [{ author: `agent-${agentIndex}`, topic: "done", body: "finished" }]);
  };
  const res = await startBoard({
    root, boardId: "done", concurrency: 2, direction: "x",
    runner, signal: ac.signal, promptDir: PROMPTS,
  });
  assert.equal(calls, 2, "each agent should stop after writing `done`");
});

await ta("a runner that throws is surfaced and does not kill the board", async () => {
  const root = tmp();
  const ac = new AbortController();
  const events = [];
  await startBoard({
    root, boardId: "boom", concurrency: 2, direction: "x",
    runner: async () => { throw new Error("provider unavailable"); },
    signal: ac.signal, promptDir: PROMPTS, maxTurns: 1,
    onEvent: (e) => events.push(e),
  });
  const errs = events.filter((e) => e.type === "error");
  assert.equal(errs.length, 2);
  assert.match(errs[0].error, /provider unavailable/);
});

await ta("carry-over: previous artifacts are archived, not read as current", async () => {
  const root = tmp();
  const ac = new AbortController();
  const p = boardPaths(root, "co");
  fs.writeFileSync(path.join(p.workspace, "stale.md"), "old");
  await startBoard({
    root, boardId: "co", concurrency: 1, direction: "x",
    runner: async () => {}, signal: ac.signal, promptDir: PROMPTS, maxTurns: 1,
  });
  assert.ok(!workspaceFiles(p).includes("stale.md"), "stale artifact must not survive");
  assert.ok(fs.readdirSync(path.join(p.base, "history")).some((f) => f.endsWith("stale.md")));
});

await ta("renderBoard shows topics, authors and the tail", async () => {
  const root = tmp();
  const ac = new AbortController();
  await startBoard({
    root, boardId: "r", concurrency: 2, direction: "x",
    runner: async ({ agentIndex, paths }) => {
      appendEntries(paths, [{ author: `agent-${agentIndex}`, topic: agentIndex === 0 ? "alpha" : "beta", body: "did work" }]);
    },
    signal: ac.signal, promptDir: PROMPTS, maxTurns: 1,
  });
  const text = renderBoard(boardSnapshot(root, "r"));
  assert.match(text, /alpha/);
  assert.match(text, /beta/);
  assert.match(text, /entries=2/);
});

console.log(`\n${pass} passed${process.exitCode ? " (with failures)" : ""}\n`);
