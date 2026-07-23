import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest,
} from '@shared/api/state-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type {
    ClientStateService,
    ClientStateWritten,
    RegisterAuthorisedWsClientInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import {
    requiresClientWrite,
    toClientMutationCommand,
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority,
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
    ClientMutationAuthority,
    ClientMutationCommand,
    ClientMutationCommandInput,
    ClientMutationComputed,
} from './client-state-mutations.ts';
import { validateClientMutationAuthorityPolicy } from './client-state-mutations.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { IssuedAuthSession } from '../repositories/AuthSessionRepository.ts';
import {
    toAuthorisedWsClientConnectEnqueue,
    type ToAuthorisedWsClientConnectEnqueueInput,
    toAuthorisedWsClientDisconnectEnqueue,
    type ToAuthorisedWsClientDisconnectEnqueueInput,
} from './authorised-ws-client-app-inbox.ts';
import type {
    WsSessionGenerationFacts,
    WsSessionGenerationLifecycleComputed,
} from './ws-session-generation-lifecycle.ts';

export {
    type AppInboxEnqueueInput,
    AppInboxService,
    type AppInboxServiceOptions,
    AppInboxType,
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
    generationStartedAtEpochMs: number;
    scope: StateScope;
    principalId: string;
    clientInstanceId: string;
    displayName: string;
    userAgent: string | null;
    platform: NonNullable<RegisterAuthorisedWsClientInput['platform']>;
    capabilities: readonly string[];
    expiresAtEpochMs: number;
}>;

