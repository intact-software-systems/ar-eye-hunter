import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest,
} from '@shared/api/state-types.ts';
import {
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID,
    type StateScope,
} from '@shared/api/state-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    ResourceInboxResultsRepository
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type {
    ClientStateService,
    ClientStateWritten,
    RegisterAuthorisedWsClientInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import {
    AppInboxEnqueueInput,
    AppInboxService,
    type AppInboxServiceOptions,
    AppInboxType,
    SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { isCompletedOrFailed } from '@shared/queuebox/ResourceEntry.ts';
import type { RallarTimingSink } from './timing.ts';

export {
    AppInboxService,
    AppInboxType,
    type AppInboxEnqueueInput,
    type AppInboxServiceOptions,
} from '@shared-server/rallar-system/services/AppInboxService.ts';

export type ClientPrincipalUpsertAppInboxPayload = Readonly<{
    scope: StateScope;
    principalId: string;
    request: UpsertClientPrincipalRequest;
}>;

export type ClientInstanceUpsertAppInboxPayload = Readonly<{
    scope: StateScope;
    principalId: string;
    clientInstanceId: string;
    request: UpsertClientInstanceRequest;
}>;

export type ClientSessionConnectAppInboxPayload = Readonly<{
    scope: StateScope;
    principalId: string;
    clientInstanceId: string;
    sessionId: string;
    request: ConnectClientSessionRequest;
}>;

export type ClientSessionHeartbeatAppInboxPayload = Readonly<{
    scope: StateScope;
    principalId: string;
    clientInstanceId: string;
    sessionId: string;
    request: HeartbeatClientSessionRequest;
}>;

export type ClientSessionDisconnectAppInboxPayload = Readonly<{
    scope: StateScope;
    principalId: string;
    clientInstanceId: string;
    sessionId: string;
    request: DisconnectClientSessionRequest;
}>;

export type ClientAuthorisedWsSessionConnectAppInboxPayload = Readonly<{
    authSession: Omit<AuthSession, 'accessToken'>;
    input: RegisterAuthorisedWsClientInput;
}>;

export type ClientAuthorisedWsSessionDisconnectAppInboxPayload = Readonly<{
    sessionId: string;
    reason: string;
}>;

export type ClientExpiredSessionsAppInboxPayload = Readonly<{
    atEpochMs: number;
}>;

export class AppClientInboxService extends AppInboxService {
    constructor(
        public override readonly inbox: InboxQueueReader,
        public override readonly resourceInbox: ResourceInboxRepository,
        public override readonly resourceInboxResults: ResourceInboxResultsRepository,
        public readonly clientStateService: ClientStateService,
        public readonly stateSyncPublisher: StateSyncPublisher,
        public override readonly serviceId: string,
        timing?: RallarTimingSink,
        options?: AppInboxServiceOptions,
    ) {
        super(
            inbox,
            resourceInbox,
            resourceInboxResults,
            serviceId,
            SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
            timing,
            options,
        );

        this.onStateMessage<ClientPrincipalUpsertAppInboxPayload>(
            AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            async (principal) => {
                const clientStateWritten =
                    await this.clientStateService.upsertPrincipal(
                        principal.scope,
                        principal.principalId,
                        principal.request,
                    );

                return clientStateWritten;
            },
        );
        this.onStateMessage<ClientInstanceUpsertAppInboxPayload>(
            AppInboxType.CLIENT_INSTANCE_UPSERT,
            async (instance) => {
                const clientStateWritten = await this.clientStateService.upsertInstance(
                    instance.scope,
                    instance.principalId,
                    instance.clientInstanceId,
                    instance.request,
                );

                return clientStateWritten;
            },
        );
        this.onStateMessage<ClientSessionConnectAppInboxPayload>(
            AppInboxType.CLIENT_SESSION_CONNECT,
            async (session) => {
                const clientStateWritten = await this.clientStateService.connectSession(
                    session.scope,
                    session.principalId,
                    session.clientInstanceId,
                    session.sessionId,
                    session.request,
                );

                return clientStateWritten;
            },
        );
        this.onStateMessage<ClientSessionHeartbeatAppInboxPayload>(
            AppInboxType.CLIENT_SESSION_HEARTBEAT,
            async (session) => {
                const clientStateWritten =
                    await this.clientStateService.heartbeatSession(
                        session.scope,
                        session.principalId,
                        session.clientInstanceId,
                        session.sessionId,
                        session.request,
                    );

                return clientStateWritten;
            },
        );
        this.onStateMessage<ClientSessionDisconnectAppInboxPayload>(
            AppInboxType.CLIENT_SESSION_DISCONNECT,
            async (session) => {
                const clientStateWritten =
                    await this.clientStateService.disconnectSession(
                        session.scope,
                        session.principalId,
                        session.clientInstanceId,
                        session.sessionId,
                        session.request,
                    );

                return clientStateWritten;
            },
        );
        this.onStateMessage<ClientAuthorisedWsSessionConnectAppInboxPayload>(
            AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
            async (session) => {
                const clientStateWritten =
                    await this.clientStateService.registerAuthorisedWsClientSession(
                        {
                            ...session.authSession,
                            accessToken: '',
                        },
                        session.input,
                    );

                return clientStateWritten;
            },
        );
        this.onStateMessage<ClientAuthorisedWsSessionDisconnectAppInboxPayload>(
            AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
            async (session) => {
                const clientStateWritten =
                    await this.clientStateService.disconnectAuthorisedWsClientSession(
                        session.sessionId,
                        session.reason,
                    );

                return clientStateWritten;
            },
        );
        this.onStateMessage<ClientExpiredSessionsAppInboxPayload>(
            AppInboxType.CLIENT_EXPIRED_SESSIONS,
            async (input) => {
                const clientStateWrittenResults =
                    await this.clientStateService.expireExpiredSessions(
                        input.atEpochMs,
                    );

                return clientStateWrittenResults;
            },
        );
    }

    public async processAuthorisedWsClientConnect(
        authSession: AuthSession,
        input?: RegisterAuthorisedWsClientInput,
    ) {
        const scope = toAuthorisedWsClientScope(input);
        const principalId = input?.principalId ?? authSession.clientId;
        const clientInstanceId = input?.clientInstanceId ?? authSession.clientId;

        return await this.processEntryUntilCompletion<
            ClientAuthorisedWsSessionConnectAppInboxPayload,
            ClientStateWritten
        >({
            type: AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
            resourceId: toAuthorisedWsClientConnectResourceId(
                scope,
                principalId,
                clientInstanceId,
                authSession.sessionId,
            ),
            contextId: toClientAppInboxContextId(scope, principalId),
            senderId: authSession.clientId,
            data: {
                authSession: {
                    clientId: authSession.clientId,
                    username: authSession.username,
                    sessionId: authSession.sessionId,
                    expiresAtEpochMs: authSession.expiresAtEpochMs,
                },
                input: input ?? {},
            },
        });
    }

    public async processAuthorisedWsClientDisconnect(
        sessionId: string,
        reason?: string,
    ) {
        const disconnectReason = reason ?? 'websocket-closed';
        return await this.processEntryUntilCompletion<
            ClientAuthorisedWsSessionDisconnectAppInboxPayload,
            ClientStateWritten
        >({
            type: AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
            resourceId: `authorised-ws-disconnect-${sessionId}`,
            contextId: sessionId,
            senderId: sessionId,
            data: {
                sessionId,
                reason: disconnectReason,
            },
        });
    }

    public async processExpiredSessions(atEpochMs: number = Date.now()) {
        return await this.processEntryUntilCompletionIf<
            ClientExpiredSessionsAppInboxPayload,
            readonly ClientStateWritten[]
        >(
            this.toExpiredSessionsEnqueue(atEpochMs),
            entry => isCompletedOrFailed(entry.status),
        );
    }

    public processExpiredSessionsNoWaiting(atEpochMs: number = Date.now()): void {
        this.processEntryNoWaitingIf<ClientExpiredSessionsAppInboxPayload>(
            this.toExpiredSessionsEnqueue(atEpochMs),
            entry => isCompletedOrFailed(entry.status),
        );
    }

    private toExpiredSessionsEnqueue(
        atEpochMs: number
    ): AppInboxEnqueueInput<ClientExpiredSessionsAppInboxPayload> {
        return {
            type: AppInboxType.CLIENT_EXPIRED_SESSIONS,
            topicId: AppInboxType.CLIENT_EXPIRED_SESSIONS,
            resourceId: `expire-client-sessions`,
            contextId: 'expire-client-sessions',
            senderId: this.serviceId,
            data: {
                atEpochMs,
            },
        };
    }
}

function toAuthorisedWsClientScope(
    input?: RegisterAuthorisedWsClientInput,
): StateScope {
    return {
        applicationId: input?.applicationId ?? DEFAULT_STATE_APPLICATION_ID,
        workspaceId: input?.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
    };
}

function toAuthorisedWsClientConnectResourceId(
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
): string {
    return [
        'authorised-ws-connect',
        scope.applicationId,
        scope.workspaceId,
        principalId,
        clientInstanceId,
        sessionId,
    ].map(encodeURIComponent).join(':');
}

function toClientAppInboxContextId(
    scope: StateScope,
    principalId: string,
): string {
    return [
        scope.applicationId,
        scope.workspaceId,
        principalId,
    ].map(encodeURIComponent).join(':');
}
