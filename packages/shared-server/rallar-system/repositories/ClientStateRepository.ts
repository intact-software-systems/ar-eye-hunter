import type {
    ClientEvent,
    ClientInstance,
    ClientInstanceRef,
    ClientPresenceSnapshot,
    ClientPresenceState,
    ClientPrincipal,
    ClientPrincipalRef,
    ClientScope,
    ClientSession,
    ClientSessionRef,
    ClientSnapshot,
} from '@shared/api/client-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import {
    toClientSnapshotLastSeenAtEpochMs,
} from '@shared/api/group-client-views.ts';
import type { RuntimeStateRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    RuntimeStateJsonStore,
    type RuntimeStateEntryValue,
} from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    ClientMutationIdempotencyRecord,
} from '@shared-server/rallar-system/services/client-state-mutations.ts';
import {
    normalizePersistedClientEvent,
    normalizePersistedClientInstance,
    normalizePersistedClientPrincipal,
    normalizePersistedClientSession,
    validateClientMutationIdempotencyRecord,
    validatePersistedClientEvent,
    validatePersistedClientInstance,
    validatePersistedClientPrincipal,
    validatePersistedClientSession,
} from '@shared-server/rallar-system/services/client-state-mutations.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { isLogicallyActiveSession, toSessionPurgeAfterEpochMs } from './session-expiry.ts';
import { type ClientStateEventStore, defaultClientStateEventStoreFor } from './StateEventStore.ts';
import { filterStateEventsForList, type StateEventListQuery } from '../state-event-listing.ts';
import { readStableStateSnapshot } from './state-snapshot-read.ts';

const PRINCIPALS_NAMESPACE = 'client-state:principals';
const INSTANCES_NAMESPACE = 'client-state:instances';
const SESSIONS_NAMESPACE = 'client-state:sessions';
const IDEMPOTENT_NAMESPACE = 'client-state:idempotent';

export type ClientStateRepositoryOptions = Readonly<{
    events?: ClientStateEventStore;
}>;

export class ClientStateRepositoryInvariantCorruptionError extends Error {
    readonly code = 'client-state-repository-invariant-corruption';

    constructor(readonly storageKey: string, message: string) {
        super(`${message}: ${storageKey}`);
        this.name = 'ClientStateRepositoryInvariantCorruptionError';
    }
}

export class ClientStateRepository extends RuntimeStateJsonStore {
    private readonly events: ClientStateEventStore;

    constructor(
        repository: RuntimeStateRepositoryLike,
        options: ClientStateRepositoryOptions = {},
    ) {
        super(repository);
        this.events = options.events ?? defaultClientStateEventStoreFor(repository);
    }

    protected override async toLiveEntryValue<T>(
        namespace: string,
        entry: import('../../runtime-state/RuntimeStateRepository.ts').RuntimeStateEntry,
    ): Promise<RuntimeStateEntryValue<T> | undefined> {
        try {
            return await super.toLiveEntryValue<T>(namespace, entry);
        } catch (error) {
            if (error instanceof SyntaxError) {
                throw new ClientStateRepositoryInvariantCorruptionError(
                    entry.key,
                    `Stored client-state JSON is invalid: ${error.message}`,
                );
            }
            throw error;
        }
    }

    async insertIdempotentClientStateWritten(
        ref: ClientPrincipalRef,
        requestId: string,
        record: ClientMutationIdempotencyRecord,
        purgeAfterEpochMs: number = NEVER_EXPIRE_AT_TIMESTAMP,
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.assertCanonicalIdempotencyRecord(record, ref, requestId);
        return await this.putValueIfAbsent(
            IDEMPOTENT_NAMESPACE,
            this.idempotentClientKey(ref, requestId),
            record,
            purgeAfterEpochMs,
        );
    }

    async findIdempotentClientMutationReceipt(
        ref: ClientPrincipalRef,
        requestId: string,
    ): Promise<ClientMutationIdempotencyRecord | undefined> {
        return (await this.findIdempotentClientMutationReceiptEntry(ref, requestId))
            ?.value;
    }

