import { describe, expect, it } from 'vitest';

import type { GroupPresenceSummaryWorkRead } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-effects.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { validateGroupStateDeltaEnvelope, type GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService, summaryReservationRead, toSummaryExpansion } from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();

describe('group presence summary coalesced slices', () => {
    it('lists a session disconnected twice in one batch once among the removed ids', async () => {
        const runtime = new GroupBarrierRepository();
        const groupId = 'removed-twice-room';
        await seedOpenGroupWithMember(runtime, groupId, 'bob');
        const eventsBefore = await listEvents(runtime, groupId);
        await connect(runtime, { groupId, principalId: 'bob', generationId: 'generation-1', nowEpochMs: BASE_EPOCH_MS + 1_000 });
        await disconnect(runtime, { groupId, principalId: 'bob', generationId: 'generation-1', nowEpochMs: BASE_EPOCH_MS + 2_000 });
        await connect(runtime, { groupId, principalId: 'bob', generationId: 'generation-2', nowEpochMs: BASE_EPOCH_MS + 3_000 });
        await disconnect(runtime, { groupId, principalId: 'bob', generationId: 'generation-2', nowEpochMs: BASE_EPOCH_MS + 4_000 });

        const deltas = await expandBatch(runtime, groupId, eventsBefore.length);

        expect(deltas.map((delta) => delta.event.eventType)).toEqual([
            'session-connected',
            'session-disconnected',
            'session-connected',
            'session-disconnected'
        ]);
        expect(deltas[0]!.removedSessionIds).toEqual([sessionId(groupId, 'bob')]);
        for (const delta of deltas) {
            expect(() => validateGroupStateDeltaEnvelope(delta)).not.toThrow();
        }
    });

    it('carries the merged slice on the first delta in causal order and each later event\'s own slice', async () => {
        const runtime = new GroupBarrierRepository();
        const groupId = 'merged-slice-room';
        await seedOpenGroupWithMember(runtime, groupId, 'bob');
        const eventsBefore = await listEvents(runtime, groupId);
        await connect(runtime, { groupId, principalId: 'alice', generationId: 'generation-1', nowEpochMs: BASE_EPOCH_MS + 1_000 });
        await connect(runtime, { groupId, principalId: 'bob', generationId: 'generation-1', nowEpochMs: BASE_EPOCH_MS + 2_000 });
        await createService(runtime, BASE_EPOCH_MS + 3_000).joinGroup(SCOPE, groupId, {
            actorPrincipalId: 'carol',
            requestId: `join-${groupId}-carol`
        });
        await connect(runtime, { groupId, principalId: 'carol', generationId: 'generation-1', nowEpochMs: BASE_EPOCH_MS + 4_000 });

        const deltas = await expandBatch(runtime, groupId, eventsBefore.length);

        expect(deltas.map((delta) => delta.event.eventType)).toEqual([
            'session-connected',
            'session-connected',
            'member-joined',
            'session-connected'
        ]);
        expect(deltas.map((delta) => delta.event.causalRevision.groupRevision)).toEqual([
            eventsBefore.length,
            eventsBefore.length,
            eventsBefore.length + 1,
            eventsBefore.length + 1
        ]);
        expect(deltas.map(sliceOf)).toEqual([
            { members: ['carol'], sessions: ['alice', 'bob', 'carol'] },
            { members: [], sessions: ['bob'] },
            { members: ['carol'], sessions: [] },
            { members: [], sessions: ['carol'] }
        ]);
        const [first] = deltas;
        for (const delta of deltas) {
            expect(delta.predecessorCausalRevision).toEqual(first!.predecessorCausalRevision);
            expect(delta.resultingCausalRevision).toEqual(first!.resultingCausalRevision);
            expect(delta.activeSessionIds).toEqual(first!.activeSessionIds);
            expect(() => validateGroupStateDeltaEnvelope(delta)).not.toThrow();
        }
    });
});

