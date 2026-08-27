import { describe, expect, it } from 'vitest';

import {
    computePlannedLayoutPromotion,
    type GroupPlannedLayoutRow
} from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-planned-layout-promotion.ts';
import { groupLayoutPromotionEffects } from '@shared-server/rallar-system/group-state/persistence/layout/group-layout-promotion-descriptors.ts';
import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

const GROUP_REF = {
    applicationId: 'promotion-app',
    workspaceId: 'promotion-workspace',
    groupId: 'promotion-group'
} as const;

const IDENTITY: GroupLayoutIdentity = {
    groupRevision: 4,
    presenceRevision: 6,
    version: 3,
    state: 'active'
};

const SNAPSHOT: RallarOverlayTopologySnapshot = {
    sourceGroupStateCausalRevision: {
        groupRevision: IDENTITY.groupRevision,
        presenceRevision: IDENTITY.presenceRevision
    },
    state: 'active',
    overlayId: toScopedOverlayId(GROUP_REF),
    groupRef: GROUP_REF,
    name: 'promotion-overlay',
    topology: 'tree',
    activeSessionIds: ['session-a'],
    nextHopsBySessionId: { 'session-a': [] },
    degreeLimit: 2,
    version: IDENTITY.version,
    createdByClientId: 'promotion-service',
    createdAtEpochMs: 800,
    updatedAtEpochMs: 900
};

const PLANNED: GroupPlannedLayoutRow = {
    snapshot: SNAPSHOT,
    identity: IDENTITY,
    revision: 11,
    inputFingerprint: `sha256:${'b'.repeat(64)}`
};

describe('computePlannedLayoutPromotion', () => {
    it('applies the stored plan with every accepted fact computed together', () => {
        const promotion = computePlannedLayoutPromotion({
            expectedFormationEpoch: 2,
            expectedLayout: IDENTITY,
            currentFormationEpoch: 2,
            planned: PLANNED,
            acceptedIdentity: null,
            acceptedRow: null
        });

        expect(promotion).toEqual({
            outcome: 'apply',
            acceptedSnapshot: SNAPSHOT,
            acceptedIdentity: IDENTITY,
            acceptedFingerprint: PLANNED.inputFingerprint,
            acceptedExpectedRevision: null,
            plannedExpectedRevision: 11
        });
    });

    it('carries the accepted row revision for a re-promotion', () => {
        const promotion = computePlannedLayoutPromotion({
            expectedFormationEpoch: null,
            expectedLayout: null,
            currentFormationEpoch: 2,
            planned: PLANNED,
            acceptedIdentity: { ...IDENTITY, version: 2 },
            acceptedRow: { identity: { ...IDENTITY, version: 2 }, revision: 8 }
        });

        expect(promotion.outcome).toBe('apply');
        if (promotion.outcome === 'apply') {
            expect(promotion.acceptedExpectedRevision).toBe(8);
        }
    });

    it.each([
        {
            name: 'stale-fence on an epoch mismatch',
            input: { expectedFormationEpoch: 1, expectedLayout: IDENTITY, planned: PLANNED },
            outcome: 'stale-fence'
        },
        {
            name: 'no-planned-layout without a stored row',
            input: { expectedFormationEpoch: null, expectedLayout: null, planned: null },
            outcome: 'no-planned-layout'
        },
        {
            name: 'no-planned-layout on a tombstoned row',
            input: {
                expectedFormationEpoch: null,
                expectedLayout: null,
                planned: {
                    ...PLANNED,
                    identity: { ...IDENTITY, state: 'removed' as const }
                }
            },
            outcome: 'no-planned-layout'
        },
        {
            name: 'planned-layout-superseded on an identity mismatch',
            input: {
                expectedFormationEpoch: 2,
                expectedLayout: { ...IDENTITY, version: 2 },
                planned: PLANNED
            },
            outcome: 'planned-layout-superseded'
        }
    ])('computes $name', (row) => {
        const promotion = computePlannedLayoutPromotion({
            currentFormationEpoch: 2,
            acceptedIdentity: null,
            acceptedRow: null,
            ...row.input
        });
        expect(promotion.outcome).toBe(row.outcome);
    });

    it('computes already-applied when the accepted identity matches the plan', () => {
        const promotion = computePlannedLayoutPromotion({
            expectedFormationEpoch: 2,
            expectedLayout: IDENTITY,
            currentFormationEpoch: 2,
            planned: PLANNED,
            acceptedIdentity: IDENTITY,
            acceptedRow: { identity: IDENTITY, revision: 8 }
        });
        expect(promotion.outcome).toBe('already-applied');
    });
});

describe('groupLayoutPromotionEffects', () => {
    it('re-asserts the planned row and inserts the first accepted row atomically', () => {
        const effects = groupLayoutPromotionEffects(GROUP_REF, {
            outcome: 'apply',
            acceptedSnapshot: SNAPSHOT,
            acceptedIdentity: IDENTITY,
            acceptedFingerprint: PLANNED.inputFingerprint,
            acceptedExpectedRevision: null,
            plannedExpectedRevision: 11
        });

        expect(effects.map((effect) => [effect.effectId, effect.operation, effect.namespace]))
            .toEqual([
                ['planned-layout-fence', 'update', RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE],
                ['accepted-layout', 'insert', RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE],
                [
                    'accepted-layout-fingerprint',
                    'put',
                    'rtc-topology:accepted-input-fingerprints'
                ]
            ]);
        const fence = effects[0];
        if (fence.operation !== 'update') {
            throw new Error('planned fence must be a revision-guarded update');
        }
        expect(fence.expectedRevision).toBe(11);
    });

    it('revision-guards a re-promotion of the accepted row', () => {
        const effects = groupLayoutPromotionEffects(GROUP_REF, {
            outcome: 'apply',
            acceptedSnapshot: SNAPSHOT,
            acceptedIdentity: IDENTITY,
            acceptedFingerprint: null,
            acceptedExpectedRevision: 8,
            plannedExpectedRevision: 11
        });

        const accepted = effects.find((effect) => effect.effectId === 'accepted-layout');
        if (accepted?.operation !== 'update') {
            throw new Error('re-promotion must be a revision-guarded update');
        }
        expect(accepted.expectedRevision).toBe(8);
        expect(effects.some((effect) => effect.effectId === 'accepted-layout-fingerprint'))
            .toBe(false);
    });
});