    async findIdempotentClientMutationReceiptEntry(
        ref: ClientPrincipalRef,
        requestId: string,
    ): Promise<RuntimeStateEntryValue<ClientMutationIdempotencyRecord> | undefined> {
        const stored = await this.getEntryValue<unknown>(
            IDEMPOTENT_NAMESPACE,
            this.idempotentClientKey(ref, requestId),
        );
        return stored
            ? this.toIdempotencyEntry(stored, { ...ref, requestId })
            : undefined;
    }

    async findPrincipal(
        ref: ClientPrincipalRef,
    ): Promise<ClientPrincipal | undefined> {
        return (await this.findPrincipalEntry(ref))?.value;
    }

    async findPrincipalEntry(
        ref: ClientPrincipalRef,
    ): Promise<RuntimeStateEntryValue<ClientPrincipal> | undefined> {
        const stored = await this.getEntryValue<unknown>(
            PRINCIPALS_NAMESPACE,
            this.principalKey(ref),
        );
        return stored ? this.toPrincipalEntry(stored, ref) : undefined;
    }

    async insertPrincipal(
        principal: ClientPrincipal,
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientPrincipal(principal, principal);
        return await this.putValueIfAbsent(
            PRINCIPALS_NAMESPACE,
            this.principalKey(principal),
            principal,
        );
    }

    async updatePrincipal(
        principal: ClientPrincipal,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientPrincipal(principal, principal);
        return await this.putValueIfRevision(
            PRINCIPALS_NAMESPACE,
            this.principalKey(principal),
            principal,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision,
        );
    }

    async listPrincipals(
        scope: ClientScope,
    ): Promise<readonly ClientPrincipal[]> {
        const stored = await this.listEntryValues<unknown>(
            PRINCIPALS_NAMESPACE,
            this.scopeChildPrefix(scope),
        );
        return stored.map((entry) => this.toPrincipalEntry(entry, scope).value);
    }

    async listSnapshots(
        scope: ClientScope,
    ): Promise<readonly ClientSnapshot[]> {
        const keyPrefix = this.scopeChildPrefix(scope);
        const principalsBefore = (await this.listEntryValues<unknown>(
            PRINCIPALS_NAMESPACE,
            keyPrefix,
        )).map((entry) => this.toPrincipalEntry(entry, scope));
        const [instances, sessions] = await Promise.all([
            this.listClientInstanceEntries(keyPrefix, scope),
            this.listClientSessionEntries(keyPrefix, scope),
        ]);
        const principalsAfter = (await this.listEntryValues<unknown>(
            PRINCIPALS_NAMESPACE,
            keyPrefix,
        )).map((entry) => this.toPrincipalEntry(entry, scope));
        const instancesByPrincipalId = new Map<string, ClientInstance[]>();
        for (const { value: instance } of instances) {
            const current = instancesByPrincipalId.get(instance.principalId) ?? [];
            current.push(instance);
            instancesByPrincipalId.set(instance.principalId, current);
        }

        const activeSessionsByPrincipalId = new Map<string, ClientSession[]>();
        for (const session of this.toActiveSessions(
            sessions.map((entry) => entry.value),
        )) {
            const current = activeSessionsByPrincipalId.get(session.principalId) ?? [];
            current.push(session);
            activeSessionsByPrincipalId.set(session.principalId, current);
        }

        const beforeByKey = new Map(
            principalsBefore.map((stored) => [stored.entry.key, stored]),
        );
        const snapshots = await Promise.all(
            principalsAfter.map(async (stored) => {
                const before = beforeByKey.get(stored.entry.key);
                if (!before || before.entry.revision !== stored.entry.revision) {
                    return await this.readSnapshot(stored.value);
                }
                return this.toSnapshot(
                    stored.value,
                    instancesByPrincipalId.get(stored.value.principalId) ?? [],
                    activeSessionsByPrincipalId.get(stored.value.principalId) ?? [],
                    stored.entry.revision + 1,
                );
            }),
        );
        return snapshots.filter(
            (snapshot): snapshot is ClientSnapshot => snapshot !== undefined,
        );
    }

