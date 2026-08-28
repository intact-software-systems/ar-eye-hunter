import {
    isSameGroupLayoutIdentity,
    toGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

/**
 * The planned-slot row as the promotion read loads it. The identity is
 * always derived from the snapshot at the point of use — a precomputed copy
 * would be a second source of truth that fixtures could split.
 */
export type GroupPlannedLayoutRow = Readonly<{
    snapshot: RallarOverlayTopologySnapshot;
    revision: number;
}>;

/**
 * The accepted slot's stored row. The revision drives promotion's
 * insert-vs-update guard; the snapshot is what `reset` turns into a tombstone
 * (product decision 36), which a revision alone cannot express.
 */
export type GroupAcceptedLayoutRow = Readonly<{
    snapshot: RallarOverlayTopologySnapshot;
    revision: number;
}>;

export interface ComputePlannedLayoutPromotionInput {
    /** The fence the command carries; null on operator commands. */
    readonly expectedFormationEpoch: number | null;
    readonly expectedLayout: GroupLayoutIdentity | null;
    readonly currentFormationEpoch: number;
    readonly planned: GroupPlannedLayoutRow | null;
    readonly acceptedIdentity: GroupLayoutIdentity | null;
    readonly acceptedRow: GroupAcceptedLayoutRow | null;
}

export type PlannedLayoutPromotion =
    | Readonly<{
        outcome: 'apply';
        acceptedSnapshot: RallarOverlayTopologySnapshot;
        acceptedIdentity: GroupLayoutIdentity;
        /** Null when the accepted slot is empty (first promotion inserts). */
        acceptedExpectedRevision: number | null;
        /**
         * The planned row's revision, re-asserted inside the write
         * transaction so a replan between read and commit conflicts instead
         * of promoting a superseded plan (decisions 19/32, PR 3 review).
         */
        plannedExpectedRevision: number;
    }>
    | Readonly<{ outcome: 'already-applied'; }>
    | Readonly<{ outcome: 'no-planned-layout'; }>
    | Readonly<{ outcome: 'planned-layout-superseded'; }>
    | Readonly<{ outcome: 'stale-fence'; }>;

/**
 * The canonical promotion effect (product decisions 24 and 42), pure: it
 * decides whether the stored planned layout becomes the accepted layout and
 * computes every accepted fact together — row, fingerprint and the group's
 * acceptedLayoutIdentity — or names exactly why not. It never writes and
 * never changes a stage by itself. A tombstoned planned row never promotes:
 * its teardown is a fact about the old layout, not a new acceptance.
 */
export function computePlannedLayoutPromotion(
    input: ComputePlannedLayoutPromotionInput
): PlannedLayoutPromotion {
    if (
        input.expectedFormationEpoch !== null &&
        input.expectedFormationEpoch !== input.currentFormationEpoch
    ) {
        return { outcome: 'stale-fence' };
    }
    if (input.planned === null) {
        return { outcome: 'no-planned-layout' };
    }
    const plannedIdentity = toGroupLayoutIdentity(input.planned.snapshot);
    if (plannedIdentity.state !== 'active') {
        return { outcome: 'no-planned-layout' };
    }
    if (
        input.expectedLayout !== null &&
        !isSameGroupLayoutIdentity(input.expectedLayout, plannedIdentity)
    ) {
        return { outcome: 'planned-layout-superseded' };
    }
    if (
        input.acceptedIdentity !== null &&
        isSameGroupLayoutIdentity(input.acceptedIdentity, plannedIdentity)
    ) {
        return { outcome: 'already-applied' };
    }
    return {
        outcome: 'apply',
        acceptedSnapshot: input.planned.snapshot,
        acceptedIdentity: plannedIdentity,
        acceptedExpectedRevision: input.acceptedRow?.revision ?? null,
        plannedExpectedRevision: input.planned.revision
    };
}
