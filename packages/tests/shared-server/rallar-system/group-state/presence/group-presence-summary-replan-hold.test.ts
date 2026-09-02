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
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService } from './group-presence-test-runtime.ts';

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
}

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
            aggregateRef: seeded.ref,
            groupSnapshot: before.snapshot,
            requestedAtEpochMs: BASE_EPOCH_MS,
            expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
            timing: { window: { debounceMs: 500, maxWaitMs: 5_000 }, replanNotBeforeEpochMs: null },
            senderId: 'reconfigure',
            origin: 'commanded',
            previousEntry: null
        });
        await seeded.queueBox.enqueue(commandedHead.entry);

        const merged = await readComputedSummary(seeded);

        expect(merged.topologyReplan.decision).toBe('enqueue');
        if (merged.topologyReplan.decision !== 'enqueue') {
            throw new Error('unreachable');
        }
        expect(merged.topologyReplan.work.expectedEntry?.key).toEqual(commandedHead.entry.key);
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
        actorPrincipalId: 'bob',
        expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
        requestId: `connect-${input.groupId}-bob`
    });
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
        expiresAtEpochMs: input.expiresAtEpochMs ?? stored.value.expiresAtEpochMs
    });
    await seedPlannedLayout(runtime, ref, input.plannedLayout);
    const event = (await repository.listEvents(ref)).find(
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

async function readComputedSummary(seeded: SeededScenario): Promise<GroupPresenceSummaryComputedWork> {
    const work = new GroupPresenceSummaryWork({
        outboxQueueReader: new OutboxQueueReader(seeded.queueBox),
        recomputeDebounceMs: 0,
        runtimeRepository: seeded.runtime,
        now: () => BASE_EPOCH_MS + 1_000,
        serviceId: 'summary-worker'
    });
    const read = await work.read(seeded.command);
    const computed = work.compute(seeded.command, read);
    work.validate(seeded.command, read, computed);
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
