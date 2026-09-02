import { validateAuthoritativeGroupEvent } from '@shared/api/authoritative-state-validation.ts';
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';

import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    GroupStateEventRepositoryInvariantCorruptionError,
    type GroupStateEventWrite
} from '../group-state-event-store.ts';

export interface GroupStateEventRow {
    readonly event_id: string;
    readonly event_type: string;
    readonly snapshot_version: number | string;
    readonly occurred_at_epoch_ms: number | string;
    readonly event_json: string;
}

export interface GroupStateEventCollisionRow extends GroupStateEventRow {
    readonly application_id: string;
    readonly workspace_key: string;
    readonly group_id: string;
}

export function isExactPersistedGroupStateEvent(
    row: GroupStateEventCollisionRow,
    computed: GroupStateEventWrite
): boolean {
    return row.application_id === computed.applicationId &&
        row.workspace_key === computed.workspaceKey &&
        row.group_id === computed.groupId &&
        row.event_id === computed.eventId &&
        row.event_type === computed.eventType &&
        Number(row.snapshot_version) === computed.snapshotVersion &&
        Number(row.occurred_at_epoch_ms) === computed.occurredAtEpochMs &&
        row.event_json === computed.eventJson;
}

export function toValidatedGroupStateEvent(
    row: GroupStateEventRow,
    expected: GroupRef
): GroupEvent {
    const event = decodeGroupStateEventJson(row.event_json, expected);
    if (
        event.applicationId !== expected.applicationId ||
        event.workspaceId !== expected.workspaceId ||
        event.groupId !== expected.groupId ||
        event.eventId !== row.event_id ||
        event.eventType !== row.event_type ||
        event.snapshotVersion !== Number(row.snapshot_version) ||
        event.occurredAtEpochMs !== Number(row.occurred_at_epoch_ms)
    ) {
        throw new GroupStateEventRepositoryInvariantCorruptionError(
            'Stored group event identity differs from its physical columns'
        );
    }
    return event;
}

function decodeGroupStateEventJson(eventJson: string, expected: GroupRef): GroupEvent {
    try {
        const event = decodeJsonWireValue(JSON.parse(eventJson), 'Stored group event');
        validateAuthoritativeGroupEvent(event, expected);
        return event;
    }
    catch (error) {
        throw new GroupStateEventRepositoryInvariantCorruptionError(
            error instanceof Error ? error.message : 'Stored group event JSON is invalid'
        );
    }
}
