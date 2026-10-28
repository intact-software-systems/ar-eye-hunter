import { describe, expect, it } from 'vitest';

import { computeGroupPresenceSummaryCoalescedWrite } from '@shared-server/rallar-system/group-state/presence/compute-group-presence-summary-coalesced-write.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService, seedOpenGroup, summaryReservationRead, toSummaryExpansion } from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();
const GROUP_ID = 'commanded-coalesced-room';

describe('group presence summary coalesced write', () => {
    it('gives the replan successor the commanded expansion\'s origin and revision when it is not the last', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, GROUP_ID);
        const eventsBefore = (await createTestGroupStateRepository(runtime).listEvents(groupRef(GROUP_ID))).length;
        await connect(runtime, 'alice', BASE_EPOCH_MS + 1_000);
        await connect(runtime, 'bob', BASE_EPOCH_MS + 2_000);
        const [first, second] = (await createTestGroupStateRepository(runtime).listEvents(groupRef(GROUP_ID)))
            .slice(eventsBefore)
            .map(toSummaryWork);
        const commandedWork = toCommandedWork(first!);
        const worker = new GroupPresenceSummaryWork({
            outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
            recomputeDebounceMs: 0,
            recomputeMaxWaitMs: 0,
            runtimeRepository: runtime,
            now: () => BASE_EPOCH_MS + 10_000,
            serviceId: 'summary-worker'
        });
        const reads = (await worker.read(
            [commandedWork, second!].map((work) => ({
                work,
                reservation: summaryReservationRead(work.commandId),
                traceId: 'trace-group-presence-summary-coalesced-write'
            })),
            BASE_EPOCH_MS + 10_000
        )).right ?? [];
        const commanded = worker.compute(toSummaryExpansion(commandedWork, reads[0]!));
        const automatic = worker.compute(toSummaryExpansion(second!, reads[1]!));
        expect(commanded.topologyReplan.decision).toBe('enqueue');
        expect(automatic.topologyReplan.decision).toBe('enqueue');

        const coalesced = computeGroupPresenceSummaryCoalescedWrite([commanded, automatic]);

        expect(coalesced.topologyReplan).toBe(commanded.topologyReplan);
        expect(coalesced.topologyReplanSuccessor).toEqual({
            overlayId: toScopedOverlayId(groupRef(GROUP_ID)),
            sourceGroupStateCausalRevision: commanded.snapshot.causalRevision,
            origin: 'commanded'
        });
    });
});

async function connect(runtime: GroupBarrierRepository, principalId: string, nowEpochMs: number): Promise<void> {
    const service = createService(runtime, nowEpochMs);
    await service.joinGroup(SCOPE, GROUP_ID, { actorPrincipalId: principalId, requestId: `join-${principalId}` });
    await service.connectPresenceSession(SCOPE, GROUP_ID, `${principalId}-session`, {
        principalId,
        generationId: `${principalId}-generation`,
        connectionGenerationId: `${principalId}-ws-generation`,
        actorPrincipalId: principalId,
        expiresAtEpochMs: nowEpochMs + 60_000,
        requestId: `connect-${principalId}`
    });
}

function toSummaryWork(event: GroupEvent): GroupPresenceSummaryWorkData {
    return {
        effectKind: 'group-presence-summary',
        aggregateRef: groupRef(event.groupId),
        commandId: `${event.groupId}-${event.eventId}`,
        createdAtEpochMs: event.occurredAtEpochMs,
        expireAtEpochMs: 253_402_300_799_999,
        acceptedCausalRevision: event.causalRevision,
        event
    };
}

/** The work row a commanded rebuild queues: its event names the commanded origin. */
function toCommandedWork(work: GroupPresenceSummaryWorkData): GroupPresenceSummaryWorkData {
    return { ...work, event: { ...work.event, payload: { topologyReplanOrigin: 'commanded' } } };
}
