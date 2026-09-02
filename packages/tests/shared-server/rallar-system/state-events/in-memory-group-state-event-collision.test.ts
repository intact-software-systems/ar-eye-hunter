import { computeGroupStateEventWrite, validateGroupStateEventWrite } from '@shared-server/rallar-system/state-events/group-state-event-store.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import { describe, expect, it, vi } from 'vitest';

describe('in-memory group state event identity', () => {
    it('rejects divergent content for an existing scoped event id', async () => {
        const store = new InMemoryGroupStateEventStore();
        const event = createGroupEvent();

        await store.appendGroupEvent(computeGroupStateEventWrite(event));

        await expect(
            store.appendGroupEvent(computeGroupStateEventWrite({ ...event, reason: 'different-reason' }))
        ).rejects.toMatchObject({ code: 'group-state-event-collision' });
        await expect(store.listGroupEvents(event)).resolves.toEqual([event]);
    });

    it('keeps an exact replay idempotent', async () => {
        const store = new InMemoryGroupStateEventStore();
        const event = createGroupEvent();

        await store.appendGroupEvent(computeGroupStateEventWrite(event));
        await store.appendGroupEvent(computeGroupStateEventWrite(structuredClone(event)));

        await expect(store.listGroupEvents(event)).resolves.toEqual([event]);
    });

    it('reads only the requested event in its complete group scope', async () => {
        const store = new InMemoryGroupStateEventStore();
        const event = createGroupEvent();
        const otherEvents = [
            { ...event, applicationId: 'other-app' },
            { ...event, workspaceId: 'other-workspace' },
            { ...event, groupId: 'other-group' },
            { ...event, eventId: 'later-event', snapshotVersion: 2 }
        ];
        for (const other of otherEvents) {
            await store.appendGroupEvent(computeGroupStateEventWrite(other));
        }
        await store.appendGroupEvent(computeGroupStateEventWrite(event));

        await expect(store.readGroupEvent(event, event.eventId)).resolves.toEqual(event);
        for (const other of otherEvents) {
            await expect(store.readGroupEvent(other, other.eventId)).resolves.toEqual(other);
        }
        await expect(store.readGroupEvent(event, 'missing-event')).resolves.toBeUndefined();
        await expect(store.readGroupEvent({ ...event, groupId: 'missing-group' }, event.eventId)).resolves.toBeUndefined();
    });

    it('isolates stored identity and nested data from the caller-owned append value', async () => {
        const store = new InMemoryGroupStateEventStore();
        const event = createGroupEvent();
        const expected = structuredClone(event);
        const computed = computeGroupStateEventWrite(event);
        await store.appendGroupEvent(computed);

        Object.assign(event, { workspaceId: 'changed-workspace', snapshotVersion: -1 });
        Object.assign(event.causalRevision, { groupRevision: -1 });
        Object.assign(computed, { workspaceId: 'changed-workspace', eventJson: '{}' });

        await expect(store.readGroupEvent(expected, expected.eventId)).resolves.toEqual(expected);
        await expect(store.readGroupEvent(event, event.eventId)).resolves.toBeUndefined();
    });

    it('isolates point and list reads from future stored event observations', async () => {
        const store = new InMemoryGroupStateEventStore();
        const expected = createGroupEvent();
        await store.appendGroupEvent(computeGroupStateEventWrite(structuredClone(expected)));
        const direct = await store.readGroupEvent(expected, expected.eventId);
        const listed = await store.listGroupEvents(expected);
        expect(direct).toBeDefined();
        expect(listed).toHaveLength(1);
        if (direct === undefined) {
            throw new Error('Expected the appended event before isolation checks.');
        }

        Object.assign(direct, { snapshotVersion: -1 });
        Object.assign(listed[0].causalRevision, { groupRevision: -1 });
        Object.assign(listed[0], { workspaceId: 'changed-workspace' });

        await expect(store.readGroupEvent(expected, expected.eventId)).resolves.toEqual(expected);
        await expect(store.listGroupEvents(expected)).resolves.toEqual([expected]);
        await expect(store.listRecentGroupEvents(expected)).resolves.toEqual([expected]);
    });

    it('rejects malformed input with the same corruption code as durable event storage', () => {
        const event = { ...createGroupEvent(), snapshotVersion: -1 };

        const computed = computeGroupStateEventWrite(event);
        expect(validateGroupStateEventWrite(event, computed).map((issue) => issue.cause)).toEqual([
            expect.objectContaining({
                code: 'group-state-event-repository-invariant-corruption',
                message: 'GroupEvent.snapshotVersion is invalid'
            })
        ]);
    });

    it.each(['bigint', 'cycle', 'invalid-workspace'] as const)('reports %s materialization failure as a validation issue', (kind) => {
        const valid = createGroupEvent();
        const computed = computeGroupStateEventWrite(valid);
        const event = { ...valid, payload: { ...valid.payload } };
        if (kind === 'invalid-workspace') {
            event.workspaceId = '\uD800';
        }
        else if (kind === 'bigint') {
            Object.assign(event.payload, { unsupported: 1n });
        }
        else {
            Object.assign(event.payload, { cycle: event.payload });
        }

        expect(validateGroupStateEventWrite(event, computed)).toEqual([
            expect.objectContaining({
                path: 'computed.eventWrite',
                cause: expect.objectContaining({ code: 'group-state-event-repository-invariant-corruption' })
            })
        ]);
    });

    it('inserts and matches prepared event bytes without serialization or cloning in append', async () => {
        const store = new InMemoryGroupStateEventStore();
        const event = createGroupEvent();
        const computed = computeGroupStateEventWrite(event);
        expect(validateGroupStateEventWrite(event, computed)).toEqual([]);
        const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
            throw new Error('append serialized event data');
        });
        const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => {
            throw new Error('append cloned event data');
        });
        try {
            await store.appendGroupEvent(computed);
            await store.appendGroupEvent(computed);
        }
        finally {
            stringify.mockRestore();
            clone.mockRestore();
        }
        expect(await store.listGroupEvents(event)).toEqual([event]);
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
