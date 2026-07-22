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
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority,
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
    ClientMutationAuthority,
    ClientMutationCommand,
    ClientMutationCommandInput,
    ClientMutationComputed,
} from './client-state-mutations.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { IssuedAuthSession } from '../repositories/AuthSessionRepository.ts';

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
    authSession: Omit<IssuedAuthSession, 'accessToken'>;
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

    public override async processEntryUntilCompletion<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
    ): Promise<import('@shared/resilience/Either.ts').Either<string, R>> {
        void enqueue;
        throw new NonRetryableException(
            'Authenticated client mutation authority is required.',
        );
    }

    public override async processEntryUntilCompletionIf<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: import('@shared/queuebox/ResourceEntry.ts').ResourceEntry) => boolean,
    ): Promise<import('@shared/resilience/Either.ts').Either<string, R>> {
        void enqueue;
        void enqueueIf;
        throw new NonRetryableException(
            'Authenticated client mutation authority is required.',
        );
    }

    public async processAuthenticatedEntryUntilCompletion<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        authority: IssuedAuthSession,
    ): Promise<import('@shared/resilience/Either.ts').Either<string, R>> {
        const ingress = readAuthenticatedClientMutationIngress(enqueue);
        validateIssuedClientMutationIngress(authority, ingress);
        return await super.processEntryUntilCompletion<V, R>({
            ...enqueue,
            authority: toClientMutationIssuedSessionAuthority(
                authority,
                ingress.scope,
                ingress.operation,
            ),
        });
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
        return await toClientMutationCommand(
            input,
            {
                nowEpochMs: createdAtEpochMs,
                serviceId: this.serviceId,
                eventId: `client-event:${JSON.stringify([
                    context.entry.key.contextId,
                    context.entry.key.topicId,
                    input.commandId,
                ])}`,
                attemptCount: context.entry.dequeueAudit.attempts,
                expireAtEpochMs: Number(context.entry.audit.expiryTs.epochMilliseconds),
            },
            readClientMutationAuthority(context.enqueue.authority, input.operation),
        );
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
        authSession: IssuedAuthSession,
        generationId: string,
        input?: RegisterAuthorisedWsClientInput,
    ) {
        const scope = toAuthorisedWsClientScope(input);
        const principalId = input?.principalId ?? authSession.clientId;
        const clientInstanceId = input?.clientInstanceId ?? authSession.clientId;

        return await super.processEntryUntilCompletion<
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
            authority: toClientMutationIssuedSessionAuthority(
                authSession,
                scope,
                'connectAuthorisedWsSession',
            ),
            data: {
                authSession: {
                    clientId: authSession.clientId,
                    username: authSession.username,
                    sessionId: authSession.sessionId,
                    issuedAtEpochMs: authSession.issuedAtEpochMs,
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
        const [authSession, session] = await Promise.all([
            this.clientStateService.readIssuedAuthSession(sessionId),
            this.clientStateService.findSessionBySessionId(sessionId),
        ]);
        if (!authSession || !session) {
            throw new NonRetryableException(
                `Durable authorised WebSocket authority not found: ${sessionId}`,
            );
        }
        const scope = {
            applicationId: session.applicationId,
            workspaceId: session.workspaceId,
        };
        if (authSession.clientId !== session.principalId) {
            throw new NonRetryableException(
                'Durable authorised WebSocket principal differs from auth session.',
            );
        }
        return await super.processEntryUntilCompletion<
            ClientAuthorisedWsSessionDisconnectAppInboxPayload,
            ClientStateWritten
        >({
            type: AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
            resourceId: `authorised-ws-disconnect-${sessionId}-${generationId}`,
            contextId: sessionId,
            senderId: sessionId,
            authority: toClientMutationIssuedSessionAuthority(
                authSession,
                scope,
                'disconnectAuthorisedWsSession',
            ),
            data: {
                sessionId,
                generationId,
                reason: disconnectReason,
            },
        });
    }

    public async processExpiredSessions(atEpochMs: number = Date.now()) {
        return await super.processEntryUntilCompletionIf<
            ClientExpiredSessionsAppInboxPayload,
            readonly ClientStateWritten[]
        >(
            this.toExpiredSessionsEnqueue(atEpochMs),
            entry => isCompletedOrFailed(entry.status),
        );
    }

    public processExpiredSessionsNoWaiting(atEpochMs: number = Date.now()): void {
        super.processEntryNoWaitingIf<ClientExpiredSessionsAppInboxPayload>(
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
            authority: toClientMutationSystemAuthority(this.serviceId),
            data: {
                atEpochMs,
            },
        };
    }
}

type AuthenticatedClientMutationIngress = Readonly<{
    scope: StateScope;
    operation: Exclude<ClientMutationCommand['operation'], 'expireSession'>;
    principalId: string;
    sessionId: string | null;
    actorPrincipalId: string | null;
    actorSessionId: string | null;
    senderId: string;
}>;

function readAuthenticatedClientMutationIngress(
    enqueue: AppInboxEnqueueInput<unknown>,
): AuthenticatedClientMutationIngress {
    const data = requireClientIngressRecord(enqueue.data, 'Client mutation payload');
    const scope = readClientIngressScope(data.scope);
    const principalId = requireClientIngressString(
        data.principalId,
        'Client mutation principalId',
    );
    const request = requireClientIngressRecord(
        data.request,
        'Client mutation request',
    );
    const actorPrincipalId = readNullableClientIngressString(
        request.actorPrincipalId,
        'Client mutation actorPrincipalId',
    );
    const actorSessionId = readNullableClientIngressString(
        request.actorSessionId,
        'Client mutation actorSessionId',
    );
    const senderId = requireClientIngressString(
        enqueue.senderId,
        'Client mutation senderId',
    );
    switch (enqueue.type) {
        case AppInboxType.CLIENT_PRINCIPAL_UPSERT:
            return {
                scope,
                operation: 'upsertPrincipal',
                principalId,
                sessionId: null,
                actorPrincipalId,
                actorSessionId,
                senderId,
            };
        case AppInboxType.CLIENT_INSTANCE_UPSERT:
            requireClientIngressString(
                data.clientInstanceId,
                'Client mutation clientInstanceId',
            );
            return {
                scope,
                operation: 'upsertInstance',
                principalId,
                sessionId: null,
                actorPrincipalId,
                actorSessionId,
                senderId,
            };
        case AppInboxType.CLIENT_SESSION_CONNECT:
        case AppInboxType.CLIENT_SESSION_HEARTBEAT:
        case AppInboxType.CLIENT_SESSION_DISCONNECT:
            requireClientIngressString(
                data.clientInstanceId,
                'Client mutation clientInstanceId',
            );
            return {
                scope,
                operation: enqueue.type === AppInboxType.CLIENT_SESSION_CONNECT
                    ? 'connectSession'
                    : enqueue.type === AppInboxType.CLIENT_SESSION_HEARTBEAT
                    ? 'heartbeatSession'
                    : 'disconnectSession',
                principalId,
                sessionId: requireClientIngressString(
                    data.sessionId,
                    'Client mutation sessionId',
                ),
                actorPrincipalId,
                actorSessionId,
                senderId,
            };
        default:
            throw new NonRetryableException(
                'App inbox type is not an authenticated client mutation.',
            );
    }
}

function validateIssuedClientMutationIngress(
    authority: IssuedAuthSession,
    ingress: AuthenticatedClientMutationIngress,
): void {
    if (
        !authority.accessToken || !authority.sessionId || !authority.clientId ||
        authority.issuedAtEpochMs >= authority.expiresAtEpochMs ||
        authority.expiresAtEpochMs <= Date.now()
    ) {
        throw new NonRetryableException(
            'Authenticated client mutation session is invalid or expired.',
        );
    }
    if (
        ingress.principalId !== authority.clientId ||
        ingress.senderId !== authority.clientId ||
        ingress.actorPrincipalId !== null &&
            ingress.actorPrincipalId !== authority.clientId ||
        ingress.actorSessionId !== null &&
            ingress.actorSessionId !== authority.sessionId ||
        ingress.sessionId !== null && ingress.sessionId !== authority.sessionId
    ) {
        throw new NonRetryableException(
            'Authenticated client mutation principal or session authority differs.',
        );
    }
}

function readClientMutationAuthority(
    authority: unknown,
    operation: ClientMutationCommandInput['operation'],
): ClientMutationAuthority {
    const value = requireClientIngressRecord(authority, 'Client mutation authority');
    if (value.kind === 'issued-session') {
        const proof: ClientMutationAuthority = {
            kind: 'issued-session',
            version: requireClientAuthorityVersion(value.version),
            principalId: requireClientIngressString(
                value.principalId,
                'Client mutation authority principalId',
            ),
            sessionId: requireClientIngressString(
                value.sessionId,
                'Client mutation authority sessionId',
            ),
            sessionIssuedAtEpochMs: requireClientIngressTimestamp(
                value.sessionIssuedAtEpochMs,
                'Client mutation authority issuedAtEpochMs',
            ),
            sessionExpiresAtEpochMs: requireClientIngressTimestamp(
                value.sessionExpiresAtEpochMs,
                'Client mutation authority expiresAtEpochMs',
            ),
            applicationId: requireClientIngressString(
                value.applicationId,
                'Client mutation authority applicationId',
            ),
            workspaceId: requireClientIngressString(
                value.workspaceId,
                'Client mutation authority workspaceId',
            ),
            operation: readIssuedClientAuthorityOperation(value.operation),
        };
        if (proof.operation !== operation) {
            throw new NonRetryableException(
                'Client mutation authority operation differs from command.',
            );
        }
        return proof;
    }
    if (value.kind === 'system') {
        const proof: ClientMutationAuthority = {
            kind: 'system',
            version: requireClientAuthorityVersion(value.version),
            serviceId: requireClientIngressString(
                value.serviceId,
                'Client mutation authority serviceId',
            ),
            operation: value.operation === 'expireSession'
                ? value.operation
                : invalidClientAuthorityOperation(),
        };
        if (operation !== 'expireSession') {
            throw new NonRetryableException(
                'System authority is only valid for client session expiry.',
            );
        }
        return proof;
    }
    throw new NonRetryableException('Client mutation authority kind is invalid.');
}

function readIssuedClientAuthorityOperation(
    operation: unknown,
): Exclude<ClientMutationCommand['operation'], 'expireSession'> {
    switch (operation) {
        case 'upsertPrincipal':
        case 'upsertInstance':
        case 'connectSession':
        case 'connectAuthorisedWsSession':
        case 'heartbeatSession':
        case 'disconnectSession':
        case 'disconnectAuthorisedWsSession':
            return operation;
        default:
            return invalidClientAuthorityOperation();
    }
}

function invalidClientAuthorityOperation(): never {
    throw new NonRetryableException('Client mutation authority operation is invalid.');
}

function requireClientIngressRecord(
    value: unknown,
    label: string,
): Readonly<Record<string, unknown>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new NonRetryableException(`${label} must be an object.`);
    }
    return Object.fromEntries(Object.entries(value));
}

function readClientIngressScope(value: unknown): StateScope {
    const scope = requireClientIngressRecord(value, 'Client mutation scope');
    return {
        applicationId: requireClientIngressString(
            scope.applicationId,
            'Client mutation applicationId',
        ),
        workspaceId: requireClientIngressString(
            scope.workspaceId,
            'Client mutation workspaceId',
        ),
    };
}

function readNullableClientIngressString(
    value: unknown,
    label: string,
): string | null {
    return value === undefined || value === null
        ? null
        : requireClientIngressString(value, label);
}

function requireClientIngressString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new NonRetryableException(`${label} is required.`);
    }
    return value;
}

function requireClientIngressTimestamp(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new NonRetryableException(`${label} is invalid.`);
    }
    return value;
}

function requireClientAuthorityVersion(value: unknown): 1 {
    if (value !== 1) {
        throw new NonRetryableException('Client mutation authority version is invalid.');
    }
    return value;
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
