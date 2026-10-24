import {
    describe,
    expect,
    it
} from 'vitest';

import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { createTestGroupStateRuntime, createTestGroupStateService } from '../group-state-test-runtime.ts';
import { ApplyingGuardedBatchRepository, OrderedGroupEventStore } from './group-mutation-test-runtime.ts';

const SCOPE = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
} as const;

describe('GroupStateService guarded presence batch', () => {
    it('persists connect and heartbeat sessions with admission, durable receipts and events', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        const startedAtEpochMs = 1_900_000_000_000;
        let nowEpochMs = startedAtEpochMs;
        let generatedId = 0;
        const service = createTestGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => nowEpochMs,
            randomId: () => `presence-batch-id-${++generatedId}`,
            serviceId: 'presence-batch-service'
        });
        const ref = groupRef('presence-update');
        await service.createGroup(SCOPE, {
            groupId: ref.groupId,
            displayName: 'Presence update',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'presence-update-seed'
        });
        eventStore.events.length = 0;
        nowEpochMs = startedAtEpochMs + 1_000;
        const connectReceipt = await service.connectPresenceSessionReceipt(
            SCOPE,
            ref.groupId,
            'session-a',
            {
                principalId: 'alice',
                generationId: 'generation-a',
                connectionGenerationId: 'ws-generation-a',
                expiresAtEpochMs: startedAtEpochMs + 20_000,
                requestId: 'presence-update-connect'
            }
        );
        const repository = createTestGroupStateRepository(runtime, eventStore);
        const admission = await repository.findPresenceAdmissionEntry({
            ...ref,
            principalId: 'alice'
        });
        const connectIdempotency = await repository.findIdempotentGroupMutationReceipt(
            ref,
            'presence-update-connect'
        );
        const connectEvent = eventStore.events.find(
            ({ eventId }) => eventId === connectReceipt.eventId
        );
        if (!admission || !connectIdempotency || !connectEvent) {
            throw new Error('Expected the complete presence connect bundle');
        }
        const connectedSession = {
            ...ref,
            sessionId: 'session-a',
            principalId: 'alice',
            generationId: 'generation-a',
            generationVersion: nowEpochMs,
            connectionGenerationId: 'ws-generation-a',
            connectedAtEpochMs: nowEpochMs,
            lastHeartbeatAtEpochMs: nowEpochMs,
            expiresAtEpochMs: startedAtEpochMs + 20_000,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null
        } as const;

        const presence = await repository.findPresenceEntry({ ...ref, sessionId: 'session-a' });
        expect(presence?.value).toEqual(connectedSession);
        expect(presence?.entry.expireAtTimestamp).toBe(startedAtEpochMs + 20_000 + 86_400_000);
        expect(admission.value).toEqual({
            ...ref,
            principalId: 'alice',
            admittedSessions: [{
                sessionId: 'session-a',
                generationId: 'generation-a',
                generationVersion: nowEpochMs,
                connectedAtEpochMs: nowEpochMs
            }],
            updatedAtEpochMs: nowEpochMs
        });
        expect(connectReceipt).toMatchObject({
            aggregateRef: ref,
            requestId: 'presence-update-connect',
            outcome: 'applied',
            eventId: expect.any(String),
            rejection: null
        });
        expect(connectIdempotency.receipt).toEqual(connectReceipt);
        expect(connectReceipt.acceptedStorageRevision).toBe(presence?.entry.revision);
        expect(connectEvent).toMatchObject({
            ...ref,
            eventId: connectReceipt.eventId,
            eventType: 'session-connected',
            requestId: 'presence-update-connect',
            occurredAtEpochMs: nowEpochMs
        });
        expect(eventStore.events).toEqual([connectEvent]);

        eventStore.events.length = 0;
        nowEpochMs = startedAtEpochMs + 2_000;
        const heartbeatReceipt = await service.heartbeatPresenceSessionReceipt(
            SCOPE,
            ref.groupId,
            'session-a',
            {
                generationId: 'generation-a',
                actorPrincipalId: 'alice',
                lastHeartbeatAtEpochMs: nowEpochMs,
                expiresAtEpochMs: startedAtEpochMs + 30_000,
                requestId: 'presence-update-heartbeat'
            }
        );
        const heartbeatPresence = await repository.findPresenceEntry({
            ...ref,
            sessionId: 'session-a'
        });
        const heartbeatIdempotency = await repository.findIdempotentGroupMutationReceipt(
            ref,
            'presence-update-heartbeat'
        );
        const heartbeatEvent = eventStore.events.find(
            ({ eventId }) => eventId === heartbeatReceipt.eventId
        );
        if (!heartbeatPresence || !heartbeatIdempotency || !heartbeatEvent) {
            throw new Error('Expected the complete presence heartbeat bundle');
        }
        expect(heartbeatPresence.value).toEqual({
            ...connectedSession,
            lastHeartbeatAtEpochMs: nowEpochMs,
            expiresAtEpochMs: startedAtEpochMs + 30_000
        });
        expect(heartbeatPresence.entry.expireAtTimestamp).toBe(startedAtEpochMs + 30_000 + 86_400_000);
        expect((await repository.findPresenceAdmissionEntry({ ...ref, principalId: 'alice' }))?.value)
            .toEqual(admission.value);
        expect(heartbeatIdempotency.receipt).toEqual(heartbeatReceipt);
        expect(heartbeatReceipt.acceptedStorageRevision).toBe(heartbeatPresence.entry.revision);
        expect(heartbeatReceipt).toMatchObject({
            aggregateRef: ref,
            requestId: 'presence-update-heartbeat',
            outcome: 'applied',
            eventId: expect.any(String),
            rejection: null
        });
        expect(heartbeatEvent).toMatchObject({
            ...ref,
            eventId: heartbeatReceipt.eventId,
            eventType: 'session-heartbeat',
            requestId: 'presence-update-heartbeat',
            occurredAtEpochMs: nowEpochMs
        });
        expect(eventStore.events).toEqual([heartbeatEvent]);
    });

    it('expires the session and releases its admission with a durable receipt and event', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        const eventStore = new OrderedGroupEventStore(runtime);
        let nowEpochMs = 1_900_000_000_000;
        let generatedId = 0;
        const groupRuntime = createTestGroupStateRuntime({
            runtimeRepository: runtime,
            groupStateEventStoreFor: () => eventStore,
            now: () => nowEpochMs,
            randomId: () => `expiry-batch-id-${++generatedId}`,
            serviceId: 'expiry-batch-service'
        });
        const ref = groupRef('presence-expiry');
        await groupRuntime.service.createGroup(SCOPE, {
            groupId: ref.groupId,
            displayName: 'Presence expiry',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'presence-expiry-seed'
        });
        nowEpochMs += 2_000;
        await groupRuntime.service.connectPresenceSession(SCOPE, ref.groupId, 'expiry-session', {
            principalId: 'alice',
            generationId: 'expiry-generation',
            connectionGenerationId: 'expiry-ws-generation',
            connectedAtEpochMs: nowEpochMs,
            lastHeartbeatAtEpochMs: nowEpochMs,
            expiresAtEpochMs: nowEpochMs + 500,
            requestId: 'presence-expiry-connect'
        });
        eventStore.events.length = 0;
        nowEpochMs += 1_000;

        const written = await groupRuntime.maintenance.expireExpiredPresenceSessions(nowEpochMs);
        const repository = createTestGroupStateRepository(runtime, eventStore);
        const admission = await repository.findPresenceAdmissionEntry({
            ...ref,
            principalId: 'alice'
        });
        if (!admission) {
            throw new Error('Expected the complete presence expiry bundle');
        }

        expect(written).toHaveLength(1);
        expect(admission.value).toEqual({
            ...ref,
            principalId: 'alice',
            admittedSessions: [],
            updatedAtEpochMs: nowEpochMs
        });
        const expiryEvent = eventStore.events[0];
        if (!expiryEvent || expiryEvent.requestId === null) {
            throw new Error('Expected a durable expiry event with its request identity');
        }
        const expiryReceipt = await repository.findIdempotentGroupMutationReceipt(ref, expiryEvent.requestId);
        expect(expiryReceipt?.receipt).toMatchObject({
            aggregateRef: ref,
            requestId: expiryEvent.requestId,
            outcome: 'applied',
            eventId: expiryEvent.eventId,
            rejection: null
        });
        expect(expiryEvent).toMatchObject({
            ...ref,
            eventType: 'session-disconnected',
            occurredAtEpochMs: nowEpochMs
        });
        expect(
            await repository.findPresenceSession({
                ...ref,
                sessionId: 'expiry-session'
            })
        ).toBeUndefined();
        expect(eventStore.events).toHaveLength(1);
    });

    it.each(['guard', 'presence-admission', 'receipt', 'presence-member-fence'])(
        'rolls an initial connect back completely when %s conflicts',
        async (conflictTarget) => {
            const runtime = new ApplyingGuardedBatchRepository();
            const eventStore = new OrderedGroupEventStore(runtime);
            const nowEpochMs = 1_900_000_000_000;
            let generatedId = 0;
            const service = createTestGroupStateService({
                runtimeRepository: runtime,
                groupStateEventStoreFor: () => eventStore,
                now: () => nowEpochMs,
                randomId: () => `presence-conflict-id-${++generatedId}`,
                serviceId: 'presence-conflict-service'
            });
            const ref = groupRef('presence-conflict');
            await service.createGroup(SCOPE, {
                groupId: ref.groupId,
                displayName: 'Presence conflict',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice',
                requestId: 'presence-conflict-seed'
            });
            const repository = createTestGroupStateRepository(runtime, eventStore);
            const before = new Map([...runtime.data].filter(([key]) => key.startsWith('group-state:')));
            const eventsBefore = [...eventStore.events];
            runtime.forceNextConflict(conflictTarget);

            await expect(service.connectPresenceSessionReceipt(SCOPE, ref.groupId, 'session-conflict', {
                principalId: 'alice',
                generationId: 'generation-conflict',
                connectionGenerationId: 'ws-generation-conflict',
                expiresAtEpochMs: nowEpochMs + 30_000,
                requestId: 'presence-conflict-connect'
            })).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);

            expect(await repository.findPresenceSession({ ...ref, sessionId: 'session-conflict' })).toBeUndefined();
            expect(await repository.findPresenceAdmissionEntry({ ...ref, principalId: 'alice' })).toBeUndefined();
            expect(await repository.findIdempotentGroupMutationReceipt(ref, 'presence-conflict-connect')).toBeUndefined();
            expect(new Map([...runtime.data].filter(([key]) => key.startsWith('group-state:')))).toEqual(before);
            expect(eventStore.events).toEqual(eventsBefore);
        }
    );
});

function groupRef(groupId: string): GroupRef {
    return { ...SCOPE, groupId };
}
