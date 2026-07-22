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
import {
    requiresClientWrite,
    toClientMutationCommand,
    toClientStateWritten,
    toConnectCommandInput,
    toDisconnectCommandInput,
    toExpiryCommandInput,
    toHeartbeatCommandInput,
    toUpsertInstanceCommandInput,
    toUpsertPrincipalCommandInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import {
    AppInboxEnqueueInput,
    AppInboxService,
    type AppInboxServiceOptions,
    AppInboxType,
    SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { isCompletedOrFailed } from '@shared/queuebox/ResourceEntry.ts';
import type { RallarTimingSink } from './timing.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { AppInboxMessageContext } from './app-inbox-contracts.ts';
import type {
    ClientMutationCommand,
    ClientMutationCommandInput,
    ClientMutationComputed,
} from './client-state-mutations.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';

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
    generationId: string;
    input: RegisterAuthorisedWsClientInput;
}>;

export type ClientAuthorisedWsSessionDisconnectAppInboxPayload = Readonly<{
    sessionId: string;
    generationId: string;
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
        database: PSqlSql,
        public readonly clientStateService: ClientStateService,
        public override readonly serviceId: string,
        timing?: RallarTimingSink,
        options?: AppInboxServiceOptions,
    ) {
        super(
            inbox,
            resourceInbox,
            resourceInboxResults,
            database,
            serviceId,
            SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
            timing,
            options,
        );

        this.onStateMessage<ClientPrincipalUpsertAppInboxPayload>(
            AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            async (principal, context) =>
                await this.processCommand(
                    context,
                    toUpsertPrincipalCommandInput(
                        principal.scope,
                        principal.principalId,
                        principal.request,
                        context.entry.key.resourceId,
                    ),
                ),
        );
        this.onStateMessage<ClientInstanceUpsertAppInboxPayload>(
            AppInboxType.CLIENT_INSTANCE_UPSERT,
            async (instance, context) =>
                await this.processCommand(
                    context,
                    toUpsertInstanceCommandInput(
                        instance.scope,
                        instance.principalId,
                        instance.clientInstanceId,
                        instance.request,
                        context.entry.key.resourceId,
                    ),
                ),
        );
        this.onStateMessage<ClientSessionConnectAppInboxPayload>(
            AppInboxType.CLIENT_SESSION_CONNECT,
            async (session, context) =>
                await this.processCommand(
                    context,
                    toConnectCommandInput(
                        'connectSession',
                        session.scope,
                        session.principalId,
                        session.clientInstanceId,
                        session.sessionId,
                        session.request,
                        context.entry.key.resourceId,
                        {},
                    ),
                ),
        );
        this.onStateMessage<ClientSessionHeartbeatAppInboxPayload>(
            AppInboxType.CLIENT_SESSION_HEARTBEAT,
            async (session, context) =>
                await this.processCommand(
                    context,
                    toHeartbeatCommandInput(
                        session.scope,
                        session.principalId,
                        session.clientInstanceId,
                        session.sessionId,
                        session.request,
                        context.entry.key.resourceId,
                    ),
                ),
        );
        this.onStateMessage<ClientSessionDisconnectAppInboxPayload>(
            AppInboxType.CLIENT_SESSION_DISCONNECT,
            async (session, context) =>
                await this.processCommand(
                    context,
                    toDisconnectCommandInput(
                        'disconnectSession',
                        session.scope,
                        session.principalId,
                        session.clientInstanceId,
                        session.sessionId,
                        session.request,
                        context.entry.key.resourceId,
                    ),
                ),
        );
        this.onStateMessage<ClientAuthorisedWsSessionConnectAppInboxPayload>(
            AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
            async (session, context) => {
                const scope = toAuthorisedWsClientScope(session.input);
                const principalId = session.input.principalId ?? session.authSession.clientId;
                const clientInstanceId =
                    session.input.clientInstanceId ?? session.authSession.clientId;
                const requestId =
                    `authorised-ws:connect:${session.authSession.sessionId}:${session.generationId}`;
                return await this.processCommand(
                    context,
                    toConnectCommandInput(
                        'connectAuthorisedWsSession',
                        scope,
                        principalId,
                        clientInstanceId,
                        session.authSession.sessionId,
                        {
                            generationId: session.generationId,
                            presenceState: 'online',
                            transport: 'ws',
                            connectionId: session.generationId,
                            connectedAtEpochMs: session.input.connectedAtEpochMs,
                            expiresAtEpochMs:
                                session.input.expiresAtEpochMs ??
                                session.authSession.expiresAtEpochMs,
                            actorPrincipalId: principalId,
                            actorSessionId: session.authSession.sessionId,
                            requestId,
                        },
                        requestId,
                        {
                            platform: session.input.platform,
                            userAgent: session.input.userAgent,
                            capabilities: session.input.capabilities,
                            principalUsername: session.authSession.username,
                            principalDisplayName:
                                session.input.displayName ?? session.authSession.username,
                            principalRoles: ['member'],
                        },
                    ),
                );
            },
        );
        this.onStateMessage<ClientAuthorisedWsSessionDisconnectAppInboxPayload>(
            AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
            async (input, context) => {
                const session = await this.clientStateService.findSessionBySessionId(
                    input.sessionId,
                );
                if (!session) {
                    throw new NonRetryableException(
                        `Durable client connection generation not found: ${input.sessionId}`,
                    );
                }
                return await this.processCommand(
                    context,
                    toDisconnectCommandInput(
                        'disconnectAuthorisedWsSession',
                        {
                            applicationId: session.applicationId,
                            workspaceId: session.workspaceId,
                        },
                        session.principalId,
                        session.clientInstanceId,
                        input.sessionId,
                        {
                            generationId: input.generationId,
                            reason: input.reason,
                            actorPrincipalId: session.principalId,
                            actorSessionId: input.sessionId,
                            requestId:
                                `authorised-ws:disconnect:${input.sessionId}:${input.generationId}`,
                        },
                        context.entry.key.resourceId,
                    ),
                );
            },
        );
        this.onStateMessage<ClientExpiredSessionsAppInboxPayload>(
            AppInboxType.CLIENT_EXPIRED_SESSIONS,
            async (input, context) =>
                await this.processExpiredSessionCommands(context, input.atEpochMs),
        );
    }

    private async processCommand(
        context: AppInboxMessageContext,
        input: ClientMutationCommandInput,
    ): Promise<ClientStateWritten> {
        const command = await this.toCommand(context, input);
        const read = await this.clientStateService.read(command);
        const computed = this.clientStateService.compute(command, read);
        this.clientStateService.validate(command, read, computed);
        return await this.commitComputed(context, computed);
    }

    private async toCommand(
        context: AppInboxMessageContext,
        input: ClientMutationCommandInput,
    ): Promise<ClientMutationCommand> {
        const createdAtEpochMs = context.message.id.ts;
        return await toClientMutationCommand(input, {
            nowEpochMs: createdAtEpochMs,
            serviceId: this.serviceId,
            eventId: `client-event:${JSON.stringify([
                context.entry.key.contextId,
                context.entry.key.topicId,
                input.commandId,
            ])}`,
            attemptCount: context.entry.dequeueAudit.attempts,
            expireAtEpochMs: Number(context.entry.audit.expiryTs.epochMilliseconds),
        });
    }

    private async commitComputed(
        context: AppInboxMessageContext,
        computed: ClientMutationComputed,
    ): Promise<ClientStateWritten> {
        if (computed.outcome === 'idempotency-conflict') {
            throw new Error('Validated client idempotency conflict is unreachable');
        }
        const written = toClientStateWritten(computed);
        const result = await this.writeMutation(context, async (transaction) => {
            if (requiresClientWrite(computed)) {
                await this.clientStateService.write(transaction, computed);
            }
            return written;
        });
        await this.clientStateService.observeSnapshot(computed.snapshot);
        return result;
    }

    private async processExpiredSessionCommands(
        context: AppInboxMessageContext,
        atEpochMs: number,
    ): Promise<readonly ClientStateWritten[]> {
        const candidates = await this.clientStateService.listExpiredSessionCandidates(atEpochMs);
        const computed: ClientMutationComputed[] = [];
        for (const candidate of candidates) {
            const command = await this.toCommand(context, toExpiryCommandInput(candidate));
            const read = await this.clientStateService.read(command);
            const successor = this.clientStateService.compute(command, read);
            this.clientStateService.validate(command, read, successor);
            computed.push(successor);
        }
        const applied = computed.filter((successor) => successor.outcome === 'write');
        const results = applied.map(toClientStateWritten);
        const committed = await this.writeMutation(context, async (transaction) => {
            for (const successor of computed) {
                if (requiresClientWrite(successor)) {
                    await this.clientStateService.write(transaction, successor);
                }
            }
            return results;
        });
        for (const successor of applied) {
            await this.clientStateService.observeSnapshot(successor.snapshot);
        }
        return committed;
    }

    public async processAuthorisedWsClientConnect(
        authSession: AuthSession,
        generationId: string,
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
                generationId,
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
                generationId,
                input: input ?? {},
            },
        });
    }

    public async processAuthorisedWsClientDisconnect(
        sessionId: string,
        generationId: string,
        reason?: string,
    ) {
        const disconnectReason = reason ?? 'websocket-closed';
        return await this.processEntryUntilCompletion<
            ClientAuthorisedWsSessionDisconnectAppInboxPayload,
            ClientStateWritten
        >({
            type: AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
            resourceId: `authorised-ws-disconnect-${sessionId}-${generationId}`,
            contextId: sessionId,
            senderId: sessionId,
            data: {
                sessionId,
                generationId,
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
    generationId: string,
): string {
    return [
        'authorised-ws-connect',
        scope.applicationId,
        scope.workspaceId,
        principalId,
        clientInstanceId,
        sessionId,
        generationId,
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