    async deletePrincipal(
        ref: ClientPrincipalRef,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            PRINCIPALS_NAMESPACE,
            this.principalKey(ref),
            expectedRevision,
        );
    }

    async findInstance(
        ref: ClientInstanceRef,
    ): Promise<ClientInstance | undefined> {
        return (await this.findInstanceEntry(ref))?.value;
    }

    async findInstanceEntry(
        ref: ClientInstanceRef,
    ): Promise<RuntimeStateEntryValue<ClientInstance> | undefined> {
        const stored = await this.getEntryValue<unknown>(
            INSTANCES_NAMESPACE,
            this.instanceKey(ref),
        );
        return stored ? this.toInstanceEntry(stored, ref) : undefined;
    }

    async insertInstance(
        instance: ClientInstance,
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientInstance(instance, instance);
        return await this.putValueIfAbsent(
            INSTANCES_NAMESPACE,
            this.instanceKey(instance),
            instance,
        );
    }

    async updateInstance(
        instance: ClientInstance,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientInstance(instance, instance);
        return await this.putValueIfRevision(
            INSTANCES_NAMESPACE,
            this.instanceKey(instance),
            instance,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision,
        );
    }

    async listInstances(
        ref: ClientPrincipalRef,
    ): Promise<readonly ClientInstance[]> {
        return (await this.listClientInstanceEntries(
            this.principalChildPrefix(ref),
            ref,
        )).map((entry) => entry.value);
    }

    async deleteInstance(
        ref: ClientInstanceRef,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            INSTANCES_NAMESPACE,
            this.instanceKey(ref),
            expectedRevision,
        );
    }

    async insertSession(
        session: ClientSession,
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientSession(session, session);
        return await this.putValueIfAbsent(
            SESSIONS_NAMESPACE,
            this.sessionKey(session),
            session,
            toSessionPurgeAfterEpochMs(
                session.expiresAtEpochMs,
                session.disconnectedAtEpochMs,
            ),
        );
    }

    async findSession(ref: ClientSessionRef): Promise<ClientSession | undefined> {
        return (await this.findSessionEntry(ref))?.value;
    }

    async findSessionEntry(
        ref: ClientSessionRef,
    ): Promise<RuntimeStateEntryValue<ClientSession> | undefined> {
        const stored = await this.getEntryValue<unknown>(
            SESSIONS_NAMESPACE,
            this.sessionKey(ref),
        );
        return stored ? this.toSessionEntry(stored, ref) : undefined;
    }

    async updateSession(
        session: ClientSession,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        validatePersistedClientSession(session, session);
        return await this.putValueIfRevision(
            SESSIONS_NAMESPACE,
            this.sessionKey(session),
            session,
            toSessionPurgeAfterEpochMs(
                session.expiresAtEpochMs,
                session.disconnectedAtEpochMs,
            ),
            expectedRevision,
        );
    }

    async listSessions(
        ref: ClientInstanceRef,
    ): Promise<readonly ClientSession[]> {
        return (await this.listClientSessionEntries(
            this.instanceChildPrefix(ref),
            ref,
        )).map((entry) => entry.value);
    }

    async listSessionsForPrincipal(
        ref: ClientPrincipalRef,
    ): Promise<readonly ClientSession[]> {
        return (await this.listClientSessionEntries(
            this.principalChildPrefix(ref),
            ref,
        )).map((entry) => entry.value);
    }

    async listAllSessions(): Promise<readonly ClientSession[]> {
        return (await this.listClientSessionEntries()).map((entry) => entry.value);
    }

    async deleteSession(
        ref: ClientSessionRef,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            SESSIONS_NAMESPACE,
            this.sessionKey(ref),
            expectedRevision,
        );
    }

    async appendEvent(event: ClientEvent): Promise<void> {
        validatePersistedClientEvent(event, event);
        await this.events.appendClientEvent(event);
    }

    async listEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]> {
        return (await this.events.listClientEvents(ref)).map((event) =>
            this.toClientEvent(event, ref)
        );
    }

    async listRecentEvents(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {},
    ): Promise<readonly ClientEvent[]> {
        const events = this.events.listRecentClientEvents
            ? await this.events.listRecentClientEvents(ref, query)
            : filterStateEventsForList(
                await this.events.listClientEvents(ref),
                query,
            );
        return events.map((event) => this.toClientEvent(event, ref));
    }

    async listEventPage(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {},
    ): Promise<StateEventPage<ClientEvent>> {
        const page = await this.events.listClientEventPage(ref, query);
        return {
            ...page,
            events: page.events.map((event) => this.toClientEvent(event, ref)),
        };
    }

    async readPresenceSnapshot(
        ref: ClientPrincipalRef,
    ): Promise<ClientPresenceSnapshot | undefined> {
        const principal = await this.findPrincipal(ref);
        if (!principal) {
            return undefined;
        }

        const activeSessions = this.toActiveSessions(
            await this.listSessionsForPrincipal(ref),
        );

        return {
            applicationId: principal.applicationId,
            workspaceId: principal.workspaceId,
            principalId: principal.principalId,
            presenceVersion: principal.presenceVersion,
            isOnline: activeSessions.length > 0,
            presenceState: this.toPresenceState(activeSessions),
            activeSessions,
            lastSeenAtEpochMs: toClientSnapshotLastSeenAtEpochMs(
                principal.lastSeenAtEpochMs,
                activeSessions,
            ),
        };
    }

    async readSnapshot(
        ref: ClientPrincipalRef,
    ): Promise<ClientSnapshot | undefined> {
        const principalKey = this.principalKey(ref);
        return await readStableStateSnapshot({
            snapshotKey: principalKey,
            readAggregate: async () =>
                await this.findPrincipalEntry(ref),
            readChildren: async () => {
                const [instances, sessions] = await Promise.all([
                    this.listInstances(ref),
                    this.listSessionsForPrincipal(ref),
                ]);
                return [instances, this.toActiveSessions(sessions)] as const;
            },
            assemble: (stored, instances, activeSessions) =>
                this.toSnapshot(
                    stored.value,
                    instances,
                    activeSessions,
                    stored.entry.revision + 1,
                ),
        });
    }

    private toSnapshot(
        principal: ClientPrincipal,
        instances: readonly ClientInstance[],
        activeSessions: readonly ClientSession[],
        stateRevision: number,
    ): ClientSnapshot {
        return {
            stateRevision,
            principal,
            instances,
            activeSessions,
            isOnline: activeSessions.length > 0,
            activeSessionCount: activeSessions.length,
            lastSeenAtEpochMs: toClientSnapshotLastSeenAtEpochMs(
                principal.lastSeenAtEpochMs,
                activeSessions,
            ),
        };
    }

    private async listClientInstanceEntries(
        keyPrefix?: string,
        expected?: ClientScope | ClientPrincipalRef,
    ): Promise<readonly RuntimeStateEntryValue<ClientInstance>[]> {
        const stored = await this.listEntryValues<unknown>(
            INSTANCES_NAMESPACE,
            keyPrefix,
        );
        return stored.map((entry) => this.toInstanceEntry(entry, expected));
    }

    private async listClientSessionEntries(
        keyPrefix?: string,
        expected?: ClientScope | ClientPrincipalRef | ClientInstanceRef,
    ): Promise<readonly RuntimeStateEntryValue<ClientSession>[]> {
        const stored = await this.listEntryValues<unknown>(
            SESSIONS_NAMESPACE,
            keyPrefix,
        );
        return stored.map((entry) => this.toSessionEntry(entry, expected));
    }

    private toPrincipalEntry(
        stored: RuntimeStateEntryValue<unknown>,
        expected: ClientScope | ClientPrincipalRef,
    ): RuntimeStateEntryValue<ClientPrincipal> {
        return this.withInvariantError(stored.entry.key, () => {
            const keyRef = decodeClientPrincipalKey(stored.entry.key);
            assertExpectedClientIdentity(keyRef, expected, 'principal');
            const value = normalizePersistedClientPrincipal(stored.value, keyRef);
            if (this.principalKey(value) !== stored.entry.key) {
                throw new TypeError(
                    'Stored client principal identity differs from its canonical slot',
                );
            }
            return { entry: stored.entry, value };
        });
    }

    private toInstanceEntry(
        stored: RuntimeStateEntryValue<unknown>,
        expected?: ClientScope | ClientPrincipalRef | ClientInstanceRef,
    ): RuntimeStateEntryValue<ClientInstance> {
        return this.withInvariantError(stored.entry.key, () => {
            const keyRef = decodeClientInstanceKey(stored.entry.key);
            if (expected) assertExpectedClientIdentity(keyRef, expected, 'instance');
            const value = normalizePersistedClientInstance(stored.value, keyRef);
            if (this.instanceKey(value) !== stored.entry.key) {
                throw new TypeError(
                    'Stored client instance identity differs from its canonical slot',
                );
            }
            return { entry: stored.entry, value };
        });
    }

    private toSessionEntry(
        stored: RuntimeStateEntryValue<unknown>,
        expected?: ClientScope | ClientPrincipalRef | ClientInstanceRef | ClientSessionRef,
    ): RuntimeStateEntryValue<ClientSession> {
        return this.withInvariantError(stored.entry.key, () => {
            const keyRef = decodeClientSessionKey(stored.entry.key);
            if (expected) assertExpectedClientIdentity(keyRef, expected, 'session');
            const value = normalizePersistedClientSession(stored.value, keyRef);
            if (this.sessionKey(value) !== stored.entry.key) {
                throw new TypeError(
                    'Stored client session identity differs from its canonical slot',
                );
            }
            return { entry: stored.entry, value };
        });
    }

    private toIdempotencyEntry(
        stored: RuntimeStateEntryValue<unknown>,
        expected: ClientPrincipalRef & Readonly<{ requestId: string }>,
    ): RuntimeStateEntryValue<ClientMutationIdempotencyRecord> {
        return this.withInvariantError(stored.entry.key, () => {
            const keyRef = decodeClientIdempotencyKey(stored.entry.key);
            assertExpectedClientIdentity(keyRef, expected, 'idempotency');
            if (keyRef.requestId !== expected.requestId) {
                throw new TypeError(
                    'Stored client idempotency identity differs from its canonical slot',
                );
            }
            validateClientMutationIdempotencyRecord(stored.value);
            this.assertCanonicalIdempotencyRecord(
                stored.value,
                keyRef,
                keyRef.requestId,
            );
            return { entry: stored.entry, value: stored.value };
        });
    }

    private assertCanonicalIdempotencyRecord(
        record: ClientMutationIdempotencyRecord,
        ref: ClientPrincipalRef,
        requestId: string,
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
            throw new TypeError(
                'Stored client idempotency identity differs from its canonical slot',
            );
        }
    }

    private toClientEvent(
        event: unknown,
        expected: ClientPrincipalRef,
    ): ClientEvent {
        return this.withInvariantError(this.principalKey(expected), () =>
            normalizePersistedClientEvent(event, expected)
        );
    }

    private withInvariantError<T>(storageKey: string, read: () => T): T {
        try {
            return read();
        } catch (error) {
            if (error instanceof ClientStateRepositoryInvariantCorruptionError) {
                throw error;
            }
            throw new ClientStateRepositoryInvariantCorruptionError(
                storageKey,
                error instanceof Error
                    ? error.message
                    : 'Stored client-state value is invalid',
            );
        }
    }

    private toActiveSessions(
        sessions: readonly ClientSession[],
    ): readonly ClientSession[] {
        return sessions.filter(
            (session) =>
                session.status === 'active' &&
                session.disconnectedAtEpochMs === null &&
                isLogicallyActiveSession(session.expiresAtEpochMs),
        );
    }

    private toPresenceState(
        sessions: readonly ClientSession[],
    ): ClientPresenceState {
        if (sessions.some((session) => session.presenceState === 'busy')) {
            return 'busy';
        }

        if (sessions.some((session) => session.presenceState === 'away')) {
            return 'away';
        }

        if (sessions.some((session) => session.presenceState === 'online')) {
            return 'online';
        }

        return 'offline';
    }

    private principalKey(ref: ClientPrincipalRef): string {
        return [this.scopeKey(ref), this.idKey('principal', ref.principalId)].join(
            ':',
        );
    }

    private idempotentClientKey(
        ref: ClientPrincipalRef,
        requestId: string,
    ): string {
        return [this.principalKey(ref), this.idKey('request', requestId)].join(':');
    }

    private principalChildPrefix(ref: ClientPrincipalRef): string {
        return this.childKeyPrefix(this.principalKey(ref));
    }

    private instanceKey(ref: ClientInstanceRef): string {
        return [
            this.principalKey(ref),
            this.idKey('instance', ref.clientInstanceId),
        ].join(':');
    }

    private instanceChildPrefix(ref: ClientInstanceRef): string {
        return this.childKeyPrefix(this.instanceKey(ref));
    }

    private sessionKey(ref: ClientSessionRef): string {
        return [this.instanceKey(ref), this.idKey('session', ref.sessionId)].join(
            ':',
        );
    }
}

