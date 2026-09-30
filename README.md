# dsh-flock

Self-organizing multi-agent clusters for **DeepSeek Harness**: N real DSH
agents coordinating through a shared append-only log with **no orchestrator**.

You write one direction file. Nobody assigns tasks, no roles are declared, no
dependency graph is built. The agents decide for themselves what to do, build on
and criticise each other's artifacts, and converge by all going idle.

This is a port of [`aws-samples/sample-kiro-flock`](https://github.com/aws-samples/sample-kiro-flock).
The AWS original runs headless Kiro CLI sessions on EC2 against an S3 bucket;
here the agents are **DSH subagents** and the coordination plane is a directory.

```
EC2 instances + S3 bucket   ->  DSH subagents + a directory
headless Kiro CLI session   ->  ctx.subagents.startContinuable()
systemd reap                ->  self-terminating convergence
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
composition. It registers three tools into the shared tool registry and one
usage section into the global system prompt.

## Use

Any session in that profile can start a cluster in natural language
("start a flock of 6 agents to review this codebase"), or call the tools
directly.

| Tool | Purpose |
|---|---|
| `flock_run` | Start a cluster from one direction. Blocks until it converges or hits its deadline. |
| `flock_status` | Inspect a cluster: state, each agent's last log line, artifacts on disk. |
| `flock_direct` | Steer a live cluster: switch algorithm, rewrite the direction, pause/stop. |

```
flock_run(
  direction: "Survey the failure modes of log-based agent coordination.",
  agents: 4,
  algorithm: "amorphous"
)
```

**When to use it.** Work that splits into many quasi-independent contributions,
where diversity of approach is an asset and agents can join or leave freely.

**When not to.** A known task tree with strict ordering, or work that needs a
verification gate between steps — a normal delegation is better there. The tool
description says so explicitly, so the model does not over-apply the pattern.

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
