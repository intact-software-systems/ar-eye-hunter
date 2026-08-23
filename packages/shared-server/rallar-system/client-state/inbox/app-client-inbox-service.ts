import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { isCompletedOrFailed } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { AppInboxFailure } from '../../app-inbox/app-inbox-failure.ts';
import { AppInboxHandlerRegistry } from '../../app-inbox/app-inbox-handler-registry.ts';
import {
    AppInboxQueueClient,
    AppInboxType,
    SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
    type AppInboxEnqueueInput,
    type AppInboxOptions
} from '../../app-inbox/app-inbox-queue-client.ts';
import type { RallarTimingSink } from '../../observability/timing.ts';
import type { ClientStateService, ClientStateWritten } from '../client-state-service-contracts.ts';
import {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority
} from '../mutation/client-mutation-authority.ts';
import {
    toConnectCommandInput,
    toDisconnectCommandInput,
    toHeartbeatCommandInput,
    toUpsertInstanceCommandInput,
    toUpsertPrincipalCommandInput
} from '../mutation/client-mutation-command.ts';
import {
    type ClientAuthorisedWsSessionConnectAppInboxPayload,
    type ClientAuthorisedWsSessionDisconnectAppInboxPayload,
    type ClientExpiredSessionsAppInboxPayload,
    type ClientInstanceUpsertAppInboxPayload,
    type ClientPrincipalUpsertAppInboxPayload,
    type ClientSessionConnectAppInboxPayload,
    type ClientSessionDisconnectAppInboxPayload,
    type ClientSessionHeartbeatAppInboxPayload
} from './app-client-inbox-contracts.ts';
import {
    readAuthenticatedClientMutationIngress,
    validateIssuedClientMutationIngress
} from './authenticated-client-mutation-ingress.ts';
import {
    toAuthorisedWsClientConnectEnqueue,
    toAuthorisedWsClientDisconnectEnqueue,
    type ToAuthorisedWsClientConnectEnqueueInput,
    type ToAuthorisedWsClientDisconnectEnqueueInput
} from './authorised-ws-client-app-inbox.ts';
import { ClientStateInboxHandler } from './client-state-inbox-handler.ts';
import {
    decodeAuthorisedWsClientMutationResult,
    decodeClientStateWritten,
    decodeExpiredClientSessionsResult,
    type AuthorisedWsClientMutationResult
} from './client-state-inbox-result-codec.ts';

export namespace AppClientInboxService {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxRepository: AppInboxQueueClient.InboxRepository;
        readonly resourceInboxResultsRepository: AppInboxQueueClient.ResultRepository;
        readonly database: PSqlSql;
        readonly clientStateService: ClientStateService;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
        readonly wakeOwningQueue?: () => void;
    }
}

export class AppClientInboxService {
    private readonly queueClient: AppInboxQueueClient;
    private readonly handlers: AppInboxHandlerRegistry;
    private readonly handler: ClientStateInboxHandler;
    private readonly serviceId: string;

    public readonly clientStateService: ClientStateService;

    constructor(
        dependencies: AppClientInboxService.Dependencies,
        config: AppClientInboxService.Config
    ) {
        this.queueClient = new AppInboxQueueClient(
            {
                inboxQueueReader: dependencies.inboxQueueReader,
                resourceInboxRepository: dependencies.resourceInboxRepository,
                resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository
            },
            {
                serviceId: config.serviceId,
                defaultTopicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
                timing: config.timing,
                options: config.options,
                wakeOwningQueue: config.wakeOwningQueue
            }
        );
        this.handlers = new AppInboxHandlerRegistry(
            {
                inboxQueueReader: dependencies.inboxQueueReader,
                resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
                database: dependencies.database
            },
            {
                serviceId: config.serviceId,
                timing: config.timing,
                options: config.options
            }
        );
        this.serviceId = config.serviceId;
        this.clientStateService = dependencies.clientStateService;
        this.handler = new ClientStateInboxHandler({
            mutationService: dependencies.clientStateService,
            sessionGenerationLifecycle: dependencies.clientStateService.sessionGenerationLifecycle,
            expiryCandidates: dependencies.clientStateService,
            snapshotObserver: dependencies.clientStateService,
            transactionWriter: this.handlers.transactionWriter,
            serviceId: config.serviceId
        });
        this.registerClientStateMessages();
    }

    public async processAuthenticatedEntryUntilCompletion<V>(
        enqueue: AppInboxEnqueueInput<V>,
        authority: IssuedAuthSession
    ): Promise<Either<AppInboxFailure, ClientStateWritten>> {
        const ingress = readAuthenticatedClientMutationIngress(enqueue);
        validateIssuedClientMutationIngress(authority, ingress);
        const result = await this.queueClient.processEntryUntilCompletionResult(
            {
                ...enqueue,
                authority: toClientMutationIssuedSessionAuthority(
                    authority,
                    ingress.scope,
                    ingress.operation
                )
            },
            decodeClientStateWritten
        );
        return result;
    }

    public async processAuthorisedWsClientConnect(
        input: ToAuthorisedWsClientConnectEnqueueInput
    ): Promise<Either<AppInboxFailure, AuthorisedWsClientMutationResult>> {
        return await this.queueClient.processEntryUntilCompletionResult(
            toAuthorisedWsClientConnectEnqueue(input),
            decodeAuthorisedWsClientMutationResult
        );
    }

    public async enqueueAuthorisedWsClientConnect(input: ToAuthorisedWsClientConnectEnqueueInput) {
        return await this.queueClient.enqueue(toAuthorisedWsClientConnectEnqueue(input));
    }

