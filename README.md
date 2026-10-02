# dsh-flock

Self-organizing multi-agent clusters for **DeepSeek Harness**: N real DSH
agents coordinating through a shared append-only log with **no orchestrator**.

You write one direction file. Nobody assigns tasks, no roles are declared, no
dependency graph is built. The agents decide for themselves what to do, build on
and criticise each other's artifacts, and converge by all going idle.

## Two coordination modes — use the blackboard

The plugin ships two. **Start with `board_run`**; reach for `flock_run` only when
you specifically want a fixed peer set and an automatic convergence rule.

They differ in exactly one thing: **who decides what an agent knows about its
peers.**

| | `board_run` — blackboard *(recommended)* | `flock_run` — snapshot cluster |
|---|---|---|
| What the prompt contains | **nothing** — just a path and a shell idiom | the harness reads each neighbour's last log line and **bakes it in** |
| When an agent reads peers | whenever it likes, as often as it likes | once, at wake-up; the view never refreshes |
| Topology | none — it is one log, and `grep` is the filter | ring / mesh / swarm, chosen by you |
| Who decides to stop | the agent, and it is dispatched only once | the harness, on an `idle` handshake |
| Rounds | none | repeated until every visible agent reports idle |

**Why the blackboard is the better default.** An agent is a function call, so
"read what my peers did" should be a call it can make whenever it wants — not a
snapshot someone hands it once and then freezes. In practice the snapshot mode's
convergence rule is also its weak point: it depends on agents volunteering that
they are idle, and in every run we measured they never did, so the cluster had to
be stopped by hand. The blackboard has no such rule to satisfy.

**Use the snapshot mode when** you want a bounded, predictable peer set (an
amorphous ring gives each agent a fixed slice of the cluster, so per-agent
context stays constant as N grows) and you are happy for the harness to decide
when the work is done. It is also the closer port of the AWS original, which is
what makes the differential test against upstream meaningful.

### Try it

```
board_run(
  direction: "Survey the failure modes of log-based agent coordination.",
  agents: 4
)
```

Then `board_status(board: "...")` to read what they wrote.

