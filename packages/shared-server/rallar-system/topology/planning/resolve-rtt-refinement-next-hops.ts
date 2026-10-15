import type { RttMeasurementInfo } from '@shared/api/api-config.ts';

import { toCanonicalRtcTopologyPairIdentity } from '../persistence/rtc-topology-identifiers.ts';
import { computeEvolvedTopologyNextHops, type EvolvePlannedTopologyInput } from './evolve-planned-topology.ts';

/**
 * A rebuild replaces most edges of a tree that formed incrementally, and every
 * replaced edge is re-dialed through the signalling relay, so a refinement
 * rebuilds only when it shortens the leader's slowest path by at least a
 * quarter (the share of a tree the membership delta budget lets change at
 * once) and by more than RTT reports jitter on one path.
 */
export const RTT_REFINEMENT_MIN_RELATIVE_GAIN = 0.25;
export const RTT_REFINEMENT_MIN_ABSOLUTE_GAIN_MS = 10;

export interface ResolveRttRefinementNextHopsInput {
    readonly evolve: EvolvePlannedTopologyInput;
    readonly rttMeasurements: readonly RttMeasurementInfo[];
    readonly rebuiltNextHopsBySessionId: Record<string, readonly string[]>;
}

/** Keeps the accepted leader-rooted tree, evolved to the current members, unless the weighted rebuild is worth its churn. */
export function resolveRttRefinementNextHops(
    input: ResolveRttRefinementNextHopsInput
): Record<string, readonly string[]> {
    const { leaderSessionId } = input.evolve;
    if (input.evolve.kind !== 'tree' || leaderSessionId === undefined) {
        return input.rebuiltNextHopsBySessionId;
    }
    const evolved = computeEvolvedTopologyNextHops(input.evolve);
    if (evolved.outcome === 'full-rebuild') {
        return input.rebuiltNextHopsBySessionId;
    }

    const rttMsByPair = computeLatestRttMsByPair(input.rttMeasurements);
    const keptPathMs = computeLeaderPathMs(rttMsByPair, evolved.nextHopsBySessionId, leaderSessionId);
    const rebuiltPathMs = computeLeaderPathMs(rttMsByPair, input.rebuiltNextHopsBySessionId, leaderSessionId);
    const gainMs = keptPathMs - rebuiltPathMs;
    const worthRebuilding = gainMs >= RTT_REFINEMENT_MIN_ABSOLUTE_GAIN_MS &&
        gainMs >= keptPathMs * RTT_REFINEMENT_MIN_RELATIVE_GAIN;
    return worthRebuilding ? input.rebuiltNextHopsBySessionId : evolved.nextHopsBySessionId;
}

function computeLatestRttMsByPair(rttMeasurements: readonly RttMeasurementInfo[]): ReadonlyMap<string, number> {
    const latestByPair = new Map<string, RttMeasurementInfo>();
    for (const rtt of rttMeasurements) {
        const pair = toCanonicalRtcTopologyPairIdentity(rtt.sessionIdFrom, rtt.sessionIdTo);
        const current = latestByPair.get(pair);
        if (current === undefined || current.version < rtt.version) {
            latestByPair.set(pair, rtt);
        }
    }
    return new Map([...latestByPair].map(([pair, rtt]) => [pair, rtt.rttMs]));
}

/** The leader's slowest tree path; a link nobody measured weighs the slowest measured RTT, never less. */
function computeLeaderPathMs(
    rttMsByPair: ReadonlyMap<string, number>,
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>>,
    leaderSessionId: string
): number {
    const unmeasuredRttMs = Math.max(0, ...rttMsByPair.values());
    const pathMsBySessionId = new Map([[leaderSessionId, 0]]);
    const pending = [leaderSessionId];
    for (const current of pending) {
        const currentPathMs = pathMsBySessionId.get(current) ?? 0;
        for (const neighbour of nextHopsBySessionId[current] ?? []) {
            if (!pathMsBySessionId.has(neighbour)) {
                const linkMs = rttMsByPair.get(toCanonicalRtcTopologyPairIdentity(current, neighbour)) ??
                    unmeasuredRttMs;
                pathMsBySessionId.set(neighbour, currentPathMs + linkMs);
                pending.push(neighbour);
            }
        }
    }
    return Math.max(...pathMsBySessionId.values());
}
