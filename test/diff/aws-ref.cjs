/**
 * Reference implementations extracted VERBATIM from the AWS original
 * `kiro-flock-cluster/agent/neighbourSelector.ts` (aws-samples/sample-kiro-flock).
 *
 * The only edit is dropping the S3 import and the swarm function (which needs
 * a live bucket); `amorphousNeighbours` and `meshNeighbours` are pure and are
 * copied character-for-character from the source so the differential test
 * compares against the real thing, not against my memory of it.
 *
 * Source: test/diff/aws-neighbourSelector.ts
 */

// --- verbatim from AWS source ---------------------------------------------
function amorphousNeighbours(
  agentIndex,
  concurrency,
  radius,
) {
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

function meshNeighbours(agentIndex, concurrency) {
  const out = [];
  for (let i = 0; i < concurrency; i++) {
    if (i !== agentIndex) out.push(i);
  }
  return out;
}
// --- end verbatim ----------------------------------------------------------

module.exports = { amorphousNeighbours, meshNeighbours };
