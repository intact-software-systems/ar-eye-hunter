import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { GroupSystemCommandSubmission } from '@shared-server/rallar-system/group-state/inbox/group-system-command-submission.ts';
import {
    GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
    GroupConnectTriggerLatchRepository,
    toGroupConnectTriggerStorageKey
} from '@shared-server/rallar-system/group-state/persistence/group-connect-trigger-latch-repository.ts';
import { computeRtcTopologyOutboxInsert } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
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
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import { toCanonicalGroupRef, type GroupSnapshot } from '@shared/api/group-types.ts';
import { EntityStatus, InMemoryQueueBox } from '@shared/mod.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from '../../../app-inbox/test-support/app-inbox-test-database.ts';
import { createTopologyTestGroupSnapshot } from '../../config/mutation/group-topology-config-mutation-test-fixtures.ts';
import { createRtcTopologyGroupSnapshot } from '../../rtc-topology-test-fixtures.ts';

const NOW = 1_000;

interface CriterionFingerprintFixtureOptions {
    readonly durationNowMs?: () => number;
    /** Installs formation automation, so a presence plan trigger of this policy petitions through the cycle. */
    readonly phasedPolicy?: GroupLifecyclePolicy;
}

interface CriterionFingerprintFixture {
    current: GroupSnapshot;
    failCommit: boolean;
    readonly effects: string[];
    readonly submitted: GroupSystemCommandSubmission[];
    readonly automated: GroupSystemCommandSubmission[];
    readonly queue: InMemoryQueueBox;
    readonly snapshots: RtcTopologySnapshotRepository;
    readonly topologyService: RallarRtcTopologyService;
    readonly handler: OnMessageCallback;
    readonly runtime: FakeRuntimeStateRepository;
    process(input: ProcessGroupRevisionInput): Promise<ResourceEntry>;
}

