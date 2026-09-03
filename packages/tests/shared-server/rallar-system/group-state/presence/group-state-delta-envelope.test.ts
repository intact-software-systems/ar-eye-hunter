import {
    describe,
    expect,
    it
} from 'vitest';

import type {
    GroupPresenceSummaryComputedWork,
    GroupPresenceSummaryWorkRead
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-effects.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { validateGroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import type { GroupStateTestService } from '../group-state-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { convergeSummaryForTest, createService } from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();

describe('group-state delta envelope construction', () => {
    it('carries the joined member, complete identity set, counts, and CAS revisions', async () => {
        const runtime = new GroupBarrierRepository();
        const service = createService(runtime, BASE_EPOCH_MS);
        await seedGroupWithBob(service, 'delta-join-group');

        const { command, read, computed } = await computeSummaryWork({
            runtime,
            ref: groupRef('delta-join-group'),
            commandId: 'delta-join-command',
            trigger: (event) => event.eventType === 'member-joined'
        });

        const envelope = readGroupStateEventRowEnvelope(computed.downstreamOutboxEntries[0]);
        expect(() => validateGroupStateDeltaEnvelope(envelope)).not.toThrow();
        expect(envelope.event).toEqual(command.event);
        if (read.presence.current === null) {
            throw new Error('Expected prior presence summary');
        }
        expect(envelope.predecessorCausalRevision).toEqual(read.presence.current.value.causalRevision);
        expect(envelope.resultingCausalRevision).toEqual(computed.snapshot.causalRevision);
        expect(envelope.members).toEqual(
            computed.snapshot.members.filter((member) => member.principalId === 'bob')
        );
        expect(envelope.members).toHaveLength(1);
        expect(envelope.sessions).toEqual([]);
        expect(envelope.removedMemberPrincipalIds).toEqual([]);
        expect(envelope.removedSessionIds).toEqual([]);
        expect(envelope.activeSessionIds).toEqual(
            computed.snapshot.activeSessions.map((session) => session.sessionId)
        );
        expect(envelope.group).toEqual(computed.snapshot.group);
        expect(envelope.memberCount).toBe(computed.snapshot.memberCount);
        expect(envelope.onlineMemberCount).toBe(computed.snapshot.onlineMemberCount);
        expect(envelope.audienceSessionIds).toEqual(computed.summary.summary.activeSessionIds);
    });

    it('carries the connecting principal session slice without any member slice', async () => {
        const runtime = new GroupBarrierRepository();
        const service = createService(runtime, BASE_EPOCH_MS);
        await seedGroupWithBob(service, 'delta-connect-group');
        await connectSession({ service, groupId: 'delta-connect-group', principalId: 'bob', sessionId: 'bob-session' });

        const { command, computed } = await computeSummaryWork({
            runtime,
            ref: groupRef('delta-connect-group'),
            commandId: 'delta-connect-command',
            trigger: (event) => event.eventType === 'session-connected'
        });

        const envelope = readGroupStateEventRowEnvelope(computed.downstreamOutboxEntries[0]);
        expect(command.event.eventType).toBe('session-connected');
        expect(envelope.members).toEqual([]);
        expect(envelope.sessions).toEqual(
            computed.snapshot.activeSessions.filter((session) => session.principalId === 'bob')
        );
        expect(envelope.sessions).toHaveLength(1);
        expect(envelope.activeSessionIds).toContain('bob-session');
        expect(envelope.audienceSessionIds).toContain('bob-session');
    });

    it('stamps predecessor equal to resulting for a summary no-op expansion', async () => {
        const runtime = new GroupBarrierRepository();
        const service = createService(runtime, BASE_EPOCH_MS);
        await seedGroupWithBob(service, 'delta-noop-group');
        await connectSession({ service, groupId: 'delta-noop-group', principalId: 'bob', sessionId: 'bob-session' });
        await convergeSummaryForTest({
            work: createSummaryWorkService(runtime),
            runtime,
            ref: groupRef('delta-noop-group'),
            commandId: 'delta-noop-converge',
            nowEpochMs: BASE_EPOCH_MS + 1_000
        });

        const { computed } = await computeSummaryWork({
            runtime,
            ref: groupRef('delta-noop-group'),
            commandId: 'delta-noop-replay',
            trigger: (event) => event.eventType === 'session-connected'
        });

        expect(computed.summary.outcome).toBe('no-op');
        const envelope = readGroupStateEventRowEnvelope(computed.downstreamOutboxEntries[0]);
        expect(envelope.predecessorCausalRevision).toEqual(envelope.resultingCausalRevision);
        expect(envelope.resultingCausalRevision).toEqual(computed.snapshot.causalRevision);
    });

    it('emits byte-identical envelope rows regardless of session insertion order', async () => {
        const first = await computeShuffledScenarioEventRow(['s-c', 's-a', 's-b']);
        const second = await computeShuffledScenarioEventRow(['s-b', 's-c', 's-a']);

        expect(first.resource).toBe(second.resource);
        const envelope = readGroupStateEventRowEnvelope(first);
        expect(envelope.activeSessionIds).toEqual(['s-a', 's-b', 's-c', 's-trigger']);
    });

    it('computes from the explicit observation time without consulting a hidden clock', async () => {
        const runtime = new GroupBarrierRepository();
        const service = createService(runtime, BASE_EPOCH_MS);
        await seedGroupWithBob(service, 'delta-explicit-time-group');
        const ref = groupRef('delta-explicit-time-group');
        const repository = createTestGroupStateRepository(runtime);
        const event = (await repository.listEvents(ref)).find(
            (candidate) => candidate.eventType === 'member-joined'
        );
        if (!event) {
            throw new Error('Missing member-joined event');
        }
        const command: GroupPresenceSummaryWorkData = {
            effectKind: 'group-presence-summary',
            aggregateRef: ref,
            commandId: 'delta-explicit-time-command',
            createdAtEpochMs: event.occurredAtEpochMs,
            expireAtEpochMs: 253_402_300_799_999,
            acceptedCausalRevision: event.causalRevision,
            event
        };
        const work = new GroupPresenceSummaryWork({
            outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
            recomputeDebounceMs: 0,
            runtimeRepository: runtime,
            now: () => {
                throw new Error('compute read the worker clock');
            },
            serviceId: 'summary-worker'
        });
        const read = await work.read(command);

        const computed = work.compute(command, read, BASE_EPOCH_MS + 1_000);

        expect(computed.summary.evaluatedAtEpochMs).toBe(BASE_EPOCH_MS + 1_000);
    });
});

async function computeShuffledScenarioEventRow(
    connectOrder: readonly string[]
): Promise<ResourceEntry> {
    const runtime = new GroupBarrierRepository();
    const service = createService(runtime, BASE_EPOCH_MS);
    await seedGroupWithBob(service, 'delta-order-group');
    for (const sessionId of connectOrder) {
        await connectSession({ service, groupId: 'delta-order-group', principalId: 'bob', sessionId: sessionId });
    }
    await connectSession({ service, groupId: 'delta-order-group', principalId: 'alice', sessionId: 's-trigger' });
    const { computed } = await computeSummaryWork({
        runtime,
        ref: groupRef('delta-order-group'),
        commandId: 'delta-order-command',
        trigger: (event) =>
            event.eventType === 'session-connected' &&
            event.actor.kind !== 'service' &&
            event.actor.principalId === 'alice'
    });
    const event = computed.downstreamOutboxEntries[0];
    if (event === undefined) {
        throw new Error('Expected emitted group state event row');
    }
    return event;
}

async function seedGroupWithBob(
    service: GroupStateTestService,
    groupId: string
): Promise<void> {
    await service.createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: `seed-${groupId}`
    });
    await service.upsertMember(SCOPE, groupId, 'bob', {
        status: 'active',
        actorPrincipalId: 'alice',
        requestId: `activate-${groupId}-bob`
    });
}