function sliceOf(delta: GroupStateDeltaEnvelope): Readonly<{ members: readonly string[]; sessions: readonly string[]; }> {
    return {
        members: delta.members.map((member) => member.principalId),
        sessions: delta.sessions.map((session) => session.principalId)
    };
}

function sessionId(groupId: string, principalId: string): string {
    return `${groupId}-${principalId}-session`;
}

async function seedOpenGroupWithMember(
    runtime: GroupBarrierRepository,
    groupId: string,
    principalId: string
): Promise<void> {
    const service = createService(runtime, BASE_EPOCH_MS);
    await service.createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        maxMembers: 10,
        createdByPrincipalId: 'alice',
        requestId: `seed-${groupId}`
    });
    await service.upsertMember(SCOPE, groupId, principalId, {
        status: 'active',
        actorPrincipalId: 'alice',
        requestId: `activate-${groupId}-${principalId}`
    });
}

/** One presence session generation of a member, connected or disconnected at its own instant. */
interface PresenceSessionStep {
    readonly groupId: string;
    readonly principalId: string;
    readonly generationId: string;
    readonly nowEpochMs: number;
}

async function connect(runtime: GroupBarrierRepository, step: PresenceSessionStep): Promise<void> {
    const { groupId, principalId, generationId, nowEpochMs } = step;
    await createService(runtime, nowEpochMs).connectPresenceSession(SCOPE, groupId, sessionId(groupId, principalId), {
        principalId,
        generationId,
        connectionGenerationId: `ws-${generationId}`,
        actorPrincipalId: principalId,
        expiresAtEpochMs: nowEpochMs + 60_000,
        requestId: `connect-${groupId}-${principalId}-${generationId}`
    });
}

async function disconnect(runtime: GroupBarrierRepository, step: PresenceSessionStep): Promise<void> {
    const { groupId, principalId, generationId, nowEpochMs } = step;
    await createService(runtime, nowEpochMs).disconnectPresenceSession(SCOPE, groupId, sessionId(groupId, principalId), {
        generationId,
        connectionGenerationId: `ws-${generationId}`,
        actorPrincipalId: principalId,
        disconnectedAtEpochMs: nowEpochMs,
        requestId: `disconnect-${groupId}-${principalId}-${generationId}`
    });
}

async function listEvents(runtime: GroupBarrierRepository, groupId: string): Promise<readonly GroupEvent[]> {
    return await createTestGroupStateRepository(runtime).listEvents(groupRef(groupId));
}

/** Expands every event after the seed as one pending batch, in the causal order the events were written. */
async function expandBatch(
    runtime: GroupBarrierRepository,
    groupId: string,
    seedEventCount: number
): Promise<readonly GroupStateDeltaEnvelope[]> {
    const work = new GroupPresenceSummaryWork({
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        recomputeDebounceMs: 0,
        recomputeMaxWaitMs: 0,
        runtimeRepository: runtime,
        now: () => BASE_EPOCH_MS + 10_000,
        serviceId: 'summary-worker',
        senderPeerId: 'ws-server'
    });
    const commands = (await listEvents(runtime, groupId)).slice(seedEventCount).map(toSummaryCommand);
    const reads: readonly GroupPresenceSummaryWorkRead[] = (await work.read(
        commands.map((command) => ({
            work: command,
            reservation: summaryReservationRead(command.commandId),
            traceId: 'trace-group-presence-summary-coalesced-slices'
        })),
        BASE_EPOCH_MS + 10_000
    )).right ?? [];
    return commands.map((command, index) => {
        const expansion = toSummaryExpansion(command, reads[index]!);
        const computed = work.compute(expansion);
        expect(work.validate(expansion, computed)).toEqual([]);
        return readDeltaEnvelope(computed.downstreamOutboxWrites[0]!.entry.resource);
    });
}

function toSummaryCommand(event: GroupEvent): GroupPresenceSummaryWorkData {
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

function readDeltaEnvelope(resource: string): GroupStateDeltaEnvelope {
    return JSON.parse(decodePersistedALMessage(resource).payload.resource) as GroupStateDeltaEnvelope;
}
