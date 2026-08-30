import { describe, expect, it, vi, type MockInstance } from 'vitest';

import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { createRtcTopologyOutboxPublisher } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-work.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import type { GroupTopologyPlanningService } from '@shared-server/rallar-system/topology/planning/group-topology-planning-service.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import {
    computeCoalescedRtcTopologyGroupRevisionWork,
    toCoalescedGroupRevisionKey
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { computeExpectedLayoutFence } from '@shared/api/group-lifecycle/compute-expected-layout-fence.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy, GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { EntityStatus, InMemoryQueueBox } from '@shared/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from '../../../app-inbox/test-support/app-inbox-test-database.ts';
import { createTopologyTestGroupSnapshot } from '../../config/mutation/group-topology-config-mutation-test-fixtures.ts';

const NOW = 1_000;

interface CriterionSubmission {
    readonly command: GroupMutationCommand;
    readonly atEpochMs: number;
}

interface CriterionFingerprintFixture {
    current: GroupSnapshot;
    failCommit: boolean;
    readonly effects: string[];
    readonly submitted: CriterionSubmission[];
    readonly queue: InMemoryQueueBox;
    readonly snapshots: RtcTopologySnapshotRepository;
    readonly handler: OnMessageCallback;
    readonly computeTopology: MockInstance<GroupTopologyPlanningService['computeTopologyFromAuthority']>;
    readonly skippedFingerprint: MockInstance<GroupTopologyPlanningService['recordTopologyRebuildSkippedFingerprint']>;
    readonly recordPublication: MockInstance<GroupTopologyPlanningService['recordTopologyPublication']>;
    process(input: ProcessGroupRevisionInput): Promise<ResourceEntry>;
}

