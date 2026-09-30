/**
 * The DSH-subagent backend for the agent turn.
 *
 * This is what makes the port real. The standalone version called a bare
 * `/chat/completions` endpoint, so an agent had **no tools** and could only
 * narrate work it never performed — it would log "wrote environment/foo.md"
 * while `environment/` stayed empty. Artifacts were paper.
 *
 * Here each turn is dispatched through `ctx.subagents.startContinuable()`,
 * producing a genuine DSH child agent with the host's full tool set (bash, fs,
 * str_replace_editor, …), its own session, and its own system prompt. The
 * agent writes and can actually *execute and verify* its artifact.
 *
 * Coordination is deliberately NOT done through `send_message`. That channel
 * is restricted to the direct parent/child chain (`kind: "ancestor"`), which
 * cannot express "read my ring neighbours". Agents coordinate the way the AWS
 * original does: through the shared append-only log on disk, which every agent
 * can read regardless of the delegation topology.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Build a runner bound to one plugin context.
 *
 * @param {object} deps
 * @param {object} deps.ctx            plugin context (needs `ctx.subagents`)
 * @param {object} deps.captain        the Agent authorizing delegation
 * @param {string} deps.provider       subagent provider name (default "spawn")
 * @param {object} deps.agentOptions   provider/model/reasoningEffort overrides
 * @returns {(args) => Promise<string>} a runner for `runAgent`
 */
export function createSubagentRunner({
  ctx,
  captain,
  provider = "spawn",
  agentOptions = {},
  onEvent = () => {},
  /** How long to wait when the host exposes no readable child state. */
  settleGraceMs = 5000,
}) {
  const providerHandle = ctx.subagents.getProvider(provider);
  if (!providerHandle) {
    const available = ctx.subagents.list().join(", ") || "(none)";
    throw new Error(
      `flock: subagent provider "${provider}" is not registered. Available: ${available}`,
    );
  }
  const caps = providerHandle.capabilities ?? {};
  if (caps.persona === false) {
    throw new Error(`flock: provider "${provider}" cannot apply a persona, which agents need`);
  }

  return async function subagentRunner({ prompt, agentIndex, clusterId, iteration, signal }) {
    const label = `flock:${clusterId}:agent-${agentIndex}:it-${iteration}`;
    // `spec.signal` is REQUIRED — the service calls `signal.throwIfAborted()`
    // on it before doing anything else. Omitting it throws a TypeError that
    // looks nothing like a missing parameter, and every agent turn dies before
    // the child is even created.
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const start = await ctx.subagents.startContinuable({
      provider,
      label,
      signal: ac.signal,
      request: {
        // A standalone prompt: a spawned child sees none of this conversation.
        prompt: [{ type: "text", text: prompt }],
        parent: captain,
        persona: personaFor(clusterId, agentIndex),
        signal: ac.signal,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      },
    }).finally(() => signal?.removeEventListener?.("abort", onAbort));

    // The child is a full agent; its turn runs to completion in the host. We
    // wait for it to settle, then read back what it wrote — the log is
    // authoritative, exactly as in the AWS original where the harness reads the
    // agent's append-only log rather than trusting a return value.
    await waitForSettle(ctx, start.childId, {
      onEvent,
      startupGraceMs: settleGraceMs,
      parentSessionId: captain.session?.id,
    });
    return { settled: true, childId: start.childId };
  };
}

/**
 * Persona text: the only place the agent learns it is one member of a cluster
 * rather than a solo assistant. Kept short — the loop instructions travel in
 * the task prompt so they can change per iteration.
 */
export function personaFor(clusterId, agentIndex) {
  return [
    `You are agent-${agentIndex} in self-organizing cluster "${clusterId}".`,
    `There is no orchestrator: nobody assigns you work and nobody tells you when the cluster is done.`,
    `You coordinate with peers only by reading and appending to a shared log on disk.`,
    `Do the single highest-value piece of work you can see, write it to disk, and append one log line.`,
  ].join(" ");
}

/**
 * Wait for a dispatched turn to stop working.
 *
 * The subagent service reports idle/running edges; we poll rather than block on
 * a channel the child owns. Two robustness rules, both learned from failures:
 *
 *   - the listing APIs return ARRAYS (and `listDescendants` may need a root id),
 *     so a single entry must be searched for, not assumed;
 *   - if listing is unavailable or unhelpful, give the child a bounded grace
 *     period and carry on. Blocking forever would deadlock the whole cluster,
 *     and an unreadable state is not a reason to fail the turn.
 */
