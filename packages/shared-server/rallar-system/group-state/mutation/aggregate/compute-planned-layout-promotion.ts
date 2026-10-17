import {
    isSameGroupLayoutIdentity,
    resolveGroupLayoutRole,
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
 * The accepted-slot row is a complete decoded snapshot and its write revision.
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
    /**
     * What a fenced plan the slot no longer holds does: `promote-dominating`
     * promotes the slot's plan when it dominates the fenced identity, `reject`
     * keeps the fence exact.
     */
    readonly supersededFence: 'promote-dominating' | 'reject';
}

export type PlannedLayoutPromotion =
    | Readonly<{
        outcome: 'apply';
        /**
         * `newer` when the fenced plan was replanned before this promotion ran
         * and the slot's newer plan still satisfies the promotion's intent.
         */
        promoted: 'expected' | 'newer';
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
 *
 * Under `promote-dominating`, a fenced plan the slot no longer holds promotes
 * the slot's plan instead when that plan is the same group's (the read is by
 * the command's group), the same formation epoch's (the epoch fence above)
 * and planned from a causal revision and version that dominate the fenced
 * identity; an older or incomparable plan stays a superseded rejection.
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
    const promoted = resolvePromotedPlan(input, plannedIdentity);
    if (promoted === null) {
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
        promoted,
        acceptedSnapshot: input.planned.snapshot,
        acceptedIdentity: plannedIdentity,
        acceptedExpectedRevision: input.acceptedRow?.revision ?? null,
        plannedExpectedRevision: input.planned.revision
    };
}

function resolvePromotedPlan(
    input: ComputePlannedLayoutPromotionInput,
    plannedIdentity: GroupLayoutIdentity
): 'expected' | 'newer' | null {
    if (input.expectedLayout === null || isSameGroupLayoutIdentity(input.expectedLayout, plannedIdentity)) {
        return 'expected';
    }
    if (input.supersededFence === 'reject') {
        return null;
    }
    return resolveGroupLayoutRole({ publication: plannedIdentity, accepted: input.expectedLayout }) === 'planned'
        ? 'newer'
        : null;
}
