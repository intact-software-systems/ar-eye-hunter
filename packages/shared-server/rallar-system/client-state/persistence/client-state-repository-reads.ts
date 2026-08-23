import type {
    ClientEvent,
    ClientInstance,
    ClientInstanceRef,
    ClientPrincipal,
    ClientPrincipalRef,
    ClientScope,
    ClientSession,
    ClientSessionRef
} from '@shared/api/client-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

import {
    RuntimeStateJsonStore,
    type RuntimeStateEntryRead,
    type RuntimeStateEntryValue
} from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import type { ClientStateEventStore } from '../../state-events/client-state-event-store.ts';
import type { StateEventListQuery } from '../../state-events/state-event-listing.ts';
import {
    decodePersistedClientEvent,
    decodePersistedClientInstance,
    decodePersistedClientPrincipal,
    decodePersistedClientSession
} from './client-state-persistence-codec.ts';
import {
    ClientStateRepositoryInvariantCorruptionError,
    withClientStateRepositoryInvariantError,
    type ClientMutationIdempotencyRecord
} from './client-state-persistence-contracts.ts';
import {
    CLIENT_STATE_IDEMPOTENT_NAMESPACE,
    CLIENT_STATE_INSTANCES_NAMESPACE,
    CLIENT_STATE_PRINCIPALS_NAMESPACE,
    CLIENT_STATE_SESSIONS_NAMESPACE
} from './client-state-runtime-namespaces.ts';
import {
    assertExpectedClientStorageIdentity,
    clientStateIdempotencyStorageKey,
    clientStateInstanceStorageKey,
    clientStatePrincipalStorageKey,
    clientStateSessionStorageKey,
    decodeClientIdempotencyStorageKey,
    decodeClientInstanceStorageKey,
    decodeClientPrincipalStorageKey,
    decodeClientSessionStorageKey
} from './client-state-storage-keys.ts';
import { validateClientMutationIdempotencyRecord } from './validate-persisted-client-state.ts';

export class ClientStateRepositoryReads extends RuntimeStateJsonStore {
    protected readonly events: ClientStateEventStore;

    constructor(repository: RuntimeStateRepositoryLike, events: ClientStateEventStore) {
        super(repository);
        this.events = events;
    }

    async findIdempotentClientMutationReceipt(
        ref: ClientPrincipalRef,
        requestId: string
    ): Promise<ClientMutationIdempotencyRecord | undefined> {
        return (await this.findIdempotentClientMutationReceiptEntry(ref, requestId))?.value;
    }

    async findIdempotentClientMutationReceiptEntry(
        ref: ClientPrincipalRef,
        requestId: string
    ): Promise<RuntimeStateEntryValue<ClientMutationIdempotencyRecord> | undefined> {
        const stored = await this.getEntryValue<unknown>(
            CLIENT_STATE_IDEMPOTENT_NAMESPACE,
            clientStateIdempotencyStorageKey(ref, requestId)
        );
        return stored ? this.toIdempotencyEntry(stored, { ...ref, requestId }) : undefined;
    }

    async findPrincipal(ref: ClientPrincipalRef): Promise<ClientPrincipal | undefined> {
        return (await this.findPrincipalEntry(ref))?.value;
    }

    async findPrincipalEntry(
        ref: ClientPrincipalRef
    ): Promise<RuntimeStateEntryValue<ClientPrincipal> | undefined> {
        const stored = await this.getEntryValue<unknown>(
            CLIENT_STATE_PRINCIPALS_NAMESPACE,
            clientStatePrincipalStorageKey(ref)
        );
        return stored ? this.findPrincipalEntryValue(stored, ref) : undefined;
    }

    async listPrincipals(scope: ClientScope): Promise<readonly ClientPrincipal[]> {
        return (await this.listClientPrincipalEntries(this.scopeChildPrefix(scope), scope)).map(
            (entry) => entry.value
        );
    }

    async findInstance(ref: ClientInstanceRef): Promise<ClientInstance | undefined> {
        return (await this.findInstanceEntry(ref))?.value;
    }

