import { describe, expect, it } from 'vitest';

import type { GroupStateMutationCommand } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { assertGroupMutationAuthority } from '@shared-server/rallar-system/group-state/mutation/command-validation/assert-group-mutation-authority.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { toApplyPlannedLayoutCommand } from '@shared-server/rallar-system/group-state/to-apply-planned-layout-command.ts';
import { computeTopologyPromotionEntry, decodeTopologyPromotionWork } from '@shared-server/rallar-system/group-state/topology-promotion-outbox-entry.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService, type GroupStateTestService } from '../group-state-test-runtime.ts';
import { createAuthorityHarness, createResilience, createRoom, SCOPE } from '../inbox/group-state-inbox-test-runtime.ts';

import {
    computePlannedLayoutPromotion,
    type GroupPlannedLayoutRow
} from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-planned-layout-promotion.ts';
import { toGroupLayoutPromotionEffects } from '@shared-server/rallar-system/group-state/persistence/layout/to-group-layout-promotion-effects.ts';
import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    toStoredRtcTopologySnapshotRow
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

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

/** A replan of the same group at a later presence revision: the plan a late promotion finds in the slot. */
const NEWER_IDENTITY: GroupLayoutIdentity = { ...IDENTITY, presenceRevision: 7, version: 4 };

const NEWER_PLANNED: GroupPlannedLayoutRow = {
    snapshot: {
        ...SNAPSHOT,
        sourceGroupStateCausalRevision: {
            groupRevision: NEWER_IDENTITY.groupRevision,
            presenceRevision: NEWER_IDENTITY.presenceRevision
        },
        version: NEWER_IDENTITY.version,
        activeSessionIds: ['session-a', 'session-b'],
        nextHopsBySessionId: { 'session-a': ['session-b'], 'session-b': ['session-a'] }
    },
    revision: 12
};

interface PlannedLayoutApplyHarness {
    readonly service: GroupStateTestService;
    readonly captureIngress: (command: GroupMutationCommand) => Promise<GroupStateMutationCommand>;
}

