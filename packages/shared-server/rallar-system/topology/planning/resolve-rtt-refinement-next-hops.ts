import type { RttMeasurementInfo } from '@shared/api/api-config.ts';

import { toCanonicalRtcTopologyPairIdentity } from '../persistence/rtc-topology-identifiers.ts';
import { computeEvolvedTopologyNextHops, type EvolvePlannedTopologyInput } from './evolve-planned-topology.ts';

/**
 * A rebuild replaces most edges of a tree that formed incrementally, and every
 * replaced edge is re-dialed through the signalling relay, so a refinement
 * rebuilds only when it shortens the tree's slowest path (from the leader, or
 * between any two members of a leaderless tree) by at least a quarter (the
 * share of a tree the membership delta budget lets change at once) and by more
 * than RTT reports jitter on one path.
 */
export const RTT_REFINEMENT_MIN_RELATIVE_GAIN = 0.25;
export const RTT_REFINEMENT_MIN_ABSOLUTE_GAIN_MS = 10;

export interface ResolveRttRefinementNextHopsInput {
    readonly evolve: EvolvePlannedTopologyInput;
    readonly rttMeasurements: readonly RttMeasurementInfo[];
    readonly rebuiltNextHopsBySessionId: Record<string, readonly string[]>;
}

interface RttLinkWeights {
    readonly rttMsByPair: ReadonlyMap<string, number>;
    readonly unmeasuredRttMs: number;
}

interface FarthestTreeSession {
    readonly sessionId: string;
    readonly pathMs: number;
}

/** Keeps the accepted tree, evolved to the current members, unless the weighted rebuild is worth its churn. */
export function resolveRttRefinementNextHops(
    input: ResolveRttRefinementNextHopsInput
): Record<string, readonly string[]> {
    if (input.evolve.kind !== 'tree') {
        return input.rebuiltNextHopsBySessionId;
    }
    const evolved = computeEvolvedTopologyNextHops(input.evolve);
    if (evolved.outcome === 'full-rebuild') {
        return input.rebuiltNextHopsBySessionId;
    }

    const weights = computeRttLinkWeights(input.rttMeasurements);
    const { leaderSessionId } = input.evolve;
    const keptPathMs = computeSlowestTreePathMs(weights, evolved.nextHopsBySessionId, leaderSessionId);
    const rebuiltPathMs = computeSlowestTreePathMs(weights, input.rebuiltNextHopsBySessionId, leaderSessionId);
    const gainMs = keptPathMs - rebuiltPathMs;
    const worthRebuilding = gainMs >= RTT_REFINEMENT_MIN_ABSOLUTE_GAIN_MS &&
        gainMs >= keptPathMs * RTT_REFINEMENT_MIN_RELATIVE_GAIN;
    return worthRebuilding ? input.rebuiltNextHopsBySessionId : evolved.nextHopsBySessionId;
}

/** A link nobody measured weighs the slowest measured RTT, never less. */
function computeRttLinkWeights(rttMeasurements: readonly RttMeasurementInfo[]): RttLinkWeights {
    const latestByPair = new Map<string, RttMeasurementInfo>();
    for (const rtt of rttMeasurements) {
        const pair = toCanonicalRtcTopologyPairIdentity(rtt.sessionIdFrom, rtt.sessionIdTo);
        const current = latestByPair.get(pair);
        if (current === undefined || current.version < rtt.version) {
            latestByPair.set(pair, rtt);
        }
    }
    const rttMsByPair = new Map([...latestByPair].map(([pair, rtt]) => [pair, rtt.rttMs]));
    return { rttMsByPair, unmeasuredRttMs: Math.max(0, ...rttMsByPair.values()) };
}

/**
 * The leader's slowest path, or for a leaderless tree its slowest path between
 * any two members: in a tree the session farthest from any start ends a
 * longest path, so a second pass from it measures that path.
 */
function computeSlowestTreePathMs(
    weights: RttLinkWeights,
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>>,
    leaderSessionId: string | undefined
): number {
    if (leaderSessionId !== undefined) {
        return computeFarthestTreeSession(weights, nextHopsBySessionId, leaderSessionId).pathMs;
    }
    const startSessionId = Object.keys(nextHopsBySessionId)[0];
    if (startSessionId === undefined) {
        return 0;
    }
    const pathEnd = computeFarthestTreeSession(weights, nextHopsBySessionId, startSessionId);
    return computeFarthestTreeSession(weights, nextHopsBySessionId, pathEnd.sessionId).pathMs;
}

function computeFarthestTreeSession(
    weights: RttLinkWeights,
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>>,
    rootSessionId: string
): FarthestTreeSession {
    const pathMsBySessionId = new Map([[rootSessionId, 0]]);
    let farthest: FarthestTreeSession = { sessionId: rootSessionId, pathMs: 0 };
    const pending = [rootSessionId];
    for (const current of pending) {
        const currentPathMs = pathMsBySessionId.get(current) ?? 0;
        for (const neighbour of nextHopsBySessionId[current] ?? []) {
            if (!pathMsBySessionId.has(neighbour)) {
                const linkMs = weights.rttMsByPair.get(toCanonicalRtcTopologyPairIdentity(current, neighbour)) ??
                    weights.unmeasuredRttMs;
                const pathMs = currentPathMs + linkMs;
                pathMsBySessionId.set(neighbour, pathMs);
                pending.push(neighbour);
                if (pathMs > farthest.pathMs) {
                    farthest = { sessionId: neighbour, pathMs };
                }
            }
        }
    }
    return farthest;
}