export type ClientAuthorisedWsSessionDisconnectAppInboxPayload = Readonly<{
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
    disconnectedAtEpochMs: number;
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
            async (session, context) => await this.processAuthorisedWsConnect(session, context),
        );
        this.onStateMessage<ClientAuthorisedWsSessionDisconnectAppInboxPayload>(
            AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
            async (input, context) => await this.processAuthorisedWsDisconnect(input, context),
        );
        this.onStateMessage<ClientExpiredSessionsAppInboxPayload>(
            AppInboxType.CLIENT_EXPIRED_SESSIONS,
            async (input, context) =>
                await this.processExpiredSessionCommands(context, input.atEpochMs),
        );
    }

    public override processEntryUntilCompletion<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
    ): Promise<import('@shared/resilience/Either.ts').Either<string, R>> {
        void enqueue;
        return Promise.reject(
            new NonRetryableException('Authenticated client mutation authority is required.'),
        );
    }

    public override processEntryUntilCompletionIf<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: import('@shared/queuebox/ResourceEntry.ts').ResourceEntry) => boolean,
    ): Promise<import('@shared/resilience/Either.ts').Either<string, R>> {
        void enqueue;
        void enqueueIf;
        return Promise.reject(
            new NonRetryableException('Authenticated client mutation authority is required.'),
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

    private async processAuthorisedWsConnect(
        connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
        context: AppInboxMessageContext,
    ): Promise<unknown> {
        const lifecycle = this.clientStateService.sessionGenerationLifecycle;
        const lifecycleFacts = toWsSessionGenerationFacts(connection);
        const lifecycleRead = await lifecycle.read(lifecycleFacts);
        const lifecycleComputed = lifecycle.computeOpen(lifecycleFacts, lifecycleRead);
        if (lifecycleComputed.state.status === 'closed') {
            return await this.writeMutation(context, () =>
                Promise.resolve({
                    status: 'inactive',
                    sessionId: connection.authSession.sessionId,
                    generationId: connection.generationId,
                }),
            );
        }
        const requestId = `authorised-ws:connect:${connection.authSession.sessionId}:${connection.generationId}`;
        const command = await this.toCommand(
            context,
            toConnectCommandInput(
                'connectAuthorisedWsSession',
                connection.scope,
                connection.principalId,
                connection.clientInstanceId,
                connection.authSession.sessionId,
                {
                    generationId: connection.generationId,
                    presenceState: 'online',
                    transport: 'ws',
                    connectionId: connection.generationId,
                    connectedAtEpochMs: connection.generationStartedAtEpochMs,
                    expiresAtEpochMs: connection.expiresAtEpochMs,
                    actorPrincipalId: connection.principalId,
                    actorSessionId: connection.authSession.sessionId,
                    requestId,
                },
                requestId,
                {
                    platform: connection.platform,
                    userAgent: connection.userAgent ?? undefined,
                    capabilities: connection.capabilities,
                    principalUsername: connection.authSession.username,
                    principalDisplayName: connection.displayName,
                    principalRoles: ['member'],
                },
            ),
        );
        const read = await this.clientStateService.read(command);
        const computed = this.clientStateService.compute(command, read);
        this.clientStateService.validate(command, read, computed);
        return await this.commitComputed(context, computed, lifecycleComputed);
    }

    private async processAuthorisedWsDisconnect(
        input: ClientAuthorisedWsSessionDisconnectAppInboxPayload,
        context: AppInboxMessageContext,
    ): Promise<unknown> {
        const connection = input.connection;
        const lifecycle = this.clientStateService.sessionGenerationLifecycle;
        const lifecycleFacts = {
            ...toWsSessionGenerationFacts(connection),
            disconnectedAtEpochMs: input.disconnectedAtEpochMs,
            reason: input.reason,
        };
        const lifecycleRead = await lifecycle.read(lifecycleFacts);
        const lifecycleComputed = lifecycle.computeClosed(lifecycleFacts, lifecycleRead);
        const command = await this.toCommand(
            context,
            toDisconnectCommandInput(
                'disconnectAuthorisedWsSession',
                connection.scope,
                connection.principalId,
                connection.clientInstanceId,
                connection.authSession.sessionId,
                {
                    generationId: connection.generationId,
                    disconnectedAtEpochMs: input.disconnectedAtEpochMs,
                    reason: input.reason,
                    actorPrincipalId: connection.principalId,
                    actorSessionId: connection.authSession.sessionId,
                    requestId: `authorised-ws:disconnect:${connection.authSession.sessionId}:${connection.generationId}`,
                },
                context.entry.key.resourceId,
            ),
        );
        const read = await this.clientStateService.read(command);
        if (!read.session) {
            validateClientMutationAuthorityPolicy(command, read);
            return await this.writeMutation(context, async (transaction) => {
                await lifecycle.write(transaction, lifecycleComputed);
                return {
                    status: 'inactive',
                    sessionId: connection.authSession.sessionId,
                    generationId: connection.generationId,
                };
            });
        }
        const computed = this.clientStateService.compute(command, read);
        this.clientStateService.validate(command, read, computed);
        return await this.commitComputed(context, computed, lifecycleComputed);
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
        lifecycleComputed?: WsSessionGenerationLifecycleComputed,
    ): Promise<ClientStateWritten> {
        if (computed.outcome === 'idempotency-conflict') {
            throw new Error('Validated client idempotency conflict is unreachable');
        }
        const written = toClientStateWritten(computed);
        const result = await this.writeMutation(context, async (transaction) => {
            if (lifecycleComputed) {
                await this.clientStateService.sessionGenerationLifecycle.write(
                    transaction,
                    lifecycleComputed,
                );
            }
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

    public async processAuthorisedWsClientConnect(input: ToAuthorisedWsClientConnectEnqueueInput) {
        return await super.processEntryUntilCompletion<
            ClientAuthorisedWsSessionConnectAppInboxPayload,
            ClientStateWritten
        >(toAuthorisedWsClientConnectEnqueue(input));
    }

    public async enqueueAuthorisedWsClientConnect(input: ToAuthorisedWsClientConnectEnqueueInput) {
        return await super.enqueue(toAuthorisedWsClientConnectEnqueue(input));
    }

    public async processAuthorisedWsClientDisconnect(
        input: ToAuthorisedWsClientDisconnectEnqueueInput,
    ) {
        return await super.processEntryUntilCompletion<
            ClientAuthorisedWsSessionDisconnectAppInboxPayload,
            ClientStateWritten
        >(toAuthorisedWsClientDisconnectEnqueue(input));
    }

    public async enqueueAuthorisedWsClientDisconnect(
        input: ToAuthorisedWsClientDisconnectEnqueueInput,
    ) {
        return await super.enqueue(toAuthorisedWsClientDisconnectEnqueue(input));
    }

    public async processExpiredSessions(atEpochMs: number = Date.now()) {
        return await super.processEntryUntilCompletionIf<
            ClientExpiredSessionsAppInboxPayload,
            readonly ClientStateWritten[]
        >(this.toExpiredSessionsEnqueue(atEpochMs), (entry) => isCompletedOrFailed(entry.status));
    }

    public async enqueueExpiredSessions(atEpochMs: number = Date.now()) {
        return await super.enqueue(
            this.toExpiredSessionsEnqueue(atEpochMs, `expire-client-sessions-${atEpochMs}`),
        );
    }

    private toExpiredSessionsEnqueue(
        atEpochMs: number,
        resourceId: string = 'expire-client-sessions',
    ): AppInboxEnqueueInput<ClientExpiredSessionsAppInboxPayload> {
        return {
            type: AppInboxType.CLIENT_EXPIRED_SESSIONS,
            topicId: AppInboxType.CLIENT_EXPIRED_SESSIONS,
            resourceId,
            contextId: 'expire-client-sessions',
            senderId: this.serviceId,
            authority: toClientMutationSystemAuthority(this.serviceId),
            data: {
                atEpochMs,
            },
        };
    }
}

function toWsSessionGenerationFacts(
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
): WsSessionGenerationFacts {
    return {
        sessionId: connection.authSession.sessionId,
        generationId: connection.generationId,
        generationStartedAtEpochMs: connection.generationStartedAtEpochMs,
    };
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
    const principalId = requireClientIngressString(data.principalId, 'Client mutation principalId');
    const request = requireClientIngressRecord(data.request, 'Client mutation request');
    const actorPrincipalId = readNullableClientIngressString(
        request.actorPrincipalId,
        'Client mutation actorPrincipalId',
    );
    const actorSessionId = readNullableClientIngressString(
        request.actorSessionId,
        'Client mutation actorSessionId',
    );
    const senderId = requireClientIngressString(enqueue.senderId, 'Client mutation senderId');
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
            requireClientIngressString(data.clientInstanceId, 'Client mutation clientInstanceId');
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
            requireClientIngressString(data.clientInstanceId, 'Client mutation clientInstanceId');
            return {
                scope,
                operation:
                    enqueue.type === AppInboxType.CLIENT_SESSION_CONNECT
                        ? 'connectSession'
                        : enqueue.type === AppInboxType.CLIENT_SESSION_HEARTBEAT
                          ? 'heartbeatSession'
                          : 'disconnectSession',
                principalId,
                sessionId: requireClientIngressString(data.sessionId, 'Client mutation sessionId'),
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
        !authority.accessToken ||
        !authority.sessionId ||
        !authority.clientId ||
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
        (ingress.actorPrincipalId !== null && ingress.actorPrincipalId !== authority.clientId) ||
        (ingress.actorSessionId !== null && ingress.actorSessionId !== authority.sessionId) ||
        (ingress.sessionId !== null && ingress.sessionId !== authority.sessionId)
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
            operation:
                value.operation === 'expireSession'
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
        workspaceId: requireClientIngressString(scope.workspaceId, 'Client mutation workspaceId'),
    };
}

function readNullableClientIngressString(value: unknown, label: string): string | null {
    return value === undefined || value === null ? null : requireClientIngressString(value, label);
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
