import type {
    ClientInstance,
    ClientInstanceRef,
    ClientPrincipal,
    ClientPrincipalRef,
    ClientSession,
    ClientSessionRef,
    ClientSnapshot
} from '@shared/api/client-types.ts';

import type { RuntimeStateReadBatchLiveSelection } from '../../../runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import type { RuntimeStateReadBatchSelector } from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntryRead, RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';

export type ClientPrincipalSnapshotRead = Readonly<{
    principal: RuntimeStateEntryValue<ClientPrincipal>;
    snapshot: ClientSnapshot;
}>;

/** The rows one mutation decides on, and the rows other features read beside them, selected by one statement. */
export interface ClientMutationStateBatchInput {
    readonly principalRef: ClientPrincipalRef;
    readonly instanceRef: ClientInstanceRef | null;
    readonly sessionRef: ClientSessionRef | null;
    readonly requestId: string | null;
    readonly companionSelectors: readonly RuntimeStateReadBatchSelector[];
}

export interface ClientMutationStateBatch {
    readonly idempotency: RuntimeStateEntryValue<ClientMutationIdempotencyRecord> | undefined;
    readonly principalSnapshot: ClientPrincipalSnapshotRead | undefined;
    readonly instance: RuntimeStateEntryValue<ClientInstance> | undefined;
    readonly session: RuntimeStateEntryRead<ClientSession>;
    /** One live selection per companion selector, in the order they were given, still undecoded. */
    readonly companions: readonly RuntimeStateReadBatchLiveSelection<JsonWireValue>[];
}

export type ClientMutationReceipt = Readonly<{
    commandId: string;
    requestId: string | null;
    commandHash: string;
    aggregateRef: ClientPrincipalRef;
    outcome: 'applied' | 'no-op';
    attemptCount: number;
    acceptedStorageRevision: number | null;
    stateRevision: number;
    snapshotVersion: number;
    presenceVersion: number;
    eventId: string | null;
    outboxIds: readonly string[];
}>;

export type ClientMutationIdempotencyRecord = Readonly<{
    requestId: string;
    commandHash: string;
    receipt: ClientMutationReceipt;
}>;

export class ClientStateRepositoryInvariantCorruptionError extends Error {
    readonly code = 'client-state-repository-invariant-corruption';

    readonly storageKey: string;

    constructor(
        storageKey: string,
        message: string
    ) {
        super(`${message}: ${storageKey}`);
        this.storageKey = storageKey;
        this.name = 'ClientStateRepositoryInvariantCorruptionError';
    }
}

export async function toLiveClientStateEntryValue(
    entry: RuntimeStateEntry
): Promise<RuntimeStateEntryValue<JsonWireValue> | undefined> {
    if (entry.expireAtTimestamp <= Date.now()) {
        return undefined;
    }
    try {
        const value: JsonWireValue = JSON.parse(entry.value);
        return { entry, value };
    }
    catch (error) {
        throw new ClientStateRepositoryInvariantCorruptionError(
            entry.key,
            `Stored client-state JSON is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export function withClientStateRepositoryInvariantError<T>(storageKey: string, read: () => T): T {
    try {
        return read();
    }
    catch (error) {
        if (error instanceof ClientStateRepositoryInvariantCorruptionError) {
            throw error;
        }
        throw new ClientStateRepositoryInvariantCorruptionError(
            storageKey,
            error instanceof Error ? error.message : 'Stored client-state value is invalid'
        );
    }
}
