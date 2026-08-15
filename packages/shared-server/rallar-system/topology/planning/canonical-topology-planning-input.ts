import { compareRtcTopologyIdentifiers } from '../../rtc-topology-identifiers.ts';

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
  const bucket = hashCanonicalPair(left, right) % CANONICAL_PAIR_WEIGHT_BUCKETS;
  return 1 + (bucket / CANONICAL_PAIR_WEIGHT_BUCKETS) * CANONICAL_PAIR_WEIGHT_SPAN;
}

/**
 * Hashed in place over the ordered pair rather than over a materialized
 * identity string: planning calls this once per candidate pair, so an
 * allocation here is an O(N^2) allocation per plan. The leading length keeps
 * the digest injective over the pair without a delimiter that a session id
 * could itself contain.
 */
function hashCanonicalPair(left: string, right: string): number {
  const [first, second] = compareRtcTopologyIdentifiers(left, right) <= 0
    ? [left, right]
    : [right, left];
  let hash = hashNumber(2166136261, first.length);
  hash = hashChars(hash, first);
  hash = hashChars(hash, second);
  return hash >>> 0;
}

function hashChars(seed: number, value: string): number {
  let hash = seed;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash;
}

function hashNumber(seed: number, value: number): number {
  let hash = seed ^ value;
  hash = Math.imul(hash, 16777619);
  return hash;
}