    async findInstanceEntry(
        ref: ClientInstanceRef
    ): Promise<RuntimeStateEntryValue<ClientInstance> | undefined> {
        const stored = await this.getEntryValue<unknown>(
            CLIENT_STATE_INSTANCES_NAMESPACE,
            clientStateInstanceStorageKey(ref)
        );
        return stored ? this.toInstanceEntry(stored, ref) : undefined;
    }

    async listInstances(ref: ClientPrincipalRef): Promise<readonly ClientInstance[]> {
        return (
            await this.listClientInstanceEntries(
                this.childKeyPrefix(clientStatePrincipalStorageKey(ref)),
                ref
            )
        ).map((entry) => entry.value);
    }

    async findSession(ref: ClientSessionRef): Promise<ClientSession | undefined> {
        return (await this.findSessionEntry(ref))?.value;
    }

    async findSessionEntry(
        ref: ClientSessionRef
    ): Promise<RuntimeStateEntryValue<ClientSession> | undefined> {
        return (await this.readSessionEntry(ref)).value;
    }

    async readSessionEntry(ref: ClientSessionRef): Promise<RuntimeStateEntryRead<ClientSession>> {
        const stored = await this.getEntryRead<unknown>(
            CLIENT_STATE_SESSIONS_NAMESPACE,
            clientStateSessionStorageKey(ref)
        );
        if (
            stored.expiredEntry?.key !== undefined &&
            stored.expiredEntry.key !== clientStateSessionStorageKey(ref)
        ) {
            throw new ClientStateRepositoryInvariantCorruptionError(
                stored.expiredEntry.key,
                'Expired client session key differs from its canonical slot'
            );
        }
        return {
            value: stored.value ? this.toSessionEntry(stored.value, ref) : undefined,
            expiredEntry: stored.expiredEntry
        };
    }

    async listSessions(ref: ClientInstanceRef): Promise<readonly ClientSession[]> {
        return (
            await this.listClientSessionEntries(
                this.childKeyPrefix(clientStateInstanceStorageKey(ref)),
                ref
            )
        ).map((entry) => entry.value);
    }

    async listSessionsForPrincipal(ref: ClientPrincipalRef): Promise<readonly ClientSession[]> {
        return (
            await this.listClientSessionEntries(
                this.childKeyPrefix(clientStatePrincipalStorageKey(ref)),
                ref
            )
        ).map((entry) => entry.value);
    }

    async listAllSessions(): Promise<readonly ClientSession[]> {
        return (await this.listClientSessionEntries()).map((entry) => entry.value);
    }