describe('formation criterion after unchanged topology inputs', () => {
    it.each(['connecting', 'reconnecting'] as const)(
        'petitions %s after committing the fingerprint skip, without rebuilding the held plan',
        async (stage) => {
            const fixture = createCriterionFingerprintFixture();
            const heldStage = stage === 'connecting' ? 'planned' : 'reconfiguring';
            await fixture.process({ group: lifecycleSnapshot(heldStage, 1), origin: 'commanded', traceId: 'trace-revision-1' });
            const published = await fixture.snapshots.findSnapshot(fixture.current.group);
            expect(published).toMatchObject({ state: 'active', activeSessionIds: [], version: 1 });
            expect(fixture.submitted).toEqual([]);
            fixture.effects.length = 0;
            const metricsBefore = fixture.topologyService.readMetrics();

            const entry = await fixture.process({ group: lifecycleSnapshot(stage, 2), origin: 'automatic', traceId: 'trace-revision-2' });

            const metricsAfter = fixture.topologyService.readMetrics();
            expect(metricsAfter.topologyRebuildSkippedFingerprintCount)
                .toBe(metricsBefore.topologyRebuildSkippedFingerprintCount + 1);
            expect(metricsAfter.topologyUpdateCount).toBe(metricsBefore.topologyUpdateCount);
            expect(metricsAfter.topologyPublishAttemptCount)
                .toBe(metricsBefore.topologyPublishAttemptCount);
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
                atEpochMs: NOW,
                traceId: 'trace-revision-2'
            }]);
        }
    );

    it('petitions a met presence trigger under the work row trace after a committed publication', async () => {
        const fixture = createCriterionFingerprintFixture({ phasedPolicy: presencePlanPolicy() });

        await fixture.process({ group: presentFormingSnapshot(1), origin: 'commanded', traceId: 'trace-revision-1' });

        expect(fixture.automated.map(({ command, traceId }) => ({ operation: command.operation, traceId })))
            .toEqual([{ operation: 'planGroupLayout', traceId: 'trace-revision-1' }]);
    });

    it('petitions a met presence trigger under the work row trace when the stored plan stays unchanged', async () => {
        const fixture = createCriterionFingerprintFixture({ phasedPolicy: presencePlanPolicy() });
        await fixture.process({ group: presentFormingSnapshot(1), origin: 'commanded', traceId: 'trace-revision-1' });
        fixture.automated.length = 0;

        await fixture.process({ group: presentFormingSnapshot(2), origin: 'automatic', traceId: 'trace-revision-2' });

        expect(fixture.topologyService.readMetrics().topologyPublishSkippedUnchangedCount).toBe(1);
        expect(fixture.automated.map((submission) => submission.traceId)).toEqual(['trace-revision-2']);
    });

    it('petitions a met presence trigger under the work row trace when a newer plan supersedes the work', async () => {
        const fixture = createCriterionFingerprintFixture({ phasedPolicy: presenceConnectPolicy() });
        const newer = presentSnapshot('planned', 2);
        await fixture.runtime.upsert(
            GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
            toGroupConnectTriggerStorageKey({ groupRef: toCanonicalGroupRef(newer.group), formationEpoch: 0, triggerGeneration: 'plan-1' }),
            JSON.stringify({
                groupRef: toCanonicalGroupRef(newer.group),
                formationEpoch: 0,
                triggerGeneration: 'plan-1',
                notBeforeEpochMs: 0,
                supersedesLayoutIdentity: null,
                state: 'awaiting-publication'
            }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        await fixture.process({ group: newer, origin: 'commanded', traceId: 'trace-newer-plan' });
        fixture.automated.length = 0;
        fixture.current = presentSnapshot('planned', 1);
        const unpublished = await reserveUnpublishedRevision(fixture.queue, fixture.current, 'trace-unpublished-revision-1');

        await fixture.handler.onMessage(decodePersistedALMessage(unpublished.resource), unpublished);

        expect(await fixture.snapshots.findSnapshot(fixture.current.group))
            .toMatchObject({ state: 'active', sourceGroupStateCausalRevision: { groupRevision: 2 } });
        expect(fixture.automated.map(({ command, traceId }) => ({ operation: command.operation, traceId })))
            .toEqual([{ operation: 'connectGroup', traceId: 'trace-unpublished-revision-1' }]);
    });

    it('persists the supplied wall-clock instant when topology work completes', async () => {
        const fixture = createCriterionFingerprintFixture();

        const entry = await fixture.process({ group: lifecycleSnapshot('reconfiguring', 1), origin: 'commanded', traceId: 'trace-revision-1' });

        const completed = await fixture.queue.getItem(entry.key);
        expect(completed?.status).toBe(EntityStatus.COMPLETED);
        expect(completed?.dequeueAudit.endTs?.toString()).toBe('1970-01-01T00:00:01Z');
    });

    it('applies computed planning metrics only after the topology transaction commits', async () => {
        const times = [10, 17, 20, 28];
        const fixture = createCriterionFingerprintFixture({ durationNowMs: () => times.shift() ?? 28 });
        fixture.failCommit = true;

        await expect(fixture.process({ group: lifecycleSnapshot('reconfiguring', 1), origin: 'commanded', traceId: 'trace-revision-1' }))
            .rejects.toThrow('Injected commit failure');

        expect(fixture.topologyService.readMetrics()).toMatchObject({
            topologyUpdateCount: 0,
            topologyWorkComputeDurationMs: 0
        });
        const reserved = await fixture.queue.getItem(toCoalescedGroupRevisionKey(fixture.current.group));
        if (reserved === undefined) {
            throw new Error('Retry requires the original reserved entry');
        }

        fixture.failCommit = false;
        await fixture.handler.onMessage(decodePersistedALMessage(reserved.resource), reserved);

        expect(fixture.topologyService.readMetrics()).toMatchObject({
            topologyUpdateCount: 1,
            topologyWorkComputeDurationMs: 8,
            updatesWithoutRttMeasurementCount: 1,
            starPlanCount: 1,
            topologyChangedCount: 1
        });
    });

    it.each(['forming', 'planned', 'reconfiguring', 'active', 'dormant'] as const)(
        'does not petition a fingerprint-identical %s stage',
        async (stage) => {
            const fixture = createCriterionFingerprintFixture();
            await fixture.process({ group: lifecycleSnapshot('reconfiguring', 1), origin: 'commanded', traceId: 'trace-revision-1' });

            await fixture.process({ group: lifecycleSnapshot(stage, 2), origin: 'automatic', traceId: 'trace-revision-2' });

            expect(fixture.topologyService.readMetrics().topologyRebuildSkippedFingerprintCount).toBe(1);
            expect(fixture.submitted).toEqual([]);
        }
    );

    it('does not petition when reservation completion rolls back, and evaluates on retry', async () => {
        const fixture = createCriterionFingerprintFixture();
        await fixture.process({ group: lifecycleSnapshot('reconfiguring', 1), origin: 'commanded', traceId: 'trace-revision-1' });
        fixture.failCommit = true;

        await expect(fixture.process({ group: lifecycleSnapshot('connecting', 2), origin: 'automatic', traceId: 'trace-revision-2' }))
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
            await fixture.process({ group: lifecycleSnapshot('reconfiguring', 1), origin: 'commanded', traceId: 'trace-revision-1' });
            const published = await fixture.snapshots.findSnapshot(fixture.current.group);
            if (published === undefined) {
                throw new Error('Initial work must publish a plan');
            }
            await fixture.snapshots.removeSnapshot(fixture.current.group);
            if (state === 'removed') {
                await fixture.snapshots.commitSnapshot({ candidate: { ...published, state: 'removed' } });
            }
            await fixture.process({ group: lifecycleSnapshot('connecting', 2), origin: 'automatic', traceId: 'trace-revision-2' });

            expect(fixture.topologyService.readMetrics().topologyRebuildSkippedFingerprintCount).toBe(0);
            expect(await fixture.snapshots.findSnapshot(fixture.current.group)).toMatchObject({
                state: 'active',
                sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 0 }
            });
            expect(fixture.submitted.map((submission) => submission.traceId)).toEqual(['trace-revision-2']);
        }
    );

    it('plans a delayed membership change from the current group, so a superseded stage petitions nothing (D290)', async () => {
        const fixture = createCriterionFingerprintFixture();
        await fixture.process({ group: lifecycleSnapshot('reconfiguring', 1), origin: 'commanded', traceId: 'trace-revision-1' });
        await fixture.process({ group: lifecycleSnapshot('connecting', 2), origin: 'automatic', traceId: 'trace-revision-2' });
        const delayed = await reserveGroupRevision(fixture.queue, {
            group: lifecycleSnapshot('connecting', 2),
            origin: 'automatic',
            traceId: 'trace-delayed-revision-2'
        });
        expect(fixture.submitted).toHaveLength(1);
        fixture.submitted.length = 0;
        fixture.current = lifecycleSnapshot('reconfiguring', 3);

        await fixture.handler.onMessage(decodePersistedALMessage(delayed.resource), delayed);

        // The row names revision 2, but the group has moved on to a reconfigure: no activation
        // petition is built from the connecting stage the row was queued under.
        expect(fixture.submitted).toEqual([]);
        expect((await fixture.queue.getItem(delayed.key))?.status).toBe(EntityStatus.COMPLETED);
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
            presenceVersion: 0,
            lifecycleState: stage,
            formationEpoch: revision,
            establishmentStartedAtEpochMs: stage === 'connecting' || stage === 'reconnecting' ? 500 : null
        }
    };
}