function decodeClientPrincipalKey(key: string): ClientPrincipalRef {
    const values = decodeClientKey(
        key,
        ['app', 'ws', 'principal'],
    );
    const applicationId = decodedClientKeyPart(values, 0);
    const workspaceId = decodedClientKeyPart(values, 1);
    const principalId = decodedClientKeyPart(values, 2);
    return { applicationId, workspaceId, principalId };
}

function decodeClientInstanceKey(key: string): ClientInstanceRef {
    const values = decodeClientKey(key, ['app', 'ws', 'principal', 'instance']);
    const applicationId = decodedClientKeyPart(values, 0);
    const workspaceId = decodedClientKeyPart(values, 1);
    const principalId = decodedClientKeyPart(values, 2);
    const clientInstanceId = decodedClientKeyPart(values, 3);
    return { applicationId, workspaceId, principalId, clientInstanceId };
}

function decodeClientSessionKey(key: string): ClientSessionRef {
    const values = decodeClientKey(
        key,
        ['app', 'ws', 'principal', 'instance', 'session'],
    );
    const applicationId = decodedClientKeyPart(values, 0);
    const workspaceId = decodedClientKeyPart(values, 1);
    const principalId = decodedClientKeyPart(values, 2);
    const clientInstanceId = decodedClientKeyPart(values, 3);
    const sessionId = decodedClientKeyPart(values, 4);
    return {
        applicationId,
        workspaceId,
        principalId,
        clientInstanceId,
        sessionId,
    };
}