This is a port of [`aws-samples/sample-kiro-flock`](https://github.com/aws-samples/sample-kiro-flock).
The AWS original runs headless Kiro CLI sessions on EC2 against an S3 bucket;
here the agents are **DSH subagents** and the coordination plane is a directory.
The blackboard mode is the deviation: AWS coordinates by having every agent read
its neighbours' logs on a timer, which works because their agents are cheap
short-lived CLI calls. A DSH agent is minutes long, so the same design produced
snapshots that were stale by the time an agent acted, and a convergence rule that
never fired. Giving the agent its own read/write tools instead is what this port
adds.

```
EC2 instances + S3 bucket   ->  DSH subagents + a directory
headless Kiro CLI session   ->  ctx.subagents.startContinuable()
timer-driven neighbour read ->  agent-driven blackboard read/write
systemd reap                ->  one dispatch per agent
```

## Why subagents, not a model call

An earlier version of this port called a bare `/chat/completions` endpoint. Each
agent was a single model turn with **no tools**, so it could only *narrate* work
it never performed: it would log `Wrote environment/foo.md` while `environment/`
stayed empty. The blackboard had messages and no content.

Dispatching through `ctx.subagents.startContinuable()` fixes that at the root.
Each agent is a genuine DSH child agent with the host's full tool set, its own
session, and its own system prompt. It writes its own artifact, and **because it
has bash, it can run what it wrote and fix it**. Artifacts are real; a produced
script has been executed, not merely described.

The loop never synthesizes a log line on the agent's behalf. It inspects the
disk to see what actually appeared — so "the agent produced nothing" is an
observable outcome rather than an unverifiable claim.

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-flock
# then restart the profile's harness process and refresh the browser
```

The bundle patch (`cordis.patch.yml`) mounts the plugin into the profile's host
composition. It registers six tools into the shared tool registry and one usage
section into the global system prompt.

## Use

Any session in that profile can start a cluster in natural language ("start a
board of 4 agents to review this codebase"), or call the tools directly.

| Tool | Purpose |
|---|---|
| **`board_run`** | **Start a blackboard cluster.** Agents get a log path and decide for themselves when to read and write. |
| **`board_status`** | Read a board: entry count, topics, authors, recent entries, files. |
| **`board_direct`** | Replace a board's direction, or pause/stop it. |
| `flock_run` | Start a snapshot cluster from one direction. Blocks until it converges or hits its deadline. |
| `flock_status` | Inspect a cluster: state, each agent's last log line, artifacts on disk. |
| `flock_direct` | Steer a live cluster: switch algorithm, rewrite the direction, pause/stop. |

```
board_run(
  direction: "Survey the failure modes of log-based agent coordination.",
  agents: 4
)
```

`direction` states **what to achieve**, not how to decompose it — the split is
the agents' decision, and prescribing it defeats the point.

**When to use it.** Work that splits into many quasi-independent contributions,
where the agents are better placed than you are to decide what needs doing and
when to talk about it.

**When not to.** A known task tree with strict ordering, or work that needs a
verification gate between steps — a normal delegation is better there. Both tool
descriptions say so explicitly, so the model does not over-apply the pattern.

**One caveat worth knowing up front.** Board agents get no wake-up channel: one
dispatch, then they are done. Inside that dispatch they read and write the board
as often as they like, but when it ends, it ends. `prompts/board/board-loop.md`
tells them so plainly and asks them to leave anything unfinished on the board
rather than assuming a next turn. It works, but a long task is better split
across two boards than hoped into one dispatch.

## The three algorithms

Every iteration begins with one question — *whose work do I read?* — and the
answer is the coordination algorithm. All three are ported **verbatim** from the
AWS `neighbourSelector.ts`.

| Algorithm | Each agent reads | Strength | Ceiling |
|---|---|---|---|
| **amorphous** | a fixed window of ring neighbours (`radius`) | per-agent cost constant as N grows; diversity preserved because everyone sees only their own slice | a signal moves one hop per iteration, so convergence is slow |
| **mesh** | everyone | fast alignment | diversity collapses onto the first signal; comfortable to ~30 agents |
| **swarm** | the K most recently active peers | follows where the energy is; scales past 100 | if K stays small while N grows, agents pile onto one subtask |

The productive sequence uses all three: open **amorphous** to explore, switch to
**swarm** as a direction forms, finish in **mesh** to align. `flock_direct`
switches topology on a live cluster (hot-reloaded between iterations).

Convergence arithmetic from the AWS post: in a ring one iteration carries a
signal `2R` positions, so propagation takes `ceil(N / 2R)` iterations and
consensus roughly two to three times that.

## Failure modes and their controls

The AWS post names four; each is a design choice here, not a bolt-on safeguard.

| Failure mode | Source | Control |
|---|---|---|
| **Groupthink** | mesh visibility collapses onto the first signal | open with amorphous; switch to mesh only to align |
| **Drift** | persistent session history builds behavioural momentum | **fresh child agent every iteration**; state lives only in the logs |
| **Hot spots** | swarm with K too small starves subtasks | raise K, or switch to amorphous |
| **Carry-over** | stale files read as current context | `environment/` is archived to `history/` on every start |

Drift deserves the extra sentence. Each agent turn is a *brand-new child agent*
with no memory of the previous turn — here that falls out of `spawn` semantics
rather than being simulated. It sounds wasteful; it is the control that keeps a
thousand independent loops steerable.

## Coordination is not `send_message`

The subagent messaging channel is restricted to the direct parent/child chain
(`kind: "ancestor"`), which cannot express "read my ring neighbours". So agents
coordinate the way the AWS original does — through the shared log on disk, which
is topology-independent. This is the same reason the AWS version uses a bucket
rather than a message bus, and it is what makes the ring and swarm topologies
expressible at all.

## Blackboard mode: how concurrent writes are made safe

Multiple agents append to one file with no locks, no CAS, and no transaction.
That works because the conflicts are designed out rather than arbitrated:

1. **Append only.** An entry is never edited or deleted, so two writers can never
   overwrite each other. History is the state.
2. **One write per line.** `O_APPEND` makes a single `write` atomic on a local
   filesystem. Splitting one line across two writes lets it interleave with a
   concurrent writer's.
3. **Tolerate torn reads.** A reader may catch a line mid-write. A line that does
   not parse is skipped, never fatal — the next read sees it whole.

Rule 2 is load-bearing, and the test suite measures it rather than asserting it:

| Load | Result |
|---|---|
| 8 writers × 200 lines, one write per line | **1600 entries, 0 corrupt** |
| 6 writers × 50 lines, each split across two writes | **187 of 300 corrupt** |

The failing case is kept as a test so the rule cannot quietly rot.

**This holds on a local filesystem.** `O_APPEND` is not reliably atomic on
NFS/SMB, and object stores like S3 have no append at all — which is exactly why
the AWS original writes one object per agent instead.

Because the harness pushes nothing into a board agent's prompt, the write
protocol has to reach the agent as instructions. `prompts/board/board-loop.md`
gives it a copy-pasteable template that routes the body through `json.dumps`, so
quotes, newlines and backslashes cannot break the line, plus the rule that
matters: **read the entry back and confirm it is yours**, because `>>` creates
the redirect target *before* running the command, so a failed write looks
successful.

## Repository layout

```
lib/index.js       plugin entry: registers flock_run / flock_status / flock_direct
cordis.patch.yml   bundle patch that mounts the plugin into a profile
src/
  store.js           shared environment: append-only logs, direction, state, config
  neighbours.js      the three algorithms + clampRadius guard
  agent.js           the loop: read logs -> dispatch an agent -> read back from disk
  subagent-runner.js ctx.subagents dispatch, persona, settling, artifact inspection
  cluster.js         launcher, concurrency limiting, snapshots
  ids.js             cluster-name sanitisation (a name becomes a directory)
prompts/           loop instructions + per-algorithm fragments
test/              smoke, plugin-load, subagent-dispatch, diff/
```

Cluster state lives under `<workspace>/.flock/<clusterId>/`:

```
direction.md              the goal, written once by the operator
config.json               algorithm / radius / swarmK (hot-reloaded)
store/state.json          starting | running | paused | stopped
store/agent-N.ndjson      one append-only log per agent — THE coordination channel
environment/              artifacts the agents wrote
history/                  previous runs' artifacts, archived
```

## Tests

```sh
npm run link-deps   # once: symlink the host's @deepseek-ai packages
npm test
```

| Suite | What it proves |
|---|---|
| `test/smoke.js` — 19 | coordination invariants: neighbour selection, convergence, termination, carry-over, concurrency limiting, that a passive agent is **not** credited with progress |
| `test/diff/topology-diff.js` | the port equals the AWS source: 1272 input combinations executed against the verbatim-extracted upstream functions |
| `test/plugin-load.js` — 10 | `apply()` works against the **real** `dsh-tools`: tools register, the schema compiles to valid JSON Schema, guards fire |
| `test/subagent-dispatch.js` — 11 | the dispatch call conforms to the documented `startContinuable` spec shape, personas are applied, settle/grace behaviour is bounded, and a finished child (`activity: "inactive"`) is recognized rather than waited out |

### The differential test

`test/diff/aws-neighbourSelector.ts` is the upstream file, and `aws-ref.cjs`
holds `amorphousNeighbours` / `meshNeighbours` extracted from it **verbatim**.
The test runs both implementations over 1272 inputs and asserts identical
output — a far stronger claim than hand-written expectations, because it proves
the port equals the thing it claims to port.

It also found a genuine **upstream bug**: when `radius >= concurrency`,
`(agentIndex - d + concurrency) % concurrency` underflows and yields a *negative*
agent index (`N=2, R=3 -> [-1, 1]`), which would address `agent--1.ndjson`.

The function body is left identical to upstream so the differential test stays
meaningful. The guard lives in `clampRadius`, used by `selectNeighbours` — the
only sanctioned entry point — so the buggy range is unreachable. If upstream
fixes it, the diff run flags the divergence and this port can follow.

## Live verification

`npm run live [agents] [algorithm]` boots the composed profile through the real
host runtime, mints a root captain, dispatches a cluster, and asserts that
artifacts land on disk. It is the only test that exercises a genuine agent turn.

Confirmed against a live profile (3 agents, mesh): **11 artifacts, 36KB**, with
agents running real code — one artifact reproduces a read-modify-write race on
the shared log and reports it verified at 3 and 12 concurrent agents. That is
the difference tools make: the same prompt on a tool-less runner produced only
narration.

It found three defects that the mocked suites could not, all now fixed and
pinned by regression tests:

| Defect | Symptom |
|---|---|
| `spec.signal` not passed | `signal.throwIfAborted()` TypeError — **every dispatch failed**, the cluster exited instantly with zero output |
| no model route on the child | child created but `activity: "inactive"` forever — it never activated |
| `isSettled` did not know `"inactive"` | a finished child never settled, so every dispatch waited out the full timeout and the cluster hung |

Requires a profile with a working model route; set `FLOCK_AGENT_PROVIDER` /
`FLOCK_AGENT_MODEL` to point the agents at one.

## What is verified and what is not

Being precise about this, because the distinction matters:

- **Verified here:** the coordination machinery, the plugin's registration
  against real `dsh-tools`, the dispatch call's conformance to the documented
  subagent API, and byte-for-byte agreement with the AWS topology code.
- **Verified live:** the plugin installs into a profile, mounts, registers its
  three tools in the live registry, and a dispatched cluster writes real
  artifacts to disk (see above).
- **Not verifiable at all:** behavioural equivalence with the AWS original. It
  needs EC2 and a Kiro subscription, so there is no way to run both and compare.

The coordination model is faithfully ported. The execution layer is a
reimplementation on a different runtime, and the runtime does some work the
original had to arrange explicitly (fresh-session drift control falls out of
`spawn` for free).

## Credit

The design — coordination through shared state, the three topologies, the
bounded neighbour set, the four failure modes, the convergence arithmetic — is
from the AWS Architecture Blog post
[*Scaling patterns for self-organizing multi-agent clusters with Kiro*](https://aws.amazon.com/blogs/architecture/scaling-patterns-for-self-organizing-multi-agent-clusters-with-kiro/)
and the Apache-2.0 reference implementation
[`aws-samples/sample-kiro-flock`](https://github.com/aws-samples/sample-kiro-flock).
The interesting ideas are theirs.
