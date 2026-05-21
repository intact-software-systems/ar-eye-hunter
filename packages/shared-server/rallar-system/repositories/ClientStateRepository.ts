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
import type { RuntimeStateRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type { ClientStateWritten } from '@shared-server/rallar-system/services/client-state-service.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

const PRINCIPALS_NAMESPACE = 'client-state:principals';
const INSTANCES_NAMESPACE = 'client-state:instances';
const SESSIONS_NAMESPACE = 'client-state:sessions';
const EVENTS_NAMESPACE = 'client-state:events';
const IDEMPOTENT_NAMESPACE = 'client-state:idempotent';

export class ClientStateRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
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
            this.scopePrefix(scope),
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
            this.instancePrefix(ref),
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
            session.expiresAtEpochMs,
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
            this.sessionPrefix(ref),
        );
    }

    async listSessionsForPrincipal(
        ref: ClientPrincipalRef,
    ): Promise<readonly ClientSession[]> {
        return await this.listValues<ClientSession>(
            SESSIONS_NAMESPACE,
            this.instancePrefix(ref),
        );
    }

    async removeSession(ref: ClientSessionRef): Promise<void> {
        await this.deleteValue(SESSIONS_NAMESPACE, this.sessionKey(ref));
    }

    async appendEvent(event: ClientEvent): Promise<void> {
        await this.putValue(EVENTS_NAMESPACE, this.eventKey(event), event);
    }

    async listEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]> {
        const events = await this.listValues<ClientEvent>(
            EVENTS_NAMESPACE,
            this.eventPrefix(ref),
        );

        return [...events].sort(
            (left, right) => left.occurredAtEpochMs - right.occurredAtEpochMs,
        );
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
        const principal = await this.findPrincipal(ref);
        if (!principal) {
            return undefined;
        }

        const instances = await this.listInstances(ref);
        const activeSessions = this.toActiveSessions(
            await this.listSessionsForPrincipal(ref),
        );

        return {
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
        return sessions.filter((session) => session.status === 'active');
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

    private scopePrefix(scope: ClientScope): string {
        return this.scopeKey(scope);
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

    private instancePrefix(ref: ClientPrincipalRef): string {
        return this.principalKey(ref);
    }

    private instanceKey(ref: ClientInstanceRef): string {
        return [
            this.principalKey(ref),
            this.idKey('instance', ref.clientInstanceId),
        ].join(':');
    }

    private sessionPrefix(ref: ClientInstanceRef): string {
        return this.instanceKey(ref);
    }

    private sessionKey(ref: ClientSessionRef): string {
        return [this.instanceKey(ref), this.idKey('session', ref.sessionId)].join(
            ':',
        );
    }

    private eventPrefix(ref: ClientPrincipalRef): string {
        return this.principalKey(ref);
    }

    private eventKey(event: ClientEvent): string {
        return [
            this.principalKey(event),
            this.idKey('event-at', this.timeKey(event.occurredAtEpochMs)),
            this.idKey('event', event.eventId),
        ].join(':');
    }
}