function createCriterionFingerprintFixture(
    options: CriterionFingerprintFixtureOptions = {}
): CriterionFingerprintFixture {
    const durationNowMs = options.durationNowMs ?? (() => 0);
    const policy = options.phasedPolicy ?? thresholdPolicy();
    const queue = new InMemoryQueueBox();
    const repository = new FakeRuntimeStateRepository();
    const snapshots = new RtcTopologySnapshotRepository(repository);
    const state = {
        current: lifecycleSnapshot('reconfiguring', 1),
        failCommit: false,
        effects: [] as string[],
        submitted: [] as GroupSystemCommandSubmission[],
        automated: [] as GroupSystemCommandSubmission[]
    };
    const topologyService = new RallarRtcTopologyService({ rttReplanMinimumLayoutAgeMs: 15_000, now: () => NOW, durationNowMs });
    const planning = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: () => state.current,
        readCurrentGroupSnapshot: async () => state.current,
        readRttMeasurements: () => [],
        topologyService,
        topologySnapshotRepository: snapshots
    }).planning;
    const outboxQueueReader = new OutboxQueueReader(queue);
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
        nowEpochMs: () => NOW,
        finishedRetentionMs: 3_600_000,
        outboxQueueReader,
        database,
        topologyPlanning: planning,
        executionRepository: new RtcTopologyExecutionRepository(repository),
        formationCriterion: {
            deferred: { minIntervalMs: 0, nowEpochMs: () => NOW, schedule: vi.fn() },
            readLifecyclePolicy: async () => ({ status: 'present', policy }),
            submitCommand: async (submission) => {
                state.effects.push('petition');
                state.submitted.push(submission);
            }
        },
        formationAutomation: options.phasedPolicy === undefined ? undefined : {
            latches: new GroupConnectTriggerLatchRepository(repository),
            readGroup: async () => state.current.group,
            readPlanned: async (ref) => await snapshots.findSnapshot(ref) ?? null,
            submitCommand: async (submission) => {
                state.automated.push(submission);
            },
            nowEpochMs: () => NOW
        }
    });
    const process = async (input: ProcessGroupRevisionInput): Promise<ResourceEntry> => {
        state.current = input.group;
        const entry = await reserveGroupRevision(queue, input);
        await handler.onMessage(decodePersistedALMessage(entry.resource), entry);
        return entry;
    };
    return Object.assign(state, {
        runtime: repository,
        queue,
        snapshots,
        topologyService,
        handler,
        process
    });
}

