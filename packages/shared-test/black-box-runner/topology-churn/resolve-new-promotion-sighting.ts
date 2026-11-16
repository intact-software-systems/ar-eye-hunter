import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';

import type { TopologyChurnPromotionSighting } from './compute-topology-churn-report.ts';

export interface ResolveNewPromotionSightingInput {
    readonly sightings: readonly TopologyChurnPromotionSighting[];
    readonly acceptedLayout: GroupLayoutIdentity | null;
    readonly seenAtEpochMs: number;
}

/** Only an identity's first sighting is kept: the report matches a plan to the first sighting with its identity. */
export function resolveNewPromotionSighting(
    input: ResolveNewPromotionSightingInput
): TopologyChurnPromotionSighting | null {
    const acceptedLayout = input.acceptedLayout;
    if (
        acceptedLayout === null ||
        input.sightings.some((sighting) => isSameGroupLayoutIdentity(sighting.layout, acceptedLayout))
    ) {
        return null;
    }
    return { layout: acceptedLayout, firstSeenAtEpochMs: input.seenAtEpochMs };
}
