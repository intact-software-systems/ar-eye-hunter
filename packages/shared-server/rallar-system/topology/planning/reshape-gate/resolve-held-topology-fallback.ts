import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

import type {
    EvolvePlannedTopologyFullRebuildReason,
    EvolvePlannedTopologyResult
} from '../evolve-planned-topology.ts';

/** The in-place update a held plan attempted and could not make. */
export interface HeldTopologyFallback {
    readonly topology: RallarRtcTopologyKind;
    readonly reason: EvolvePlannedTopologyFullRebuildReason;
}

/**
 * The replan after a held plan's failed update would evolve the same previous layout to the same members, so for the
 * same kind the held attempt's failure stands: it is reused rather than computed and counted again.
 */
export function resolveHeldTopologyFallback(
    fallback: HeldTopologyFallback | undefined,
    topology: RallarRtcTopologyKind
): EvolvePlannedTopologyResult | undefined {
    if (fallback === undefined || fallback.topology !== topology) {
        return undefined;
    }
    return { outcome: 'full-rebuild', reason: fallback.reason };
}