describe('computePlannedLayoutPromotion', () => {
    it('applies the stored plan with every accepted fact computed together', () => {
        const promotion = computePlannedLayoutPromotion({
            expectedFormationEpoch: 2,
            expectedLayout: IDENTITY,
            currentFormationEpoch: 2,
            planned: PLANNED,
            acceptedIdentity: null,
            acceptedRow: null,
            supersededFence: 'promote-dominating'
        });

        expect(promotion).toEqual({
            outcome: 'apply',
            promoted: 'expected',
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
            acceptedRow: { snapshot: SNAPSHOT, revision: 8 },
            supersededFence: 'promote-dominating'
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
            name: 'planned-layout-superseded when the stored plan is older than the fence',
            input: {
                expectedFormationEpoch: 2,
                expectedLayout: { ...IDENTITY, version: 4 },
                planned: PLANNED
            },
            outcome: 'planned-layout-superseded'
        }
    ])('computes $name', (row) => {
        const promotion = computePlannedLayoutPromotion({
            currentFormationEpoch: 2,
            acceptedIdentity: null,
            acceptedRow: null,
            supersededFence: 'promote-dominating',
            ...row.input
        });
        expect(promotion.outcome).toBe(row.outcome);
    });

    it('promotes a newer plan that supersedes the fenced one in the same attempt', () => {
        const promotion = computePlannedLayoutPromotion({
            expectedFormationEpoch: 2,
            expectedLayout: IDENTITY,
            currentFormationEpoch: 2,
            planned: NEWER_PLANNED,
            acceptedIdentity: null,
            acceptedRow: null,
            supersededFence: 'promote-dominating'
        });

        expect(promotion).toEqual({
            outcome: 'apply',
            promoted: 'newer',
            acceptedSnapshot: NEWER_PLANNED.snapshot,
            acceptedIdentity: NEWER_IDENTITY,
            acceptedExpectedRevision: null,
            plannedExpectedRevision: 12
        });
    });

    it.each([
        {
            name: 'an older plan',
            planned: { ...PLANNED, snapshot: { ...SNAPSHOT, version: 2 } }
        },
        {
            name: 'an incomparable plan',
            planned: {
                ...PLANNED,
                snapshot: { ...SNAPSHOT, sourceGroupStateCausalRevision: { groupRevision: 3, presenceRevision: 9 } }
            }
        }
    ])('keeps $name as a superseded rejection', ({ planned }) => {
        const promotion = computePlannedLayoutPromotion({
            expectedFormationEpoch: 2,
            expectedLayout: IDENTITY,
            currentFormationEpoch: 2,
            planned,
            acceptedIdentity: null,
            acceptedRow: null,
            supersededFence: 'promote-dominating'
        });
        expect(promotion).toEqual({ outcome: 'planned-layout-superseded' });
    });

    it('keeps a dominating plan superseded when the caller keeps its fence exact', () => {
        const promotion = computePlannedLayoutPromotion({
            expectedFormationEpoch: 2,
            expectedLayout: IDENTITY,
            currentFormationEpoch: 2,
            planned: NEWER_PLANNED,
            acceptedIdentity: null,
            acceptedRow: null,
            supersededFence: 'reject'
        });

        expect(promotion).toEqual({ outcome: 'planned-layout-superseded' });
    });

    it('computes already-applied when the accepted identity matches the plan', () => {
        const promotion = computePlannedLayoutPromotion({
            expectedFormationEpoch: 2,
            expectedLayout: IDENTITY,
            currentFormationEpoch: 2,
            planned: PLANNED,
            acceptedIdentity: IDENTITY,
            acceptedRow: { snapshot: SNAPSHOT, revision: 8 },
            supersededFence: 'promote-dominating'
        });
        expect(promotion.outcome).toBe('already-applied');
    });
});

describe('groupLayoutPromotionEffects', () => {
    it('re-asserts the planned row and inserts the first accepted row atomically', () => {
        const effects = toGroupLayoutPromotionEffects({
            outcome: 'apply',
            promoted: 'expected',
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
            promoted: 'expected',
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
    async function createApplyHarness(planned: GroupPlannedLayoutRow = PLANNED): Promise<PlannedLayoutApplyHarness> {
        const service = createTestGroupStateService({
            runtimeRepository: new FakeRuntimeStateRepository(),
            now: () => 1_000,
            randomId: (() => {
                let generated = 0;
                return () => `apply-id-${++generated}`;
            })(),
            serviceId: 'apply-service',
            readPlannedLayoutRow: async () => planned,
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
        const captureIngress = async (command: GroupMutationCommand): Promise<GroupStateMutationCommand> => {
            const ingress = await service.captureTopologyPublicationMutationIngress(command, 1_000);
            return {
                authorityProof: null,
                descriptor: null,
                command: ingress.command,
                facts: { ...ingress.facts, attemptCount: 1 }
            };
        };
        return { service, captureIngress };
    }

    it('promotes without touching stage, epoch or attempts', async () => {
        const { service, captureIngress } = await createApplyHarness();
        const ingress = await captureIngress(toApplyPlannedLayoutCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            expectedLayout: IDENTITY
        }));

        const read = await service.read(ingress);
        const computed = service.compute(ingress, read);

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

    it('promotes the newer plan a superseded fence finds in the slot, in the same attempt', async () => {
        const { service, captureIngress } = await createApplyHarness(NEWER_PLANNED);
        const ingress = await captureIngress(toApplyPlannedLayoutCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            expectedLayout: IDENTITY
        }));

        const computed = service.compute(ingress, await service.read(ingress));

        if (computed.outcome !== 'write' || computed.guard.kind !== 'group') {
            throw new Error(`Expected a group write, computed ${computed.outcome}`);
        }
        expect(computed.acceptedLayoutPromotion).toMatchObject({ promoted: 'newer', plannedExpectedRevision: 12 });
        expect(computed.guard.value.acceptedLayoutIdentity).toEqual(NEWER_IDENTITY);
    });

    it('rejects a fence newer than the stored plan as a typed value', async () => {
        const { service, captureIngress } = await createApplyHarness();
        const ingress = await captureIngress(toApplyPlannedLayoutCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            expectedLayout: { ...IDENTITY, version: IDENTITY.version + 1 }
        }));

        const computed = service.compute(ingress, await service.read(ingress));

        if (!('receipt' in computed) || computed.receipt.rejection === null) {
            throw new Error('Superseded fence must compute a rejection receipt');
        }
        expect(computed.receipt.rejection).toContain('planned-layout-superseded');
    });

    it('answers an already-applied fence with a no-op success', async () => {
        const { service, captureIngress } = await createApplyHarness();
        const ingress = await captureIngress(toApplyPlannedLayoutCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            expectedLayout: IDENTITY
        }));
        const read = await service.read(ingress);
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

        const computed = service.compute(ingress, applied);

        expect(computed.outcome).toBe('no-op');
    });

    it('admits exactly applyPlannedLayout under topology-publication authority', async () => {
        const { captureIngress } = await createApplyHarness();
        const ingress = await captureIngress(toApplyPlannedLayoutCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            expectedLayout: IDENTITY
        }));

        expect(() => assertGroupMutationAuthority(ingress.command, ingress.facts))
            .not.toThrow();
    });
});

