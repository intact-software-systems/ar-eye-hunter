import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import {
    decodePersistedGroupEvent,
    validatePersistedGroupEvent
} from '../../group-state/persistence/persisted-group-event.ts';

import { groupStateEventWorkspaceKey } from './group-state-event-workspace-key.ts';

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

export class GroupStateEventRepositoryInvariantCorruptionError extends Error {
    readonly code = 'group-state-event-repository-invariant-corruption';

    constructor(message: string) {
        super(message);
        this.name = 'GroupStateEventRepositoryInvariantCorruptionError';
    }
}

export function assertPersistableGroupStateEvent(
    event: GroupEvent,
    expected: GroupRef
): void {
    try {
        validatePersistedGroupEvent(event, expected);
    }
    catch (error) {
        throw new GroupStateEventRepositoryInvariantCorruptionError(
            error instanceof Error ? error.message : 'Stored group event is invalid'
        );
    }
}

export function isExactPersistedGroupStateEvent(
    row: GroupStateEventCollisionRow,
    event: GroupEvent,
    eventJson: string
): boolean {
    return row.application_id === event.applicationId &&
        row.workspace_key === groupStateEventWorkspaceKey(event.workspaceId) &&
        row.group_id === event.groupId &&
        row.event_id === event.eventId &&
        row.event_type === event.eventType &&
        Number(row.snapshot_version) === event.snapshotVersion &&
        Number(row.occurred_at_epoch_ms) === event.occurredAtEpochMs &&
        row.event_json === eventJson;
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
        return decodePersistedGroupEvent(JSON.parse(eventJson), expected);
    }
    catch (error) {
        throw new GroupStateEventRepositoryInvariantCorruptionError(
            error instanceof Error ? error.message : 'Stored group event JSON is invalid'
        );
    }
}
