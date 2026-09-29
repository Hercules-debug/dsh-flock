/**
 * Neighbour selection for the three coordination algorithms.
 *
 * Direct port of kiro-flock `agent/neighbourSelector.ts`. The only change is
 * that swarm's "K most recently active" ranking reads filesystem mtimes
 * instead of S3 ListObjectsV2 LastModified.
 *
 * Why the bounded peer set matters (from the AWS post): give every agent full
 * visibility and the cluster collapses onto whatever the first agent wrote,
 * because each later agent reads that as consensus. Limited visibility lets
 * signals spread gradually and gives agents working from different context
 * room to develop alternatives.
 */
import { lastModified } from "./store.js";

export const ALGORITHMS = ["amorphous", "mesh", "swarm"];

/**
 * Ring-topology neighbours at radius R. Excludes self. Deterministic.
 *
 * Verbatim port of the AWS original, including one confirmed upstream bug:
 * when `radius >= concurrency` the subtraction `agentIndex - d + concurrency`
 * goes below zero and the modulo returns a NEGATIVE index (N=2, R=3 -> [-1, 1]).
 * A negative index addresses the wrong log key (`agent--1.ndjson`).
 *
 * The body is left identical so the differential test (test/diff) keeps
 * proving the port matches upstream. The guard lives in `selectNeighbours`,
 * which is the only sanctioned entry point, so callers cannot reach the buggy
 * range. See test/diff/topology-diff.js for the reproduction.
 */
export function amorphousNeighbours(agentIndex, concurrency, radius) {
  if (radius <= 0 || concurrency <= 1) return [];
  const neighbours = [];
  for (let d = 1; d <= radius; d++) {
    neighbours.push((agentIndex - d + concurrency) % concurrency);
    neighbours.push((agentIndex + d) % concurrency);
  }
  return Array.from(new Set(neighbours))
    .filter((idx) => idx !== agentIndex)
    .sort((a, b) => a - b);
}

/**
 * The safe radius for a ring of `concurrency` agents. At R >= N the upstream
 * arithmetic underflows, so a radius larger than the ring is meaningless
 * anyway: R = N-1 already gives every peer.
 */
export function clampRadius(concurrency, radius) {
  if (concurrency <= 1) return 0;
  return Math.max(0, Math.min(Math.trunc(radius), concurrency - 1));
}

/** All agents except self. */
export function meshNeighbours(agentIndex, concurrency) {
  const out = [];
  for (let i = 0; i < concurrency; i++) if (i !== agentIndex) out.push(i);
  return out;
}

/**
 * K most recently active agents by log mtime. Ties broken by ascending index
 * for determinism. Excludes self.
 *
 * Edge case preserved from the original: iteration 0 finds zero logs, so the
 * caller falls back to the amorphous ring and swarm only kicks in once
 * activity exists.
 */
export function swarmNeighbours(paths, agentIndex, concurrency, swarmK, radius) {
  const entries = [];
  for (let i = 0; i < concurrency; i++) {
    if (i === agentIndex) continue;
    const m = lastModified(paths, i);
    if (m === 0) continue;
    entries.push({ index: i, lastModified: m });
  }
  entries.sort((a, b) => {
    const diff = b.lastModified - a.lastModified;
    if (diff !== 0) return diff;
    return a.index - b.index;
  });
  const picked = entries.slice(0, swarmK).map((e) => e.index);
  if (picked.length === 0) {
    return amorphousNeighbours(agentIndex, concurrency, clampRadius(concurrency, radius));
  }
  return picked.slice().sort((a, b) => a - b);
}

export function selectNeighbours({ algorithm, agentIndex, concurrency, radius, swarmK, paths }) {
  switch (algorithm) {
    case "amorphous":
      // Clamped so the upstream underflow (negative indices at R >= N) is
      // unreachable from the public entry point.
      return amorphousNeighbours(agentIndex, concurrency, clampRadius(concurrency, radius));
    case "mesh":
      return meshNeighbours(agentIndex, concurrency);
    case "swarm":
      return swarmNeighbours(paths, agentIndex, concurrency, swarmK, radius);
    default:
      throw new Error(`unknown algorithm: ${algorithm}`);
  }
}

/**
 * Propagation math straight from the AWS post: one iteration carries a signal
 * 2R positions, so full propagation takes ceil(N / 2R) iterations and
 * consensus roughly two to three times that.
 */
export function convergenceEstimate(concurrency, radius) {
  const r = Math.max(1, radius);
  const propagation = Math.ceil(concurrency / (2 * r));
  return {
    propagation,
    consensusLow: propagation * 2,
    consensusHigh: propagation * 3,
  };
}
