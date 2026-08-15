import {
  compareRtcTopologyIdentifiers,
  toCanonicalRtcTopologyPairIdentity,
} from '../../rtc-topology-identifiers.ts';

/**
 * Planning input order is canonical, never arrival order: identical member
 * sets must plan identical graphs on every server regardless of how the
 * presence rows arrived (convergent-service doctrine for unordered sets).
 */
export function toCanonicalTopologySessionIds(
  sessionIds: readonly string[],
): readonly string[] {
  return [...new Set(sessionIds)].sort(compareRtcTopologyIdentifiers);
}

const CANONICAL_PAIR_WEIGHT_BUCKETS = 4096;
const CANONICAL_PAIR_WEIGHT_SPAN = 31;

/**
 * Order-independent fallback edge weight for planning without RTT
 * measurements. The weight is a pure function of the unordered session pair,
 * so it is identical across servers and input orders and — unlike the retired
 * positional `|i-j|+1` — does not shift when an unrelated member joins or
 * leaves. The range [1, 32) keeps the magnitude family of the retired weights
 * and stays >= 1 because the no-RTT tree mirror uses `distance > 0` as its
 * "distance exists" sentinel.
 */
export function computeCanonicalTopologyPairWeight(left: string, right: string): number {
  const bucket = fnv1aHash(toCanonicalRtcTopologyPairIdentity(left, right)) %
    CANONICAL_PAIR_WEIGHT_BUCKETS;
  return 1 + (bucket / CANONICAL_PAIR_WEIGHT_BUCKETS) * CANONICAL_PAIR_WEIGHT_SPAN;
}

function fnv1aHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
