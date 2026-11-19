import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';
import type {
    HeldTopologyReshapeReason,
    TopologyReshapePermission
} from '@shared/api/topology-plan/topology-reshape-gate.ts';

export interface ResolveHeldTopologyKindInput {
    readonly reshape: TopologyReshapePermission;
    /** The kind of the active previous layout; absent when there is none to keep. */
    readonly previousKind: RallarRtcTopologyKind | undefined;
    /** The kind the planner selects for the room without the reshape gate. */
    readonly selectedKind: RallarRtcTopologyKind;
    /** The room's configuration names its kind, which no gate overrides. */
    readonly explicitKind: boolean;
    readonly activeSize: number;
    readonly degreeLimit: number;
}

export interface HeldTopologyKind {
    readonly topology: RallarRtcTopologyKind;
    readonly heldReshapeReasons: readonly HeldTopologyReshapeReason[];
}

/** A star links every member to every other, so it is kept only while each member stays within the link limit. */
export function resolveHeldTopologyKind(input: ResolveHeldTopologyKindInput): HeldTopologyKind {
    const { previousKind, selectedKind } = input;
    if (
        input.reshape.reshape !== 'held' || previousKind === undefined || previousKind === selectedKind ||
        input.explicitKind || (previousKind === 'star' && input.activeSize - 1 > input.degreeLimit)
    ) {
        return { topology: selectedKind, heldReshapeReasons: [] };
    }
    return { topology: previousKind, heldReshapeReasons: ['kind-change'] };
}
