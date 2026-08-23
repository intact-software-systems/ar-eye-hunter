import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-client-state-event-store.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import { describe, expect, it } from 'vitest';

describe('in-memory client state event identity', () => {
    it('rejects divergent content for an existing scoped event id', async () => {
        const store = new InMemoryClientStateEventStore();
        const event = createClientEvent();

        await store.appendClientEvent(event);

        await expect(
            store.appendClientEvent({ ...event, reason: 'different-reason' })
        ).rejects.toMatchObject({ code: 'client-state-event-collision' });
        await expect(store.listClientEvents(event)).resolves.toEqual([event]);
    });

    it('keeps an exact replay idempotent', async () => {
        const store = new InMemoryClientStateEventStore();
        const event = createClientEvent();

        await store.appendClientEvent(event);
        await store.appendClientEvent(structuredClone(event));

        await expect(store.listClientEvents(event)).resolves.toEqual([event]);
    });
});

function createClientEvent(): ClientEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'principal-1',
        eventId: 'client-event-1',
        eventType: 'principal-created',
        snapshotVersion: 1,
        occurredAtEpochMs: 1_000,
        actor: { kind: 'service', serviceId: 'test-service' },
        reason: null,
        traceId: null,
        requestId: null,
        clientInstanceId: null,
        sessionId: null,
        payload: {}
    };
}
