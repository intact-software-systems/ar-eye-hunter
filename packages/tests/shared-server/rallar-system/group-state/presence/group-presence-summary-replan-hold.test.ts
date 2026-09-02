import { describe, expect, it } from 'vitest';

import type { GroupPresenceSummaryComputedWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-effects.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService } from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();

interface HoldScenarioInput {
    readonly groupId: string;
    readonly preset: 'match' | 'optimistic';
    readonly lifecycleState: GroupLifecycleState;
    readonly plannedLayout: 'active' | 'absent';
}

describe('group presence summary replan hold', () => {
    it('holds the automatic replan of an active commanded group that runs on a planned layout', async () => {
        const computed = await computeSummaryForScenario({
            groupId: 'held-commanded',
            preset: 'match',
            lifecycleState: 'active',
            plannedLayout: 'active'
        });

        expect(computed.coalescedTopologyWork).toBeNull();
    });

    it.each(
        [
            ['an auto policy', { preset: 'optimistic', lifecycleState: 'active', plannedLayout: 'active' }],
            ['a commanded group still forming', { preset: 'match', lifecycleState: 'forming', plannedLayout: 'absent' }],
            ['a commanded group with no planned layout', { preset: 'match', lifecycleState: 'active', plannedLayout: 'absent' }]
        ] as const
    )('enqueues the replan for %s', async (name, scenario) => {
        const computed = await computeSummaryForScenario({ groupId: `enqueued-${name.replaceAll(' ', '-')}`, ...scenario });

        expect(computed.coalescedTopologyWork).not.toBeNull();
    });
});

async function computeSummaryForScenario(input: HoldScenarioInput): Promise<GroupPresenceSummaryComputedWork> {
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
        lifecyclePolicy: resolveGroupLifecyclePolicyPreset(input.preset)
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
    // The stage is written directly: the scenario is about the gate at this stage,
    // not about the transitions that reach it.
    await repository.putGroup({ ...stored.value, lifecycleState: input.lifecycleState });
    if (input.plannedLayout === 'active') {
        await new RtcTopologySnapshotRepository(runtime).commitSnapshot({
            candidate: plannedSnapshot(input.groupId)
        });
    }
    const event = (await repository.listEvents(ref)).find(
        (candidate: GroupEvent) => candidate.eventType === 'session-connected'
    );
    if (!event) {
        throw new Error(`Missing session-connected event: ${input.groupId}`);
    }
    const command: GroupPresenceSummaryWorkData = {
        effectKind: 'group-presence-summary',
        aggregateRef: ref,
        commandId: `${input.groupId}-command`,
        createdAtEpochMs: event.occurredAtEpochMs,
        expireAtEpochMs: 253_402_300_799_999,
        acceptedCausalRevision: event.causalRevision,
        event
    };
    const work = new GroupPresenceSummaryWork({
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        recomputeDebounceMs: 0,
        runtimeRepository: runtime,
        now: () => BASE_EPOCH_MS + 1_000,
        serviceId: 'summary-worker'
    });
    const read = await work.read(command);
    const computed = work.compute(command, read);
    work.validate(command, read, computed);
    return computed;
}

function plannedSnapshot(groupId: string): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 1 },
        state: 'active',
        overlayId: toScopedOverlayId(groupRef(groupId)),
        groupRef: groupRef(groupId),
        name: `${groupId}-overlay`,
        topology: 'tree',
        activeSessionIds: [],
        nextHopsBySessionId: {},
        degreeLimit: 2,
        version: 1,
        createdByClientId: 'replan-hold-test',
        createdAtEpochMs: BASE_EPOCH_MS,
        updatedAtEpochMs: BASE_EPOCH_MS
    };
}
