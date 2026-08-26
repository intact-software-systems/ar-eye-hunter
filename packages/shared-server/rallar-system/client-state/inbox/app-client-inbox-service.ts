import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { isCompletedOrFailed } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { AppInboxType, type AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '../../app-inbox/app-inbox-failure.ts';
import type { AppInboxOptions } from '../../app-inbox/app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '../../app-inbox/app-inbox-persistence-ports.ts';
import { AppInboxQueueClient, SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC } from '../../app-inbox/app-inbox-queue-client.ts';
import { encodeAppInboxCommand, encodeAppInboxResult } from '../../app-inbox/app-inbox-registration-codecs.ts';
import { AppInboxHandlerRegistry } from '../../app-inbox/handler/app-inbox-handler-registry.ts';
import { createAppInboxHandlerRuntime } from '../../app-inbox/handler/app-inbox-handler-runtime.ts';
import type { RallarTimingSink } from '../../observability/timing.ts';
import type { ClientStateService, ClientStateWritten } from '../client-state-service-contracts.ts';
import {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority
} from '../mutation/client-mutation-authority.ts';
import { toConnectClientSessionMutationInput } from '../mutation/command-input/to-connect-client-session-mutation-input.ts';
import { toDisconnectClientSessionMutationInput } from '../mutation/command-input/to-disconnect-client-session-mutation-input.ts';
import { toHeartbeatClientSessionMutationInput } from '../mutation/command-input/to-heartbeat-client-session-mutation-input.ts';
import { toUpsertClientInstanceMutationInput } from '../mutation/command-input/to-upsert-client-instance-mutation-input.ts';
import { toUpsertClientPrincipalMutationInput } from '../mutation/command-input/to-upsert-client-principal-mutation-input.ts';
import {
    CLIENT_STATE_INBOX_REGISTRATION_TYPES,
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
import {
    decodeClientAuthorisedWsSessionConnectAppInboxPayload,
    decodeClientAuthorisedWsSessionDisconnectAppInboxPayload,
    decodeClientExpiredSessionsAppInboxPayload,
    decodeClientInstanceUpsertAppInboxPayload,
    decodeClientPrincipalUpsertAppInboxPayload,
    decodeClientSessionConnectAppInboxPayload,
    decodeClientSessionDisconnectAppInboxPayload,
    decodeClientSessionHeartbeatAppInboxPayload
} from './client-state-inbox-command-codec.ts';
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
        readonly resourceInboxRepository: AppInboxEntryRepository;
        readonly resourceInboxResultsRepository: AppInboxResultRepository;
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
        const handlerRuntime = createAppInboxHandlerRuntime({
            inboxQueueReader: dependencies.inboxQueueReader,
            resultRepository: dependencies.resourceInboxResultsRepository,
            database: dependencies.database,
            serviceId: config.serviceId,
            timing: config.timing,
            options: config.options
        });
        this.handlers = handlerRuntime.registry;
        this.serviceId = config.serviceId;
        this.clientStateService = dependencies.clientStateService;
        this.handler = new ClientStateInboxHandler({
            mutationService: dependencies.clientStateService,
            sessionGenerationLifecycle: dependencies.clientStateService.sessionGenerationLifecycle,
            expiryCandidates: dependencies.clientStateService,
            snapshotObserver: dependencies.clientStateService,
            transactionWriter: handlerRuntime.transactionWriter,
            serviceId: config.serviceId
        });
        this.registerClientStateMessages();
        this.handlers.assertRegistrationComplete(CLIENT_STATE_INBOX_REGISTRATION_TYPES);
    }

    public async processAuthenticatedEntryUntilCompletion(
        enqueue: AppInboxEnqueueInput,
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
        this.handlers.registerHandler({
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            decodeCommand: decodeClientPrincipalUpsertAppInboxPayload,
            encodeResult: (result) => encodeAppInboxResult(result, 'Client principal AppInbox result'),
            handle: async (principal, context) =>
                await this.handler.processCommand(
                    context,
                    toUpsertClientPrincipalMutationInput({
                        scope: principal.scope,
                        principalId: principal.principalId,
                        request: principal.request,
                        defaultCommandId: context.entry.key.resourceId
                    })
                )
        });
    }

    private registerClientInstanceUpsert(): void {
        this.handlers.registerHandler({
            type: AppInboxType.CLIENT_INSTANCE_UPSERT,
            decodeCommand: decodeClientInstanceUpsertAppInboxPayload,
            encodeResult: (result) => encodeAppInboxResult(result, 'Client instance AppInbox result'),
            handle: async (instance, context) =>
                await this.handler.processCommand(
                    context,
                    toUpsertClientInstanceMutationInput({
                        scope: instance.scope,
                        principalId: instance.principalId,
                        clientInstanceId: instance.clientInstanceId,
                        request: instance.request,
                        defaultCommandId: context.entry.key.resourceId
                    })
                )
        });
    }

    private registerClientSessionConnect(): void {
        this.handlers.registerHandler({
            type: AppInboxType.CLIENT_SESSION_CONNECT,
            decodeCommand: decodeClientSessionConnectAppInboxPayload,
            encodeResult: (result) => encodeAppInboxResult(result, 'Client connect AppInbox result'),
            handle: async (session, context) =>
                await this.handler.processCommand(
                    context,
                    toConnectClientSessionMutationInput({
                        operation: 'connectSession',
                        scope: session.scope,
                        principalId: session.principalId,
                        clientInstanceId: session.clientInstanceId,
                        sessionId: session.sessionId,
                        request: session.request,
                        defaultCommandId: context.entry.key.resourceId,
                        identityDefaults: {}
                    })
                )
        });
    }

    private registerClientSessionHeartbeat(): void {
        this.handlers.registerHandler({
            type: AppInboxType.CLIENT_SESSION_HEARTBEAT,
            decodeCommand: decodeClientSessionHeartbeatAppInboxPayload,
            encodeResult: (result) => encodeAppInboxResult(result, 'Client heartbeat AppInbox result'),
            handle: async (session, context) =>
                await this.handler.processCommand(
                    context,
                    toHeartbeatClientSessionMutationInput({
                        scope: session.scope,
                        principalId: session.principalId,
                        clientInstanceId: session.clientInstanceId,
                        sessionId: session.sessionId,
                        request: session.request,
                        defaultCommandId: context.entry.key.resourceId
                    })
                )
        });
    }

    private registerClientSessionDisconnect(): void {
        this.handlers.registerHandler({
            type: AppInboxType.CLIENT_SESSION_DISCONNECT,
            decodeCommand: decodeClientSessionDisconnectAppInboxPayload,
            encodeResult: (result) => encodeAppInboxResult(result, 'Client disconnect AppInbox result'),
            handle: async (session, context) =>
                await this.handler.processCommand(
                    context,
                    toDisconnectClientSessionMutationInput({
                        operation: 'disconnectSession',
                        scope: session.scope,
                        principalId: session.principalId,
                        clientInstanceId: session.clientInstanceId,
                        sessionId: session.sessionId,
                        request: session.request,
                        defaultCommandId: context.entry.key.resourceId
                    })
                )
        });
    }

    private registerAuthorisedWsClientConnect(): void {
        this.handlers.registerHandler({
            type: AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
            decodeCommand: decodeClientAuthorisedWsSessionConnectAppInboxPayload,
            encodeResult: (result) => encodeAppInboxResult(result, 'Authorised WebSocket connect AppInbox result'),
            handle: async (session, context) => await this.handler.processAuthorisedWsConnect(session, context)
        });
    }

    private registerAuthorisedWsClientDisconnect(): void {
        this.handlers.registerHandler({
            type: AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
            decodeCommand: decodeClientAuthorisedWsSessionDisconnectAppInboxPayload,
            encodeResult: (result) => encodeAppInboxResult(result, 'Authorised WebSocket disconnect AppInbox result'),
            handle: async (input, context) => await this.handler.processAuthorisedWsDisconnect(input, context)
        });
    }

    private registerExpiredClientSessions(): void {
        this.handlers.registerHandler({
            type: AppInboxType.CLIENT_EXPIRED_SESSIONS,
            decodeCommand: decodeClientExpiredSessionsAppInboxPayload,
            encodeResult: (result) => encodeAppInboxResult(result, 'Client expiry AppInbox result'),
            handle: async (input, context) => await this.handler.processExpiredSessionCommands(context, input.atEpochMs)
        });
    }

    private toExpiredSessionsEnqueue(
        atEpochMs: number,
        resourceId: string = 'expire-client-sessions'
    ): AppInboxEnqueueInput {
        return {
            type: AppInboxType.CLIENT_EXPIRED_SESSIONS,
            topicId: AppInboxType.CLIENT_EXPIRED_SESSIONS,
            resourceId,
            contextId: 'expire-client-sessions',
            senderId: this.serviceId,
            authority: toClientMutationSystemAuthority(this.serviceId),
            data: encodeAppInboxCommand(
                { atEpochMs } satisfies ClientExpiredSessionsAppInboxPayload,
                'Expired client sessions AppInbox command'
            )
        };
    }
}