function decodeClientIdempotencyKey(
    key: string,
): ClientPrincipalRef & Readonly<{ requestId: string }> {
    const values = decodeClientKey(
        key,
        ['app', 'ws', 'principal', 'request'],
    );
    const applicationId = decodedClientKeyPart(values, 0);
    const workspaceId = decodedClientKeyPart(values, 1);
    const principalId = decodedClientKeyPart(values, 2);
    const requestId = decodedClientKeyPart(values, 3);
    return { applicationId, workspaceId, principalId, requestId };
}

function decodeClientKey(
    key: string,
    names: readonly string[],
): readonly string[] {
    const segments = key.split(':');
    if (segments.length !== names.length) {
        throw new TypeError('Stored client-state key is not canonical');
    }
    const values = names.map((name, index) => {
        const prefix = `${name}=`;
        const segment = segments[index];
        if (!segment?.startsWith(prefix)) {
            throw new TypeError('Stored client-state key is not canonical');
        }
        const encoded = segment.slice(prefix.length);
        const decoded = decodeURIComponent(encoded);
        if (decoded.length === 0 || encodeURIComponent(decoded) !== encoded) {
            throw new TypeError('Stored client-state key is not canonical');
        }
        return decoded;
    });
    return values;
}

function decodedClientKeyPart(values: readonly string[], index: number): string {
    const value = values[index];
    if (value === undefined) {
        throw new TypeError('Stored client-state key is not canonical');
    }
    return value;
}

function assertExpectedClientIdentity(
    actual: ClientScope | ClientPrincipalRef | ClientInstanceRef | ClientSessionRef,
    expected: ClientScope | ClientPrincipalRef | ClientInstanceRef | ClientSessionRef,
    label: string,
): void {
    if (
        actual.applicationId !== expected.applicationId ||
        actual.workspaceId !== expected.workspaceId ||
        ('principalId' in expected &&
            (!('principalId' in actual) ||
                actual.principalId !== expected.principalId)) ||
        ('clientInstanceId' in expected &&
            (!('clientInstanceId' in actual) ||
                actual.clientInstanceId !== expected.clientInstanceId)) ||
        ('sessionId' in expected &&
            (!('sessionId' in actual) || actual.sessionId !== expected.sessionId))
    ) {
        throw new TypeError(
            `Stored client ${label} identity differs from its canonical slot`,
        );
    }
}