describe('formation criterion after unchanged topology inputs', () => {
    it.each(['connecting', 'reconnecting'] as const)(
        'petitions %s after committing the fingerprint skip, without rebuilding the held plan',
        async (stage) => {
            const fixture = createCriterionFingerprintFixture();
            const heldStage = stage === 'connecting' ? 'planned' : 'reconfiguring';
            await fixture.process({ group: lifecycleSnapshot(heldStage, 1), origin: 'commanded' });
            const published = await fixture.snapshots.findSnapshot(fixture.current.group);
            expect(published).toMatchObject({ state: 'active', activeSessionIds: [], version: 1 });
            expect(fixture.submitted).toEqual([]);
            fixture.effects.length = 0;
            fixture.computeTopology.mockClear();
            fixture.recordPublication.mockClear();

            const entry = await fixture.process({ group: lifecycleSnapshot(stage, 2), origin: 'automatic' });

            expect(fixture.skippedFingerprint).toHaveBeenCalledOnce();
            expect(fixture.computeTopology).not.toHaveBeenCalled();
            expect(fixture.recordPublication).not.toHaveBeenCalled();
            expect(await fixture.snapshots.findSnapshot(fixture.current.group)).toEqual(published);
            expect((await fixture.queue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
            expect(fixture.effects).toEqual(['reservation-finish', 'transaction-commit-return', 'petition']);
            expect(fixture.submitted).toEqual([{
                command: expect.objectContaining({
                    operation: 'activateGroup',
                    input: expect.objectContaining({
                        expectedFormationEpoch: 2,
                        expectedLayout: { groupRevision: 1, presenceRevision: 0, version: 1, state: 'active' },
                        observedRate: 1,
                        degraded: false
                    })
                }),
                atEpochMs: NOW
            }]);
        }
    );

    it.each(['forming', 'planned', 'reconfiguring', 'active', 'dormant'] as const)(
        'does not petition a fingerprint-identical %s stage',
        async (stage) => {
            const fixture = createCriterionFingerprintFixture();
            await fixture.process({ group: lifecycleSnapshot('reconfiguring', 1), origin: 'commanded' });

            await fixture.process({ group: lifecycleSnapshot(stage, 2), origin: 'automatic' });

            expect(fixture.skippedFingerprint).toHaveBeenCalledOnce();
            expect(fixture.submitted).toEqual([]);
        }
    );

    it('does not petition when reservation completion rolls back, and evaluates on retry', async () => {
        const fixture = createCriterionFingerprintFixture();
        await fixture.process({ group: lifecycleSnapshot('reconfiguring', 1), origin: 'commanded' });
        fixture.failCommit = true;

        await expect(fixture.process({ group: lifecycleSnapshot('connecting', 2), origin: 'automatic' }))
            .rejects.toThrow('Injected commit failure');

        const reserved = await fixture.queue.getItem(toCoalescedGroupRevisionKey(fixture.current.group));
        expect(reserved?.status).toBe(EntityStatus.RESERVED);
        expect(fixture.submitted).toEqual([]);
        if (reserved === undefined) {
            throw new Error('Retry requires the original reserved entry');
        }
        fixture.failCommit = false;
        await fixture.handler.onMessage(decodePersistedALMessage(reserved.resource), reserved);

        expect(fixture.submitted).toHaveLength(1);
        expect((await fixture.queue.getItem(reserved.key))?.status).toBe(EntityStatus.COMPLETED);
    });

    it.each(['missing', 'removed'] as const)(
        'does not use the cached fingerprint as readiness when the planned row is %s',
        async (state) => {
            const fixture = createCriterionFingerprintFixture();
            await fixture.process({ group: lifecycleSnapshot('reconfiguring', 1), origin: 'commanded' });
            const published = await fixture.snapshots.findSnapshot(fixture.current.group);
            if (published === undefined) {
                throw new Error('Initial work must publish a plan');
            }
            await fixture.snapshots.removeSnapshot(fixture.current.group);
            if (state === 'removed') {
                await fixture.snapshots.commitSnapshot({ candidate: { ...published, state: 'removed' } });
            }
            fixture.computeTopology.mockImplementationOnce(() => {
                throw new Error('Rebuild must complete before criterion evaluation');
            });

            await expect(fixture.process({ group: lifecycleSnapshot('connecting', 2), origin: 'automatic' }))
                .rejects.toThrow('Rebuild must complete before criterion evaluation');

            expect(fixture.skippedFingerprint).not.toHaveBeenCalled();
            expect(fixture.submitted).toEqual([]);
        }
    );

    it('keeps replay identity and the observed epoch/layout fence when later work supersedes it', async () => {
        const fixture = createCriterionFingerprintFixture();
        await fixture.process({ group: lifecycleSnapshot('reconfiguring', 1), origin: 'commanded' });
        await fixture.process({ group: lifecycleSnapshot('connecting', 2), origin: 'automatic' });
        const delayed = await reserveGroupRevision(fixture.queue, {
            group: lifecycleSnapshot('connecting', 2),
            origin: 'automatic'
        });
        fixture.current = lifecycleSnapshot('reconfiguring', 3);
        await fixture.handler.onMessage(decodePersistedALMessage(delayed.resource), delayed);
        expect(fixture.submitted).toHaveLength(2);
        expect(fixture.submitted[0]).toEqual(fixture.submitted[1]);
        const command = fixture.submitted[0]?.command;
        if (command?.operation !== 'activateGroup') {
            throw new Error('Expected an activation petition');
        }
        const { expectedFormationEpoch, expectedLayout } = command.input;
        if (expectedFormationEpoch === null || expectedLayout === null) {
            throw new Error('Activation petition must carry its epoch and layout fence');
        }
        await fixture.process({ group: lifecycleSnapshot('reconfiguring', 3), origin: 'commanded' });
        const currentPlan = await fixture.snapshots.findSnapshot(fixture.current.group);
        if (currentPlan === undefined) {
            throw new Error('Later work must publish a plan');
        }

        expect(computeExpectedLayoutFence({
            expectedFormationEpoch,
            expectedLayout,
            currentFormationEpoch: fixture.current.group.formationEpoch,
            currentPlannedLayout: toGroupLayoutIdentity(currentPlan)
        })).toBe('stale-epoch');
        expect(computeExpectedLayoutFence({
            expectedFormationEpoch,
            expectedLayout,
            currentFormationEpoch: 2,
            currentPlannedLayout: toGroupLayoutIdentity(currentPlan)
        })).toBe('planned-layout-superseded');
    });
});

function lifecycleSnapshot(stage: GroupLifecycleState, revision: number): GroupSnapshot {
    const base = createTopologyTestGroupSnapshot();
    return {
        ...base,
        causalRevision: { groupRevision: revision, presenceRevision: 0 },
        group: {
            ...base.group,
            snapshotVersion: revision,
            metadataVersion: revision,
            lifecycleState: stage,
            formationEpoch: revision,
            establishmentStartedAtEpochMs: stage === 'connecting' || stage === 'reconnecting' ? 500 : null
        }
    };
}

function createCriterionFingerprintFixture(): CriterionFingerprintFixture {
    const queue = new InMemoryQueueBox();
    const repository = new FakeRuntimeStateRepository();
    const snapshots = new RtcTopologySnapshotRepository(repository);
    const state = {
        current: lifecycleSnapshot('reconfiguring', 1),
        failCommit: false,
        effects: [] as string[],
        submitted: [] as CriterionSubmission[]
    };
    const planning = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: () => state.current,
        readCurrentGroupSnapshot: async () => state.current,
        readRttMeasurements: () => [],
        topologyService: new RallarRtcTopologyService({ now: () => NOW }),
        topologySnapshotRepository: snapshots
    }).planning;
    const computeTopology = vi.spyOn(planning, 'computeTopologyFromAuthority');
    const skippedFingerprint = vi.spyOn(planning, 'recordTopologyRebuildSkippedFingerprint');
    const recordPublication = vi.spyOn(planning, 'recordTopologyPublication');
    const runtime = createRtcTopologyOutboxPublisher({ outboxQueueReader: new OutboxQueueReader(queue) });
    const database = createAppInboxTestDatabase(queue, { replace: async (entry) => entry }, {
        runtimeRepository: repository,
        onStage: (stage) => {
            state.effects.push(stage);
            if (stage === 'transaction-commit-return' && state.failCommit) {
                throw new Error('Injected commit failure');
            }
        }
    });
    const handler = createRtcTopologyWorkHandler({
        runtime,
        database,
        topologyPlanning: planning,
        executionRepository: new RtcTopologyExecutionRepository(repository),
        formationCriterion: {
            deferred: { minIntervalMs: 0, nowEpochMs: () => NOW, schedule: vi.fn() },
            readLifecyclePolicy: async () => ({ status: 'present', policy: thresholdPolicy() }),
            submitCommand: async (command, atEpochMs) => {
                state.effects.push('petition');
                state.submitted.push({ command, atEpochMs });
            }
        }
    });
    const process = async (input: ProcessGroupRevisionInput): Promise<ResourceEntry> => {
        state.current = input.group;
        const entry = await reserveGroupRevision(queue, input);
        await handler.onMessage(decodePersistedALMessage(entry.resource), entry);
        return entry;
    };
    return Object.assign(state, { queue, snapshots, handler, computeTopology, skippedFingerprint, recordPublication, process });
}

interface ProcessGroupRevisionInput {
    readonly group: GroupSnapshot;
    readonly origin: 'automatic' | 'commanded';
}

async function reserveGroupRevision(queue: InMemoryQueueBox, input: ProcessGroupRevisionInput): Promise<ResourceEntry> {
    const work = computeCoalescedRtcTopologyGroupRevisionWork({
        aggregateRef: input.group.group,
        groupSnapshot: input.group,
        origin: input.origin,
        requestedAtEpochMs: NOW,
        expireAtEpochMs: 4_000_000_000_000,
        recomputeDebounceMs: 0,
        senderId: 'criterion-server',
        previousEntry: await queue.getItem(toCoalescedGroupRevisionKey(input.group.group)) ?? null
    });
    const entry = { ...work.entry, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } };
    await queue.enqueue(entry);
    return entry;
}

function thresholdPolicy(): GroupLifecyclePolicy {
    return {
        ...createDefaultGroupLifecyclePolicy(),
        activation: {
            mode: 'threshold' as const,
            successRate: 1,
            minimumViableRate: 0,
            deadlineMs: 0,
            maxFormationAttempts: 1,
            strictConfirmation: false
        }
    };
}
