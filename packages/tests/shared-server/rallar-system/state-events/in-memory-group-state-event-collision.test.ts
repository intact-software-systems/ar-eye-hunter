import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';

describe('in-memory group state event identity', () => {
    it('rejects divergent content for an existing scoped event id', async () => {
        const store = new InMemoryGroupStateEventStore();
        const event = createGroupEvent();

        await store.appendGroupEvent(event);

        await expect(
            store.appendGroupEvent({ ...event, reason: 'different-reason' })
        ).rejects.toMatchObject({ code: 'group-state-event-collision' });
        await expect(store.listGroupEvents(event)).resolves.toEqual([event]);
    });

    it('keeps an exact replay idempotent', async () => {
        const store = new InMemoryGroupStateEventStore();
        const event = createGroupEvent();

        await store.appendGroupEvent(event);
        await store.appendGroupEvent(structuredClone(event));

        await expect(store.readGroupEvent(event, event.eventId)).resolves.toBe(event);
        await expect(
            store.readGroupEvent({ ...event, groupId: 'another-group' }, event.eventId)
        ).resolves.toBeUndefined();
        await expect(store.listGroupEvents(event)).resolves.toEqual([event]);
    });
});

function createGroupEvent(): GroupEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        eventId: 'group-event-1',
        eventType: 'group-created',
        snapshotVersion: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        occurredAtEpochMs: 1_000,
        actor: { kind: 'service', serviceId: 'test-service' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}