    async listEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]> {
        return (await this.events.listClientEvents(ref)).map((event) =>
            decodePersistedClientEventForRepository(event, ref)
        );
    }

    async listRecentEvents(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {}
    ): Promise<readonly ClientEvent[]> {
        const events = await this.events.listRecentClientEvents(ref, query);
        return events.map((event) => decodePersistedClientEventForRepository(event, ref));
    }

    async listEventPage(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {}
    ): Promise<StateEventPage<ClientEvent>> {
        const page = await this.events.listClientEventPage(ref, query);
        return {
            ...page,
            events: page.events.map((event) => decodePersistedClientEventForRepository(event, ref))
        };
    }

    protected async listClientPrincipalEntries(
        keyPrefix: string,
        expected: ClientScope
    ): Promise<readonly RuntimeStateEntryValue<ClientPrincipal>[]> {
        const stored = await this.listEntryValues<unknown>(
            CLIENT_STATE_PRINCIPALS_NAMESPACE,
            keyPrefix
        );
        return stored.map((entry) => this.findPrincipalEntryValue(entry, expected));
    }

    protected async listClientInstanceEntries(
        keyPrefix?: string,
        expected?: ClientScope | ClientPrincipalRef
    ): Promise<readonly RuntimeStateEntryValue<ClientInstance>[]> {
        const stored = await this.listEntryValues<unknown>(CLIENT_STATE_INSTANCES_NAMESPACE, keyPrefix);
        return stored.map((entry) => this.toInstanceEntry(entry, expected));
    }

    protected async listClientSessionEntries(
        keyPrefix?: string,
        expected?: ClientScope | ClientPrincipalRef | ClientInstanceRef
    ): Promise<readonly RuntimeStateEntryValue<ClientSession>[]> {
        const stored = await this.listEntryValues<unknown>(CLIENT_STATE_SESSIONS_NAMESPACE, keyPrefix);
        return stored.map((entry) => this.toSessionEntry(entry, expected));
    }

    protected findPrincipalEntryValue(
        stored: RuntimeStateEntryValue<unknown>,
        expected: ClientScope | ClientPrincipalRef
    ): RuntimeStateEntryValue<ClientPrincipal> {
        return withClientStateRepositoryInvariantError(stored.entry.key, () => {
            const keyRef = decodeClientPrincipalStorageKey(stored.entry.key);
            assertExpectedClientStorageIdentity(keyRef, expected, 'principal');
            const value = decodePersistedClientPrincipal(stored.value, keyRef);
            if (clientStatePrincipalStorageKey(value) !== stored.entry.key) {
                throw new TypeError('Stored client principal identity differs from its canonical slot');
            }
            return { entry: stored.entry, value };
        });
    }

    protected toInstanceEntry(
        stored: RuntimeStateEntryValue<unknown>,
        expected?: ClientScope | ClientPrincipalRef | ClientInstanceRef
    ): RuntimeStateEntryValue<ClientInstance> {
        return withClientStateRepositoryInvariantError(stored.entry.key, () => {
            const keyRef = decodeClientInstanceStorageKey(stored.entry.key);
            if (expected) {
                assertExpectedClientStorageIdentity(keyRef, expected, 'instance');
            }
            const value = decodePersistedClientInstance(stored.value, keyRef);
            if (clientStateInstanceStorageKey(value) !== stored.entry.key) {
                throw new TypeError('Stored client instance identity differs from its canonical slot');
            }
            return { entry: stored.entry, value };
        });
    }

    protected toSessionEntry(
        stored: RuntimeStateEntryValue<unknown>,
        expected?: ClientScope | ClientPrincipalRef | ClientSessionRef
    ): RuntimeStateEntryValue<ClientSession> {
        return withClientStateRepositoryInvariantError(stored.entry.key, () => {
            const keyRef = decodeClientSessionStorageKey(stored.entry.key);
            if (expected) {
                assertExpectedClientStorageIdentity(keyRef, expected, 'session');
            }
            const value = decodePersistedClientSession(stored.value, keyRef);
            if (clientStateSessionStorageKey(value) !== stored.entry.key) {
                throw new TypeError('Stored client session identity differs from its canonical slot');
            }
            return { entry: stored.entry, value };
        });
    }

    private toIdempotencyEntry(
        stored: RuntimeStateEntryValue<unknown>,
        expected: ClientPrincipalRef & Readonly<{ requestId: string; }>
    ): RuntimeStateEntryValue<ClientMutationIdempotencyRecord> {
        return withClientStateRepositoryInvariantError(stored.entry.key, () => {
            const keyRef = decodeClientIdempotencyStorageKey(stored.entry.key);
            assertExpectedClientStorageIdentity(keyRef, expected, 'idempotency');
            if (keyRef.requestId !== expected.requestId) {
                throw new TypeError('Stored client idempotency identity differs from its canonical slot');
            }
            validateClientMutationIdempotencyRecord(stored.value);
            assertCanonicalClientStateIdempotencyRecord(stored.value, keyRef, keyRef.requestId);
            return { entry: stored.entry, value: stored.value };
        });
    }
}

export function assertCanonicalClientStateIdempotencyRecord(
    record: ClientMutationIdempotencyRecord,
    ref: ClientPrincipalRef,
    requestId: string
): void {
    validateClientMutationIdempotencyRecord(record);
    if (
        record.requestId !== requestId ||
        record.receipt.requestId !== requestId ||
        record.receipt.commandId !== requestId ||
        record.receipt.aggregateRef.applicationId !== ref.applicationId ||
        record.receipt.aggregateRef.workspaceId !== ref.workspaceId ||
        record.receipt.aggregateRef.principalId !== ref.principalId
    ) {
        throw new TypeError('Stored client idempotency identity differs from its canonical slot');
    }
}

export function decodePersistedClientEventForRepository(
    event: unknown,
    expected: ClientPrincipalRef
): ClientEvent {
    return withClientStateRepositoryInvariantError(
        clientStatePrincipalStorageKey(expected),
        () => decodePersistedClientEvent(event, expected)
    );
}