interface ConnectSessionInput {
    readonly service: GroupStateTestService;
    readonly groupId: string;
    readonly principalId: string;
    readonly sessionId: string;
}
async function connectSession({ service, groupId, principalId, sessionId }: ConnectSessionInput): Promise<void> {
    await service.connectPresenceSession(SCOPE, groupId, sessionId, {
        principalId,
        generationId: `${sessionId}-generation`,
        actorPrincipalId: principalId,
        expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
        requestId: `connect-${groupId}-${sessionId}`
    });
}

function createSummaryWorkService(runtime: GroupBarrierRepository): GroupPresenceSummaryWork {
    return new GroupPresenceSummaryWork({
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        recomputeDebounceMs: 0,
        runtimeRepository: runtime,
        now: () => BASE_EPOCH_MS + 1_000,
        serviceId: 'summary-worker'
    });
}

interface SummaryWorkInput {
    readonly runtime: GroupBarrierRepository;
    readonly ref: GroupRef;
    readonly commandId: string;
    readonly trigger: (event: GroupEvent) => boolean;
}
interface ComputedSummaryScenario {
    readonly command: GroupPresenceSummaryWorkData;
    readonly read: GroupPresenceSummaryWorkRead;
    readonly computed: GroupPresenceSummaryComputedWork;
}
async function computeSummaryWork(input: SummaryWorkInput): Promise<ComputedSummaryScenario> {
    const work = createSummaryWorkService(input.runtime);
    const repository = createTestGroupStateRepository(input.runtime);
    const event = (await repository.listEvents(input.ref)).find(input.trigger);
    if (!event) {
        throw new Error(`Missing group event for summary: ${input.ref.groupId}`);
    }
    const command: GroupPresenceSummaryWorkData = {
        effectKind: 'group-presence-summary',
        aggregateRef: input.ref,
        commandId: input.commandId,
        createdAtEpochMs: event.occurredAtEpochMs,
        expireAtEpochMs: 253_402_300_799_999,
        acceptedCausalRevision: event.causalRevision,
        event
    };
    const read = await work.read(command);
    const computed = work.compute(command, read, BASE_EPOCH_MS + 1_000);
    work.validate(command, read, computed);
    return { command, read, computed };
}

function readGroupStateEventRowEnvelope(entry: ResourceEntry | undefined): GroupStateDeltaEnvelope {
    if (entry === undefined) {
        throw new Error('Expected emitted group state event row');
    }
    const message = decodePersistedALMessage(entry.resource);
    const envelope: unknown = JSON.parse(message.payload.resource);
    validateGroupStateDeltaEnvelope(envelope);
    return envelope;
}
