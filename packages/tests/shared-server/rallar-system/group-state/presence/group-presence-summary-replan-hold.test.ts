import { describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import type {
    GroupPresenceSummaryComputedWork
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-effects.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import {
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import {
    computeCoalescedRtcTopologyGroupRevisionWork
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy, GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService, readSummaryWork, toSummaryExpansion } from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();
const PLANNED_IDENTITY: GroupLayoutIdentity = { groupRevision: 1, presenceRevision: 1, version: 1, state: 'active' };
const MATCH = resolveGroupLifecyclePolicyPreset('match');

interface HoldScenario {
    readonly groupId: string;
    readonly policy: GroupLifecyclePolicy;
    readonly lifecycleState: GroupLifecycleState;
    /** Passed once the group expires, for the inactive case; the summary runs at BASE_EPOCH_MS + 1 000. */
    readonly expiresAtEpochMs?: number;
    readonly plannedLayout: 'active' | 'absent' | 'corrupt';
    /** A capacity the seeded roster fills, with the owner's session connected too; absent leaves the group unbounded. */
    readonly fullAtMaxMembers?: number;
}

interface ServerReplanWindow {
    readonly recomputeDebounceMs: number;
    readonly recomputeMaxWaitMs: number;
}

const SERVER_WINDOW: ServerReplanWindow = { recomputeDebounceMs: 500, recomputeMaxWaitMs: 2_000 };

interface SeededScenario {
    readonly runtime: GroupBarrierRepository;
    readonly queueBox: InMemoryQueueBox;
    readonly ref: GroupRef;
    readonly command: GroupPresenceSummaryWorkData;
}

describe('group presence summary replan hold', () => {
    it('holds the automatic replan of an active commanded group that runs on its planned layout', async () => {
        const seeded = await seedScenario({
            groupId: 'held-commanded',
            policy: MATCH,
            lifecycleState: 'active',
            plannedLayout: 'active'
        });

        expect((await readComputedSummary(seeded)).topologyReplan).toEqual({ decision: 'held-by-policy' });
    });

    it.each(
        [
            [
                'an auto policy',
                { policy: resolveGroupLifecyclePolicyPreset('optimistic'), lifecycleState: 'active', plannedLayout: 'active' }
            ],
            ['a commanded group still forming', { policy: MATCH, lifecycleState: 'forming', plannedLayout: 'absent' }],
            ['a commanded group with no planned layout', { policy: MATCH, lifecycleState: 'active', plannedLayout: 'absent' }],
            [
                'an expired commanded group, which must publish its removal',
                { policy: MATCH, lifecycleState: 'active', plannedLayout: 'active', expiresAtEpochMs: BASE_EPOCH_MS + 500 }
            ],
            [
                'a corrupt planned row, which the planner reports itself',
                { policy: MATCH, lifecycleState: 'active', plannedLayout: 'corrupt' }
            ]
        ] as const
    )('enqueues the replan for %s', async (name, scenario) => {
        const seeded = await seedScenario({ groupId: `enqueued-${name.replaceAll(/[^a-z]+/g, '-')}`, ...scenario });

        expect((await readComputedSummary(seeded)).topologyReplan.decision).toBe('enqueue');
    });

    it('keeps merging a held delta into the commanded row already queued', async () => {
        const seeded = await seedScenario({
            groupId: 'merged-into-commanded-head',
            policy: MATCH,
            lifecycleState: 'active',
            plannedLayout: 'active'
        });
        const before = await readComputedSummary(seeded);
        expect(before.topologyReplan).toEqual({ decision: 'held-by-policy' });
        const commandedHead = computeCoalescedRtcTopologyGroupRevisionWork({
            traceId: 'trace-group-presence-summary-replan-hold',
            aggregateRef: seeded.ref,
            groupSnapshot: before.snapshot,
            requestedAtEpochMs: BASE_EPOCH_MS,
            expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
            timing: { window: { debounceMs: 500, maxWaitMs: 5_000 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
            senderId: 'reconfigure',
            origin: 'commanded',
            previousEntry: null
        });
        await seeded.queueBox.enqueue(commandedHead.entryWrite.entry);

        const merged = await readComputedSummary(seeded);

        expect(merged.topologyReplan.decision).toBe('enqueue');
        if (merged.topologyReplan.decision !== 'enqueue') {
            throw new Error('unreachable');
        }
        expect(merged.topologyReplan.work.expectedEntry?.key).toEqual(commandedHead.entryWrite.entry.key);
    });

    it('bounds an auto group\'s merge into a pending replan by the server maximum wait', async () => {
        const seeded = await seedScenario({
            groupId: 'bounded-auto-merge',
            policy: resolveGroupLifecyclePolicyPreset('optimistic'),
            lifecycleState: 'active',
            plannedLayout: 'absent'
        });
        const before = await readComputedSummary(seeded, SERVER_WINDOW);
        // A head whose series opened 4 s before the summary and whose due time still lies ahead of it.
        const pendingHead = computeCoalescedRtcTopologyGroupRevisionWork({
            traceId: 'trace-group-presence-summary-replan-hold',
            aggregateRef: seeded.ref,
            groupSnapshot: before.snapshot,
            requestedAtEpochMs: BASE_EPOCH_MS - 3_000,
            expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
            timing: { window: { debounceMs: 4_500, maxWaitMs: 60_000 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
            senderId: 'summary-worker',
            origin: 'automatic',
            previousEntry: null
        });
        await seeded.queueBox.enqueue(pendingHead.entryWrite.entry);

        const merged = await readComputedSummary(seeded, SERVER_WINDOW);

        if (merged.topologyReplan.decision !== 'enqueue') {
            throw new Error('Expected the auto group to enqueue its replan');
        }
        expect(merged.topologyReplan.work.expectedEntry?.key).toEqual(pendingHead.entryWrite.entry.key);
        expect(merged.topologyReplan.work.entryWrite.entry.status).toBe(EntityStatus.NEW);
        expect(merged.topologyReplan.work.entryWrite.entry.dequeueAudit.nextTs).toBeUndefined();
    });

    it.each(
        [
            ['makes the replan due at once when the present members fill the group\'s capacity', 2, EntityStatus.NEW],
            ['keeps the debounce while the group has no expected member count', undefined, EntityStatus.RETRY]
        ] as const
    )('%s', async (name, fullAtMaxMembers, status) => {
        const seeded = await seedScenario({
            groupId: `expected-count-${fullAtMaxMembers ?? 'unbounded'}`,
            policy: resolveGroupLifecyclePolicyPreset('optimistic'),
            lifecycleState: 'active',
            plannedLayout: 'absent',
            ...(fullAtMaxMembers === undefined ? {} : { fullAtMaxMembers })
        });

        const computed = await readComputedSummary(seeded, SERVER_WINDOW);

        if (computed.topologyReplan.decision !== 'enqueue') {
            throw new Error(`Expected the auto group to enqueue its replan: ${name}`);
        }
        expect(computed.snapshot.onlineMemberCount).toBe(fullAtMaxMembers ?? 1);
        expect(computed.topologyReplan.work.entryWrite.entry.status).toBe(status);
    });
});

async function seedScenario(input: HoldScenario): Promise<SeededScenario> {
    const runtime = new GroupBarrierRepository();
    const service = createService(runtime, BASE_EPOCH_MS);
    const ref = groupRef(input.groupId);
    await service.createGroup(SCOPE, {
        groupId: input.groupId,
        displayName: input.groupId,
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: `seed-${input.groupId}`,
        lifecyclePolicy: input.policy
    });
    await service.upsertMember(SCOPE, input.groupId, 'bob', {
        status: 'active',
        actorPrincipalId: 'alice',
        requestId: `activate-${input.groupId}-bob`
    });
    await service.connectPresenceSession(SCOPE, input.groupId, `${input.groupId}-bob-session`, {
        principalId: 'bob',
        generationId: `${input.groupId}-bob-generation`,
        connectionGenerationId: `${input.groupId}-bob-ws-generation`,
        actorPrincipalId: 'bob',
        expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
        requestId: `connect-${input.groupId}-bob`
    });
    if (input.fullAtMaxMembers !== undefined) {
        await service.connectPresenceSession(SCOPE, input.groupId, `${input.groupId}-alice-session`, {
            principalId: 'alice',
            generationId: `${input.groupId}-alice-generation`,
            connectionGenerationId: `${input.groupId}-alice-ws-generation`,
            actorPrincipalId: 'alice',
            expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
            requestId: `connect-${input.groupId}-alice`
        });
    }
    const repository = createTestGroupStateRepository(runtime);
    const stored = await repository.findGroupEntry(ref);
    if (!stored) {
        throw new Error(`Missing group: ${input.groupId}`);
    }
    // The stage and layout facts are written directly: the scenarios are about the
    // gate over those facts, not about the transitions that reach them.
    await repository.putGroup({
        ...stored.value,
        lifecycleState: input.lifecycleState,
        acceptedLayoutIdentity: PLANNED_IDENTITY,
        expiresAtEpochMs: input.expiresAtEpochMs ?? stored.value.expiresAtEpochMs,
        maxMembers: input.fullAtMaxMembers ?? stored.value.maxMembers
    });
    await seedPlannedLayout(runtime, ref, input.plannedLayout);
    const event = (await repository.listEvents(ref)).findLast(
        (candidate: GroupEvent) => candidate.eventType === 'session-connected'
    );
    if (!event) {
        throw new Error(`Missing session-connected event: ${input.groupId}`);
    }
    return {
        runtime,
        queueBox: new InMemoryQueueBox(),
        ref,
        command: {
            effectKind: 'group-presence-summary',
            aggregateRef: ref,
            commandId: `${input.groupId}-command`,
            createdAtEpochMs: event.occurredAtEpochMs,
            expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
            acceptedCausalRevision: event.causalRevision,
            event
        }
    };
}

async function seedPlannedLayout(
    runtime: GroupBarrierRepository,
    ref: GroupRef,
    plannedLayout: HoldScenario['plannedLayout']
): Promise<void> {
    if (plannedLayout === 'active') {
        await new RtcTopologySnapshotRepository(runtime).commitSnapshot({ candidate: plannedSnapshot(ref) });
    }
    if (plannedLayout === 'corrupt') {
        await runtime.upsert(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            groupStateGroupStorageKey(ref),
            JSON.stringify({ broken: true }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
    }
}

async function readComputedSummary(
    seeded: SeededScenario,
    window: ServerReplanWindow = { recomputeDebounceMs: 0, recomputeMaxWaitMs: 0 }
): Promise<GroupPresenceSummaryComputedWork> {
    const work = new GroupPresenceSummaryWork({
        outboxQueueReader: new OutboxQueueReader(seeded.queueBox),
        ...window,
        runtimeRepository: seeded.runtime,
        now: () => BASE_EPOCH_MS + 1_000,
        serviceId: 'summary-worker'
    });
    const read = await readSummaryWork(work, seeded.command, BASE_EPOCH_MS + 1_000);
    const expansion = toSummaryExpansion(seeded.command, read);
    const computed = work.compute(expansion);
    expect(work.validate(expansion, computed)).toEqual([]);
    return computed;
}

function plannedSnapshot(ref: GroupRef): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: PLANNED_IDENTITY.groupRevision,
            presenceRevision: PLANNED_IDENTITY.presenceRevision
        },
        state: 'active',
        overlayId: toScopedOverlayId(ref),
        groupRef: ref,
        name: `${ref.groupId}-overlay`,
        topology: 'tree',
        activeSessionIds: [],
        nextHopsBySessionId: {},
        degreeLimit: 2,
        version: PLANNED_IDENTITY.version,
        createdByClientId: 'replan-hold-test',
        createdAtEpochMs: BASE_EPOCH_MS,
        updatedAtEpochMs: BASE_EPOCH_MS
    };
}