async function waitForSettle(ctx, childId, { onEvent, pollMs = 400, startupGraceMs = 3000, timeoutMs = 15 * 60 * 1000, parentSessionId }) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let sawRunning = false;
  let lastState;

  while (Date.now() < deadline) {
    let state;
    try {
      state = await readChildState(ctx, childId, parentSessionId);
    } catch {
      state = undefined;
    }
    lastState = state;

    if (state === "running" || state === "working") sawRunning = true;
    // Only trust a settled reading once the child has actually been seen
    // running, or once a startup grace has elapsed. A child that has not
    // started yet also reads as "idle", and returning on that reading is what
    // made a live cluster finish instantly having produced nothing.
    if (isSettled(state) && (sawRunning || Date.now() - started >= startupGraceMs)) return;

    // Unknown state: give it the same grace, then stop waiting. The caller
    // inspects the disk for what actually appeared.
    if (state === undefined && Date.now() - started >= startupGraceMs) {
      onEvent({ type: "settle-unknown", childId, lastState });
      return;
    }
    await sleep(pollMs);
  }
  onEvent({ type: "settle-timeout", childId, lastState });
}

/**
 * Does this activity mean the child is no longer working?
 *
 * The live host reports `activity: "running" | "inactive"`. An earlier version
 * of this list omitted "inactive" and only knew "idle", so a finished child
 * never registered as settled and every dispatch waited out the full 15-minute
 * timeout — a cluster that hung with two agents done and a third never started.
 * Match the real vocabulary, and treat anything that is not "running" as
 * settled, so an unrecognised future value degrades to finished rather than
 * hanging forever.
 */
const isSettled = (state) => {
  if (state === undefined) return false;
  const s = String(state).toLowerCase();
  if (s === "running" || s === "working" || s === "active" || s === "starting") return false;
  return true;
};

/**
 * Find this child's activity across whichever listing API the host exposes.
 *
 * Two things learned the hard way against the live host:
 *   - the listing is keyed by the PARENT session id, not the child's;
 *   - the field is `activity` ("running" | "inactive"), not `state`/`status`.
 * Getting either wrong yields `undefined` forever, which the caller then reads
 * as "settled" — a cluster that finishes instantly having done nothing.
 */
async function readChildState(ctx, childId, parentSessionId) {
  const norm = (entry) => {
    if (!entry || typeof entry !== "object") return undefined;
    return entry.activity ?? entry.state ?? entry.status;
  };
  const pick = (value) => {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) return norm(value);
    if (value.length === 0) return undefined;
    const hit = value.find((e) =>
      e && (e.id === childId || e.sessionId === childId || e.childId === childId));
    return norm(hit ?? value[0]);
  };

  const parents = [parentSessionId, ctx.__flockRootId].filter(Boolean);
  for (const parentId of parents) {
    if (typeof ctx.subagents.listChildren !== "function") break;
    try {
      const v = pick(await ctx.subagents.listChildren(parentId));
      if (v !== undefined) return v;
    } catch { /* try the next source */ }
  }
  if (typeof ctx.subagents.listDescendants === "function") {
    for (const parentId of parents) {
      try {
        const v = pick(await ctx.subagents.listDescendants(parentId));
        if (v !== undefined) return v;
      } catch { /* try the next source */ }
    }
  }
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A runner that dispatches to a caller-supplied function instead of a real
 * subagent. Used by the test suite, which cannot stand up the host runtime.
 */
export function createInjectedRunner(fn) {
  return async (args) => fn(args);
}

/**
 * Read the artifact an agent actually wrote, for hosts that want to record the
 * filename in the coordination log. Returns null when the agent wrote nothing
 * this turn — which is now a meaningful signal, because the agent has tools and
 * could have written something.
 */
export function newestArtifact(envDir, sinceMs) {
  let best = null;
  let entries;
  try {
    entries = fs.readdirSync(envDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const full = path.join(envDir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (sinceMs !== undefined && st.mtimeMs < sinceMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { name, mtimeMs: st.mtimeMs, bytes: st.size };
  }
  return best;
}