describe('applyPlannedLayout through the inbox lane', () => {
    const LANE_GROUP_REF = { ...SCOPE, groupId: 'lane-promotion-room' };

    interface LanePromotion {
        readonly lines: readonly RallarTimingEvent[];
        readonly acceptedSnapshotStored: boolean;
    }

    /** Stores `planned` as the lane group's planned slot and runs one dequeue pass over the queued promotion. */
    async function promoteThroughLane(
        planned: RallarOverlayTopologySnapshot,
        expectedLayout: GroupLayoutIdentity,
        failAcceptedWrite = false
    ): Promise<LanePromotion> {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const plannedSnapshot = { ...planned, groupRef: LANE_GROUP_REF, overlayId: toScopedOverlayId(LANE_GROUP_REF) };
        const plannedRow = toStoredRtcTopologySnapshotRow(plannedSnapshot);
        const timing: RallarTimingEvent[] = [];
        const harness = await createAuthorityHarness(['owner'], {
            runtimeRepository,
            readPlannedLayoutRow: async () => {
                const entry = await runtimeRepository.findEntry(RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE, plannedRow.key);
                return entry === undefined ? null : { snapshot: plannedSnapshot, revision: entry.revision };
            },
            timing: (event) => {
                timing.push(event);
            }
        });
        await createRoom(harness, LANE_GROUP_REF.groupId, 'Lane promotion room');
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            plannedRow.key,
            plannedRow.value,
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        await harness.service.enqueueTopologyPublicationCommand(
            toApplyPlannedLayoutCommand({ groupRef: LANE_GROUP_REF, formationEpoch: 0, expectedLayout }),
            harness.nowEpochMs
        );
        timing.length = 0;
        if (failAcceptedWrite) {
            const failWrite = (namespace: string) => {
                if (namespace === RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE) {
                    throw new Error('accepted layout write failed inside the transaction');
                }
            };
            runtimeRepository.beforeUpsert = failWrite;
            runtimeRepository.beforeConditionalWrite = (_operation, namespace) => failWrite(namespace);
        }
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        return {
            lines: timing.filter((event) => event.component === 'group-topology-publication'),
            acceptedSnapshotStored: await runtimeRepository.findEntry(RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE, plannedRow.key) !== undefined
        };
    }

    it('promotes a newer plan and reports both identities on one timing line', async () => {
        const promotion = await promoteThroughLane(NEWER_PLANNED.snapshot, IDENTITY);

        expect(promotion.acceptedSnapshotStored).toBe(true);
        expect(promotion.lines).toEqual([
            expect.objectContaining({
                operation: 'promote',
                status: 'ok',
                groupId: LANE_GROUP_REF.groupId,
                details: {
                    expected: 'group=4;presence=6;version=3;state=active',
                    planned: 'group=4;presence=7;version=4;state=active',
                    outcome: 'promoted-newer'
                }
            })
        ]);
    });

    it('reports a promotion only after its transaction commits', async () => {
        const promotion = await promoteThroughLane(NEWER_PLANNED.snapshot, IDENTITY, true);

        expect(promotion.acceptedSnapshotStored).toBe(false);
        expect(promotion.lines).toEqual([]);
    });

    it('reports a fence the stored plan cannot satisfy as a rejected outcome, not an error', async () => {
        const promotion = await promoteThroughLane(SNAPSHOT, { ...IDENTITY, version: 4 });

        expect(promotion.acceptedSnapshotStored).toBe(false);
        expect(promotion.lines).toEqual([
            expect.objectContaining({
                operation: 'promote',
                status: 'ok',
                details: {
                    expected: 'group=4;presence=6;version=4;state=active',
                    planned: 'group=4;presence=6;version=3;state=active',
                    outcome: 'rejected',
                    rejection: 'Planned layout promotion is planned-layout-superseded'
                }
            })
        ]);
    });
});

describe('topology promotion outbox entry', () => {
    it('round-trips the work through the durable entry', () => {
        const entry = computeTopologyPromotionEntry({
            work: { groupRef: GROUP_REF, formationEpoch: 2, expectedLayout: IDENTITY },
            sourceWorkId: 'rtc-topology:promotion-group:work-1',
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
