/**
 * Differential test: my port vs the AWS original.
 *
 * The reference functions in `aws-ref.cjs` are extracted verbatim from
 * `aws-samples/sample-kiro-flock/kiro-flock-cluster/agent/neighbourSelector.ts`.
 * This test executes BOTH implementations over a wide input space and asserts
 * identical output. That is a far stronger claim than hand-written expected
 * values: it proves the port matches the thing it claims to port.
 *
 * Run: node test/diff/topology-diff.js
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { amorphousNeighbours, meshNeighbours } from "../../src/neighbours.js";

const require = createRequire(import.meta.url);
const aws = require("./aws-ref.cjs");

let cases = 0;
let failures = 0;

const compare = (label, mine, theirs, inputs) => {
  cases++;
  try {
    assert.deepEqual(mine, theirs);
  } catch {
    failures++;
    console.error(`  ✗ ${label}(${inputs.join(", ")})`);
    console.error(`      mine:  [${mine}]`);
    console.error(`      aws:   [${theirs}]`);
  }
};

console.log("\namorphous — 逐输入对拍 AWS 原码");
const concurrencies = [1, 2, 3, 4, 5, 8, 16, 32, 64, 100, 256, 1000];
const radii = [0, 1, 2, 3, 5, 10, 50];
for (const c of concurrencies) {
  for (const r of radii) {
    for (let i = 0; i < Math.min(c, 24); i++) {
      compare(
        "amorphousNeighbours",
        amorphousNeighbours(i, c, r),
        aws.amorphousNeighbours(i, c, r),
        [i, c, r],
      );
    }
  }
}
console.log(`  对拍 ${cases} 组输入`);

console.log("\nmesh — 逐输入对拍 AWS 原码");
const before = cases;
for (const c of concurrencies) {
  for (let i = 0; i < Math.min(c, 24); i++) {
    compare("meshNeighbours", meshNeighbours(i, c), aws.meshNeighbours(i, c), [i, c]);
  }
}
console.log(`  对拍 ${cases - before} 组输入`);

// --- structural properties the AWS source guarantees ----------------------
console.log("\n结构性质（AWS 源码隐含的契约）");
const props = [];
const check = (name, fn) => {
  try { fn(); props.push(`  ✓ ${name}`); }
  catch (e) { failures++; props.push(`  ✗ ${name}\n      ${e.message}`); }
};

check("amorphous 邻居数不超过 N-1（R 不超过环长时）", () => {
  // The bound is NOT min(2R, N-1) in general — see the upstream bug below.
  // Restricted to the documented range (R small relative to N), 2R neighbours
  // are returned and the count is capped by the ring size.
  for (const c of [5, 8, 100, 256]) {
    for (const r of [1, 2, 3]) {
      const got = amorphousNeighbours(0, c, r).length;
      assert.ok(got <= c - 1, `N=${c} R=${r}: got ${got}, must not exceed N-1`);
      if (2 * r <= c - 1) {
        assert.equal(got, 2 * r, `N=${c} R=${r}: expected full ${2 * r} neighbours`);
      }
    }
  }
});

check("[已知上游 bug] R >= N 时 AWS 原码会产出负索引，本移植同样复现", () => {
  // Upstream: kiro-flock-cluster/agent/neighbourSelector.ts, amorphousNeighbours.
  //
  //   neighbours.push((agentIndex - d + concurrency) % concurrency);
  //
  // When d >= concurrency the subtraction goes below -concurrency and becomes
  // negative, so the modulo yields a negative index: N=2, R=3 -> [-1, 1].
  // A negative index would address the wrong agent's log (object key
  // `agent--1.ndjson`) or miss entirely.
  //
  // This port reproduces the behaviour exactly rather than silently diverging,
  // so the differential test stays honest. The guard is at the call site:
  // radius is operator-supplied and the docs specify small radii. Both
  // implementations are asserted equal here, so if upstream ever fixes it the
  // differential run will flag the divergence and we can follow.
  const mine = amorphousNeighbours(0, 2, 3);
  const theirs = aws.amorphousNeighbours(0, 2, 3);
  assert.deepEqual(mine, theirs, "port must match upstream, bug included");
  assert.ok(
    theirs.some((i) => i < 0),
    "expected upstream to produce a negative index at R >= N (if this fails, upstream fixed it)",
  );
  console.log("      ↑ 已确认：上游在 R>=N 时产出负索引，移植保持一致");
});

check("amorphous 每 agent 成本不随 N 增长（有界可见性）", () => {
  assert.equal(amorphousNeighbours(0, 8, 2).length, 4);
  assert.equal(amorphousNeighbours(0, 8000, 2).length, 4);
});

check("amorphous 恒不包含自己", () => {
  for (const c of [3, 8, 64]) {
    for (let i = 0; i < c; i++) {
      assert.ok(!amorphousNeighbours(i, c, 1).includes(i));
    }
  }
});

check("amorphous concurrency=1 时无邻居", () => {
  assert.deepEqual(amorphousNeighbours(0, 1, 1), []);
});

check("amorphous radius=0 时无邻居", () => {
  assert.deepEqual(amorphousNeighbours(0, 8, 0), []);
});

check("mesh 恒为 N-1 个且不含自己", () => {
  for (const c of [2, 5, 32]) {
    const m = meshNeighbours(0, c);
    assert.equal(m.length, c - 1);
    assert.ok(!m.includes(0));
  }
});

check("amorphous 输出有序且无重复", () => {
  for (const c of [8, 40]) {
    for (let i = 0; i < c; i++) {
      const ns = amorphousNeighbours(i, c, 3);
      assert.deepEqual(ns, [...new Set(ns)].sort((a, b) => a - b));
    }
  }
});

console.log(props.join("\n"));

console.log(`\n对拍 ${cases} 组输入，失败 ${failures} 组`);
if (failures > 0) {
  console.error("\n差分测试未通过：移植与 AWS 原码不一致\n");
  process.exit(1);
}
console.log("移植与 AWS 原码逐输入一致 ✓\n");
