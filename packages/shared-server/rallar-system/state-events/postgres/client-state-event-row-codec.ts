import type { ClientEvent, ClientPrincipalRef } from '@shared/api/client-types.ts';
import { decodePersistedClientEvent } from '../../client-state/persistence/client-state-persistence-codec.ts';
import { clientStateWorkspaceStorageKey } from '../../client-state/persistence/client-state-workspace-storage-key.ts';
import { validatePersistedClientEvent } from '../../client-state/persistence/validate-persisted-client-state.ts';

export interface ClientStateEventRow {
    readonly event_id: string;
    readonly event_type: string;
    readonly snapshot_version: number | string;
    readonly occurred_at_epoch_ms: number | string;
    readonly client_instance_id: string | null;
    readonly session_id: string | null;
    readonly event_json: string;
}

export interface ClientStateEventCollisionRow extends ClientStateEventRow {
    readonly application_id: string;
    readonly workspace_key: string;
    readonly principal_id: string;
}

export class ClientStateEventRepositoryInvariantCorruptionError extends Error {
    readonly code = 'client-state-event-repository-invariant-corruption';

    constructor(message: string) {
        super(message);
        this.name = 'ClientStateEventRepositoryInvariantCorruptionError';
    }
}

export function assertPersistableClientStateEvent(
    event: ClientEvent,
    expected: ClientPrincipalRef
): void {
    try {
        validatePersistedClientEvent(event, expected);
    }
    catch (error) {
        throw new ClientStateEventRepositoryInvariantCorruptionError(
            error instanceof Error ? error.message : 'Stored client event is invalid'
        );
    }
}

export function isExactPersistedClientStateEvent(
    row: ClientStateEventCollisionRow,
    event: ClientEvent,
    eventJson: string
): boolean {
    return row.application_id === event.applicationId &&
        row.workspace_key === clientStateWorkspaceStorageKey(event.workspaceId) &&
        row.principal_id === event.principalId &&
        row.event_id === event.eventId &&
        row.event_type === event.eventType &&
        Number(row.snapshot_version) === event.snapshotVersion &&
        Number(row.occurred_at_epoch_ms) === event.occurredAtEpochMs &&
        row.client_instance_id === event.clientInstanceId &&
        row.session_id === event.sessionId &&
        row.event_json === eventJson;
}

export function toValidatedClientStateEvent(
    row: ClientStateEventRow,
    expected: ClientPrincipalRef
): ClientEvent {
    const event = decodeClientStateEventJson(row.event_json, expected);
    if (
        event.applicationId !== expected.applicationId ||
        event.workspaceId !== expected.workspaceId ||
        event.principalId !== expected.principalId ||
        event.eventId !== row.event_id ||
        event.eventType !== row.event_type ||
        event.snapshotVersion !== Number(row.snapshot_version) ||
        event.occurredAtEpochMs !== Number(row.occurred_at_epoch_ms) ||
        event.clientInstanceId !== row.client_instance_id ||
        event.sessionId !== row.session_id
    ) {
        throw new ClientStateEventRepositoryInvariantCorruptionError(
            'Stored client event identity differs from its physical columns'
        );
    }
    return event;
}

function decodeClientStateEventJson(eventJson: string, expected: ClientPrincipalRef): ClientEvent {
    try {
        return decodePersistedClientEvent(JSON.parse(eventJson), expected);
    }
    catch (error) {
        throw new ClientStateEventRepositoryInvariantCorruptionError(
            error instanceof Error ? error.message : 'Stored client event JSON is invalid'
        );
    }
}