    public async processAuthorisedWsClientDisconnect(
        input: ToAuthorisedWsClientDisconnectEnqueueInput
    ): Promise<Either<AppInboxFailure, AuthorisedWsClientMutationResult>> {
        return await this.queueClient.processEntryUntilCompletionResult(
            toAuthorisedWsClientDisconnectEnqueue(input),
            decodeAuthorisedWsClientMutationResult
        );
    }

    public async enqueueAuthorisedWsClientDisconnect(
        input: ToAuthorisedWsClientDisconnectEnqueueInput
    ) {
        return await this.queueClient.enqueue(toAuthorisedWsClientDisconnectEnqueue(input));
    }

    public async processExpiredSessions(
        atEpochMs: number = Date.now()
    ): Promise<Either<AppInboxFailure, readonly ClientStateWritten[]>> {
        return await this.queueClient.processEntryUntilCompletionIfResult(
            this.toExpiredSessionsEnqueue(atEpochMs),
            (entry) => isCompletedOrFailed(entry.status),
            decodeExpiredClientSessionsResult
        );
    }

    public async enqueueExpiredSessions(atEpochMs: number = Date.now()) {
        return await this.queueClient.enqueue(
            this.toExpiredSessionsEnqueue(atEpochMs, `expire-client-sessions-${atEpochMs}`)
        );
    }

    private registerClientStateMessages(): void {
        this.registerClientPrincipalUpsert();
        this.registerClientInstanceUpsert();
        this.registerClientSessionConnect();
        this.registerClientSessionHeartbeat();
        this.registerClientSessionDisconnect();
        this.registerAuthorisedWsClientConnect();
        this.registerAuthorisedWsClientDisconnect();
        this.registerExpiredClientSessions();
    }

    private registerClientPrincipalUpsert(): void {
        this.handlers.onStateMessage<ClientPrincipalUpsertAppInboxPayload>(
            AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            async (principal, context) =>
                await this.handler.processCommand(
                    context,
                    toUpsertPrincipalCommandInput(
                        principal.scope,
                        principal.principalId,
                        principal.request,
                        context.entry.key.resourceId
                    )
                )
        );
    }

    private registerClientInstanceUpsert(): void {
        this.handlers.onStateMessage<ClientInstanceUpsertAppInboxPayload>(
            AppInboxType.CLIENT_INSTANCE_UPSERT,
            async (instance, context) =>
                await this.handler.processCommand(
                    context,
                    toUpsertInstanceCommandInput(
                        instance.scope,
                        instance.principalId,
                        instance.clientInstanceId,
                        instance.request,
                        context.entry.key.resourceId
                    )
                )
        );
    }

    private registerClientSessionConnect(): void {
        this.handlers.onStateMessage<ClientSessionConnectAppInboxPayload>(
            AppInboxType.CLIENT_SESSION_CONNECT,
            async (session, context) =>
                await this.handler.processCommand(
                    context,
                    toConnectCommandInput(
                        'connectSession',
                        session.scope,
                        session.principalId,
                        session.clientInstanceId,
                        session.sessionId,
                        session.request,
                        context.entry.key.resourceId,
                        {}
                    )
                )
        );
    }

    private registerClientSessionHeartbeat(): void {
        this.handlers.onStateMessage<ClientSessionHeartbeatAppInboxPayload>(
            AppInboxType.CLIENT_SESSION_HEARTBEAT,
            async (session, context) =>
                await this.handler.processCommand(
                    context,
                    toHeartbeatCommandInput(
                        session.scope,
                        session.principalId,
                        session.clientInstanceId,
                        session.sessionId,
                        session.request,
                        context.entry.key.resourceId
                    )
                )
        );
    }

    private registerClientSessionDisconnect(): void {
        this.handlers.onStateMessage<ClientSessionDisconnectAppInboxPayload>(
            AppInboxType.CLIENT_SESSION_DISCONNECT,
            async (session, context) =>
                await this.handler.processCommand(
                    context,
                    toDisconnectCommandInput(
                        'disconnectSession',
                        session.scope,
                        session.principalId,
                        session.clientInstanceId,
                        session.sessionId,
                        session.request,
                        context.entry.key.resourceId
                    )
                )
        );
    }

    private registerAuthorisedWsClientConnect(): void {
        this.handlers.onStateMessage<ClientAuthorisedWsSessionConnectAppInboxPayload>(
            AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
            async (session, context) => await this.handler.processAuthorisedWsConnect(session, context)
        );
    }

    private registerAuthorisedWsClientDisconnect(): void {
        this.handlers.onStateMessage<ClientAuthorisedWsSessionDisconnectAppInboxPayload>(
            AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
            async (input, context) => await this.handler.processAuthorisedWsDisconnect(input, context)
        );
    }

    private registerExpiredClientSessions(): void {
        this.handlers.onStateMessage<ClientExpiredSessionsAppInboxPayload>(
            AppInboxType.CLIENT_EXPIRED_SESSIONS,
            async (input, context) => await this.handler.processExpiredSessionCommands(context, input.atEpochMs)
        );
    }

    private toExpiredSessionsEnqueue(
        atEpochMs: number,
        resourceId: string = 'expire-client-sessions'
    ): AppInboxEnqueueInput<ClientExpiredSessionsAppInboxPayload> {
        return {
            type: AppInboxType.CLIENT_EXPIRED_SESSIONS,
            topicId: AppInboxType.CLIENT_EXPIRED_SESSIONS,
            resourceId,
            contextId: 'expire-client-sessions',
            senderId: this.serviceId,
            authority: toClientMutationSystemAuthority(this.serviceId),
            data: { atEpochMs }
        };
    }
}
