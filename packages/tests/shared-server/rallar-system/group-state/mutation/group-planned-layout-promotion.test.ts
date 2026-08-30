import { describe, expect, it } from 'vitest';

import type { GroupStateMutationCommand } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { assertGroupMutationAuthority } from '@shared-server/rallar-system/group-state/mutation/command-validation/assert-group-mutation-authority.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { toApplyPlannedLayoutCommand } from '@shared-server/rallar-system/group-state/to-apply-planned-layout-command.ts';
import { computeTopologyPromotionEntry, decodeTopologyPromotionWork } from '@shared-server/rallar-system/group-state/topology-promotion-outbox-entry.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService, type GroupStateTestService } from '../group-state-test-runtime.ts';

import {
    computePlannedLayoutPromotion,
    type GroupPlannedLayoutRow
} from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-planned-layout-promotion.ts';
import { toGroupLayoutPromotionEffects } from '@shared-server/rallar-system/group-state/persistence/layout/to-group-layout-promotion-effects.ts';
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
    revision: 11
};

interface PlannedLayoutApplyHarness {
    readonly service: GroupStateTestService;
    readonly prepare: (command: GroupMutationCommand) => Promise<GroupStateMutationCommand>;
}

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
            acceptedRow: { snapshot: SNAPSHOT, revision: 8 }
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
                    snapshot: { ...SNAPSHOT, state: 'removed' as const }
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
            acceptedRow: { snapshot: SNAPSHOT, revision: 8 }
        });
        expect(promotion.outcome).toBe('already-applied');
    });
});

describe('groupLayoutPromotionEffects', () => {
    it('re-asserts the planned row and inserts the first accepted row atomically', () => {
        const effects = toGroupLayoutPromotionEffects({
            outcome: 'apply',
            acceptedSnapshot: SNAPSHOT,
            acceptedIdentity: IDENTITY,
            acceptedExpectedRevision: null,
            plannedExpectedRevision: 11
        });

        expect(effects.map((effect) => [effect.effectId, effect.operation, effect.namespace]))
            .toEqual([
                ['planned-layout-fence', 'update', RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE],
                ['accepted-layout', 'insert', RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE]
            ]);
        const fence = effects[0];
        if (fence.operation !== 'update') {
            throw new Error('planned fence must be a revision-guarded update');
        }
        expect(fence.expectedRevision).toBe(11);
    });

    it('revision-guards a re-promotion of the accepted row', () => {
        const effects = toGroupLayoutPromotionEffects({
            outcome: 'apply',
            acceptedSnapshot: SNAPSHOT,
            acceptedIdentity: IDENTITY,
            acceptedExpectedRevision: 8,
            plannedExpectedRevision: 11
        });

        const accepted = effects.find((effect) => effect.effectId === 'accepted-layout');
        if (accepted?.operation !== 'update') {
            throw new Error('re-promotion must be a revision-guarded update');
        }
        expect(accepted.expectedRevision).toBe(8);
    });
});

describe('applyPlannedLayout through the durable service', () => {
    async function createApplyHarness(): Promise<PlannedLayoutApplyHarness> {
        const service = createTestGroupStateService({
            runtimeRepository: new FakeRuntimeStateRepository(),
            now: () => 1_000,
            randomId: (() => {
                let generated = 0;
                return () => `apply-id-${++generated}`;
            })(),
            serviceId: 'apply-service',
            readPlannedLayoutRow: async () => ({ snapshot: SNAPSHOT, revision: 11 }),
            readAcceptedLayoutRow: async () => null
        });
        await service.createGroup(
            { applicationId: GROUP_REF.applicationId, workspaceId: GROUP_REF.workspaceId },
            {
                groupId: GROUP_REF.groupId,
                displayName: 'Promotion group',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'owner',
                requestId: 'apply-seed'
            }
        );
        const prepare = async (command: GroupMutationCommand): Promise<GroupStateMutationCommand> => {
            const preparation = await service.prepareTopologyPublicationMutation(command, 1_000);
            return {
                authorityProof: null,
                descriptor: null,
                command: preparation.command,
                facts: { ...preparation.facts, attemptCount: 1 }
            };
        };
        return { service, prepare };
    }

    it('promotes without touching stage, epoch or attempts', async () => {
        const { service, prepare } = await createApplyHarness();
        const prepared = await prepare(toApplyPlannedLayoutCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            expectedLayout: IDENTITY
        }));

        const read = await service.read(prepared);
        const computed = service.compute(prepared, read);

        if (computed.outcome !== 'write') {
            throw new Error(`Expected a write, computed ${computed.outcome}`);
        }
        expect(computed.acceptedLayoutPromotion?.acceptedIdentity).toEqual(IDENTITY);
        if (computed.guard.kind !== 'group') {
            throw new Error('applyPlannedLayout must guard the group row');
        }
        expect(computed.guard.value.acceptedLayoutIdentity).toEqual(IDENTITY);
        expect(computed.guard.value.lifecycleState).toBe('active');
        expect(computed.guard.value.formationEpoch).toBe(0);
        expect(computed.guard.value.formationAttemptCount).toBe(0);
    });

    it('rejects a superseded fence as a typed value', async () => {
        const { service, prepare } = await createApplyHarness();
        const prepared = await prepare(toApplyPlannedLayoutCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            expectedLayout: { ...IDENTITY, version: IDENTITY.version + 1 }
        }));

        const computed = service.compute(prepared, await service.read(prepared));

        if (!('receipt' in computed) || computed.receipt.rejection === null) {
            throw new Error('Superseded fence must compute a rejection receipt');
        }
        expect(computed.receipt.rejection).toContain('planned-layout-superseded');
    });

    it('answers an already-applied fence with a no-op success', async () => {
        const { service, prepare } = await createApplyHarness();
        const prepared = await prepare(toApplyPlannedLayoutCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            expectedLayout: IDENTITY
        }));
        const read = await service.read(prepared);
        if (read.group === null) {
            throw new Error('Seeded group must be readable');
        }
        const promoted = { ...read.group.value, acceptedLayoutIdentity: IDENTITY };
        const applied = {
            ...read,
            group: {
                entry: { ...read.group.entry, value: JSON.stringify(promoted) },
                value: promoted
            },
            acceptedLayoutRow: { snapshot: SNAPSHOT, revision: 1 }
        } as typeof read;

        const computed = service.compute(prepared, applied);

        expect(computed.outcome).toBe('no-op');
    });

    it('admits exactly applyPlannedLayout under topology-publication authority', async () => {
        const { prepare } = await createApplyHarness();
        const prepared = await prepare(toApplyPlannedLayoutCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            expectedLayout: IDENTITY
        }));

        expect(() => assertGroupMutationAuthority(prepared.command, prepared.facts))
            .not.toThrow();
    });
});

describe('topology promotion outbox entry', () => {
    it('round-trips the work through the durable entry', () => {
        const entry = computeTopologyPromotionEntry({
            work: { groupRef: GROUP_REF, formationEpoch: 2, expectedLayout: IDENTITY },
            senderId: 'promotion-service',
            createdAtEpochMs: 1_000,
            expireAtEpochMs: 100_000
        });

        expect(entry.key.resourceId.length).toBeLessThanOrEqual(36);
        expect(entry.key.resourceId.startsWith('tp-2-')).toBe(true);
        expect(decodeTopologyPromotionWork(entry.resource)).toEqual({
            groupRef: GROUP_REF,
            formationEpoch: 2,
            expectedLayout: IDENTITY
        });
    });
});
