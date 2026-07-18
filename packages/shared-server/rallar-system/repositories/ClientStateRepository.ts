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
import type { RuntimeStateRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type { ClientStateWritten } from '@shared-server/rallar-system/services/client-state-service.ts';
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

export class ClientStateRepository extends RuntimeStateJsonStore {
    private readonly events: ClientStateEventStore;

    constructor(
        repository: RuntimeStateRepositoryLike,
        options: ClientStateRepositoryOptions = {},
    ) {
        super(repository);
        this.events = options.events ?? defaultClientStateEventStoreFor(repository);
    }

    async addIdempotentClientStateWritten(
        ref: ClientPrincipalRef,
        requestId: string,
        clientStateWritten: ClientStateWritten,
        purgeAfterEpochMs: number = NEVER_EXPIRE_AT_TIMESTAMP,
    ): Promise<ClientStateWritten> {
        await this.putValue(
            IDEMPOTENT_NAMESPACE,
            this.idempotentClientKey(ref, requestId),
            clientStateWritten,
            purgeAfterEpochMs,
        );

        return clientStateWritten;
    }

    async findIdempotentClientStateWritten(
        ref: ClientPrincipalRef,
        requestId: string,
    ): Promise<ClientStateWritten | undefined> {
        return await this.getValue<ClientStateWritten>(
            IDEMPOTENT_NAMESPACE,
            this.idempotentClientKey(ref, requestId),
        );
    }

    async putPrincipal(principal: ClientPrincipal): Promise<void> {
        await this.putValue(
            PRINCIPALS_NAMESPACE,
            this.principalKey(principal),
            principal,
        );
    }

    async findPrincipal(
        ref: ClientPrincipalRef,
    ): Promise<ClientPrincipal | undefined> {
        return await this.getValue<ClientPrincipal>(
            PRINCIPALS_NAMESPACE,
            this.principalKey(ref),
        );
    }

    async listPrincipals(
        scope: ClientScope,
    ): Promise<readonly ClientPrincipal[]> {
        return await this.listValues<ClientPrincipal>(
            PRINCIPALS_NAMESPACE,
            this.scopeChildPrefix(scope),
        );
    }

    async listSnapshots(
        scope: ClientScope,
    ): Promise<readonly ClientSnapshot[]> {
        const keyPrefix = this.scopeChildPrefix(scope);
        const principalsBefore = await this.listEntryValues<ClientPrincipal>(
            PRINCIPALS_NAMESPACE,
            keyPrefix,
        );
        const [instances, sessions] = await Promise.all([
            this.listValues<ClientInstance>(
                INSTANCES_NAMESPACE,
                keyPrefix,
            ),
            this.listValues<ClientSession>(
                SESSIONS_NAMESPACE,
                keyPrefix,
            ),
        ]);
        const principalsAfter = await this.listEntryValues<ClientPrincipal>(
            PRINCIPALS_NAMESPACE,
            keyPrefix,
        );
        const instancesByPrincipalId = new Map<string, ClientInstance[]>();
        for (const instance of instances) {
            const current = instancesByPrincipalId.get(instance.principalId) ?? [];
            current.push(instance);
            instancesByPrincipalId.set(instance.principalId, current);
        }

        const activeSessionsByPrincipalId = new Map<string, ClientSession[]>();
        for (const session of this.toActiveSessions(sessions)) {
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

    async removePrincipal(ref: ClientPrincipalRef): Promise<void> {
        await this.deleteValue(PRINCIPALS_NAMESPACE, this.principalKey(ref));
    }

    async putInstance(instance: ClientInstance): Promise<void> {
        await this.putValue(
            INSTANCES_NAMESPACE,
            this.instanceKey(instance),
            instance,
        );
    }

    async findInstance(
        ref: ClientInstanceRef,
    ): Promise<ClientInstance | undefined> {
        return await this.getValue<ClientInstance>(
            INSTANCES_NAMESPACE,
            this.instanceKey(ref),
        );
    }

    async listInstances(
        ref: ClientPrincipalRef,
    ): Promise<readonly ClientInstance[]> {
        return await this.listValues<ClientInstance>(
            INSTANCES_NAMESPACE,
            this.principalChildPrefix(ref),
        );
    }

    async removeInstance(ref: ClientInstanceRef): Promise<void> {
        await this.deleteValue(INSTANCES_NAMESPACE, this.instanceKey(ref));
    }

    async putSession(session: ClientSession): Promise<void> {
        await this.putValue(
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
        return await this.getValue<ClientSession>(
            SESSIONS_NAMESPACE,
            this.sessionKey(ref),
        );
    }

    async listSessions(
        ref: ClientInstanceRef,
    ): Promise<readonly ClientSession[]> {
        return await this.listValues<ClientSession>(
            SESSIONS_NAMESPACE,
            this.instanceChildPrefix(ref),
        );
    }

    async listSessionsForPrincipal(
        ref: ClientPrincipalRef,
    ): Promise<readonly ClientSession[]> {
        return await this.listValues<ClientSession>(
            SESSIONS_NAMESPACE,
            this.principalChildPrefix(ref),
        );
    }

    async listAllSessions(): Promise<readonly ClientSession[]> {
        return await this.listValues<ClientSession>(SESSIONS_NAMESPACE);
    }

    async removeSession(ref: ClientSessionRef): Promise<void> {
        await this.deleteValue(SESSIONS_NAMESPACE, this.sessionKey(ref));
    }

    async appendEvent(event: ClientEvent): Promise<void> {
        await this.events.appendClientEvent(event);
    }

    async listEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]> {
        return await this.events.listClientEvents(ref);
    }

    async listRecentEvents(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {},
    ): Promise<readonly ClientEvent[]> {
        return this.events.listRecentClientEvents
            ? await this.events.listRecentClientEvents(ref, query)
            : filterStateEventsForList(
                await this.events.listClientEvents(ref),
                query,
            );
    }

    async listEventPage(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {},
    ): Promise<StateEventPage<ClientEvent>> {
        return await this.events.listClientEventPage(ref, query);
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
            lastSeenAtEpochMs: this.toLastSeenAtEpochMs(
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
                await this.getEntryValue<ClientPrincipal>(
                    PRINCIPALS_NAMESPACE,
                    principalKey,
                ),
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
            lastSeenAtEpochMs: this.toLastSeenAtEpochMs(
                principal.lastSeenAtEpochMs,
                activeSessions,
            ),
        };
    }

    private toActiveSessions(
        sessions: readonly ClientSession[],
    ): readonly ClientSession[] {
        return sessions.filter(
            (session) =>
                session.status === 'active' &&
                session.disconnectedAtEpochMs === undefined &&
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

    private toLastSeenAtEpochMs(
        existing: number | undefined,
        sessions: readonly ClientSession[],
    ): number | undefined {
        const timestamps = [
            existing ?? Number.NEGATIVE_INFINITY,
            ...sessions.map((session) => session.lastHeartbeatAtEpochMs),
        ];

        const next = Math.max(...timestamps);
        return Number.isFinite(next) ? next : undefined;
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