interface ProcessGroupRevisionInput {
    readonly group: GroupSnapshot;
    readonly origin: 'automatic' | 'commanded';
    /** Each work row's own trace, so a pin names the row its petition came from. */
    readonly traceId: string;
}

async function reserveGroupRevision(queue: InMemoryQueueBox, input: ProcessGroupRevisionInput): Promise<ResourceEntry> {
    const work = computeCoalescedRtcTopologyGroupRevisionWork({
        traceId: input.traceId,
        aggregateRef: input.group.group,
        groupSnapshot: input.group,
        origin: input.origin,
        requestedAtEpochMs: NOW,
        expireAtEpochMs: 4_000_000_000_000,
        timing: { window: { debounceMs: 0, maxWaitMs: 0 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
        senderId: 'criterion-server',
        previousEntry: await queue.getItem(toCoalescedGroupRevisionKey(input.group.group)) ?? null
    });
    const entry = { ...work.entryWrite.entry, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } };
    await queue.enqueue(entry);
    return entry;
}

function presencePlanPolicy(): GroupLifecyclePolicy {
    const threshold = thresholdPolicy();
    return {
        ...threshold,
        formation: 'phased',
        establishment: {
            ...threshold.establishment,
            planTrigger: { kind: 'presence', memberCount: 2, fallbackMs: 60_000 },
            connectTrigger: { kind: 'manual' }
        }
    };
}

function presenceConnectPolicy(): GroupLifecyclePolicy {
    const threshold = thresholdPolicy();
    return {
        ...threshold,
        formation: 'phased',
        establishment: {
            ...threshold.establishment,
            planTrigger: { kind: 'manual' },
            connectTrigger: { kind: 'presence', memberCount: 2, fallbackMs: 60_000 }
        }
    };
}

function presentFormingSnapshot(revision: number): GroupSnapshot {
    return presentSnapshot('forming', revision);
}

/** Two members with live presence: a presence trigger's threshold is met. */
function presentSnapshot(stage: GroupLifecycleState, revision: number): GroupSnapshot {
    const present = createRtcTopologyGroupSnapshot('presence-room', ['session-a', 'session-b']);
    return {
        ...present,
        causalRevision: { groupRevision: revision, presenceRevision: 0 },
        group: {
            ...present.group,
            snapshotVersion: revision,
            metadataVersion: revision,
            lifecycleState: stage,
            formationEpoch: 0,
            formationAttemptCount: 0
        }
    };
}

/** A commanded recompute that publishes nothing: a stale candidate for it is superseded rather than republished. */
async function reserveUnpublishedRevision(
    queue: InMemoryQueueBox,
    group: GroupSnapshot,
    traceId: string
): Promise<ResourceEntry> {
    const resourceId = `unpublished:${group.causalRevision.groupRevision}`;
    const work = computeRtcTopologyOutboxInsert({
        traceId,
        commandId: resourceId,
        resourceId,
        aggregateRef: toCanonicalGroupRef(group.group),
        acceptedCausalRevision: group.causalRevision,
        groupSnapshot: group,
        effectKind: 'rtc-topology-recompute',
        payloadKind: 'group-revision',
        origin: 'commanded',
        createdAtEpochMs: NOW,
        expireAtEpochMs: 4_000_000_000_000,
        senderId: 'criterion-server',
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        publish: false
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
