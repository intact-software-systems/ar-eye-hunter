import { GroupStateEventRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/state-events/group-state-event-store.ts';
import { toValidatedGroupStateEvent, type GroupStateEventRow } from '@shared-server/rallar-system/state-events/postgres/group-state-event-row-codec.ts';
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';

const expectedRef: GroupRef = {
    applicationId: 'test-app',
    workspaceId: 'test-workspace',
    groupId: 'expected-group'
};

describe('group state event row decoding', () => {
    it('rejects an event JSON document outside the requested group through the canonical boundary', () => {
        const event = groupEvent({ groupId: 'other-group' });

        expect(() => toValidatedGroupStateEvent(groupEventRow(event), expectedRef)).toThrow(
            expect.objectContaining({
                name: GroupStateEventRepositoryInvariantCorruptionError.name,
                code: 'group-state-event-repository-invariant-corruption',
                message: 'GroupEvent is outside the requested group'
            })
        );
    });
});

function groupEvent(overrides: Partial<GroupEvent> = {}): GroupEvent {
    return {
        ...expectedRef,
        eventId: 'event-1',
        eventType: 'group-updated',
        snapshotVersion: 1,
        causalRevision: {
            groupRevision: 1,
            presenceRevision: 0
        },
        occurredAtEpochMs: 1_000,
        actor: {
            kind: 'service',
            serviceId: 'test-service'
        },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {},
        ...overrides
    };
}

function groupEventRow(event: GroupEvent): GroupStateEventRow {
    return {
        event_id: event.eventId,
        event_type: event.eventType,
        snapshot_version: event.snapshotVersion,
        occurred_at_epoch_ms: event.occurredAtEpochMs,
        event_json: JSON.stringify(event)
    };
}
