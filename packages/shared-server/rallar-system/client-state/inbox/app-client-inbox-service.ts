import type { Either } from '@shared/resilience/Either.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { isCompletedOrFailed } from '@shared/queuebox/ResourceEntry.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql } from '../../../postgres/PostgresSqlClient.ts';
import type { IssuedAuthSession } from '../../repositories/AuthSessionRepository.ts';
import {
  type AppInboxEnqueueInput,
  AppInboxService,
  type AppInboxServiceOptions,
  AppInboxType,
  SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
} from '../../services/AppInboxService.ts';
import { toLegacyAppInboxFailure } from '../../services/app-inbox-legacy-failure.ts';
import type { AppInboxFailure } from '../../services/app-inbox-failure.ts';
import type { JsonWireValue } from '../../services/mutation-command-identity.ts';
import type { RallarTimingSink } from '../../services/timing.ts';
import {
  toClientMutationIssuedSessionAuthority,
  toClientMutationSystemAuthority,
} from '../mutation/client-mutation-authority.ts';
import {
  toConnectCommandInput,
  toDisconnectCommandInput,
  toHeartbeatCommandInput,
  toUpsertInstanceCommandInput,
  toUpsertPrincipalCommandInput,
} from '../mutation/client-mutation-command.ts';
import type { ClientStateService, ClientStateWritten } from '../client-state-service-contracts.ts';
import {
  readAuthenticatedClientMutationIngress,
  validateIssuedClientMutationIngress,
} from './authenticated-client-mutation-ingress.ts';
import {
  type ClientAuthorisedWsSessionConnectAppInboxPayload,
  type ClientAuthorisedWsSessionDisconnectAppInboxPayload,
  type ClientExpiredSessionsAppInboxPayload,
  type ClientInstanceUpsertAppInboxPayload,
  type ClientPrincipalUpsertAppInboxPayload,
  type ClientSessionConnectAppInboxPayload,
  type ClientSessionDisconnectAppInboxPayload,
  type ClientSessionHeartbeatAppInboxPayload,
} from './app-client-inbox-contracts.ts';
import {
  toAuthorisedWsClientConnectEnqueue,
  type ToAuthorisedWsClientConnectEnqueueInput,
  toAuthorisedWsClientDisconnectEnqueue,
  type ToAuthorisedWsClientDisconnectEnqueueInput,
} from './authorised-ws-client-app-inbox.ts';
import { ClientStateInboxHandler } from './client-state-inbox-handler.ts';
import {
  type AuthorisedWsClientMutationResult,
  decodeAuthorisedWsClientMutationResult,
  decodeClientStateWritten,
  decodeExpiredClientSessionsResult,
} from './client-state-inbox-result-codec.ts';

export namespace AppClientInboxService {
  export interface Dependencies {
    readonly inboxQueueReader: InboxQueueReader;
    readonly resourceInboxRepository: AppInboxService.InboxRepository;
    readonly resourceInboxResultsRepository: AppInboxService.ResultRepository;
    readonly database: PSqlSql;
    readonly clientStateService: ClientStateService;
  }

  export interface Config {
    readonly serviceId: string;
    readonly timing?: RallarTimingSink;
    readonly options?: AppInboxServiceOptions;
    readonly wakeOwningQueue?: () => void;
  }
}

export class AppClientInboxService extends AppInboxService {
  private readonly handler: ClientStateInboxHandler;

  public readonly clientStateService: ClientStateService;

  constructor(
    dependencies: AppClientInboxService.Dependencies,
    config: AppClientInboxService.Config,
  ) {
    super(
      {
        inboxQueueReader: dependencies.inboxQueueReader,
        resourceInboxRepository: dependencies.resourceInboxRepository,
        resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
        database: dependencies.database,
      },
      {
        serviceId: config.serviceId,
        defaultTopicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
        timing: config.timing,
        options: config.options,
        wakeOwningQueue: config.wakeOwningQueue,
      },
    );
    this.clientStateService = dependencies.clientStateService;
    this.handler = new ClientStateInboxHandler({
      mutationService: dependencies.clientStateService,
      sessionGenerationLifecycle: dependencies.clientStateService.sessionGenerationLifecycle,
      expiryCandidates: dependencies.clientStateService,
      snapshotObserver: dependencies.clientStateService,
      transactionWriter: this.transactionWriter,
      serviceId: config.serviceId,
      formationDamping: dependencies.clientStateService.formationDamping,
    });
    this.registerClientStateMessages();
  }

  public override processEntryUntilCompletion<V>(
    enqueue: AppInboxEnqueueInput<V>,
  ): Promise<Either<string, JsonWireValue>> {
    void enqueue;
    return Promise.reject(
      new NonRetryableException('Authenticated client mutation authority is required.'),
    );
  }

  public override processEntryUntilCompletionIf<V>(
    enqueue: AppInboxEnqueueInput<V>,
    enqueueIf: (entry: ResourceEntry) => boolean,
  ): Promise<Either<string, JsonWireValue>> {
    void enqueue;
    void enqueueIf;
    return Promise.reject(
      new NonRetryableException('Authenticated client mutation authority is required.'),
    );
  }

  public async processAuthenticatedEntryUntilCompletion<V>(
    enqueue: AppInboxEnqueueInput<V>,
    authority: IssuedAuthSession,
  ): Promise<Either<AppInboxFailure, ClientStateWritten>> {
    const ingress = readAuthenticatedClientMutationIngress(enqueue);
    validateIssuedClientMutationIngress(authority, ingress);
    const result = await super.processEntryUntilCompletionResult(
      {
        ...enqueue,
        authority: toClientMutationIssuedSessionAuthority(
          authority,
          ingress.scope,
          ingress.operation,
        ),
      },
      decodeClientStateWritten,
    );
    return result;
  }

  public async processAuthorisedWsClientConnect(
    input: ToAuthorisedWsClientConnectEnqueueInput,
  ): Promise<Either<string, AuthorisedWsClientMutationResult>> {
    const result = await super.processEntryUntilCompletionResult(
      toAuthorisedWsClientConnectEnqueue(input),
      decodeAuthorisedWsClientMutationResult,
    );
    return result.mapLeft(toLegacyAppInboxFailure);
  }

  public async enqueueAuthorisedWsClientConnect(input: ToAuthorisedWsClientConnectEnqueueInput) {
    return await super.enqueue(toAuthorisedWsClientConnectEnqueue(input));
  }

  public async processAuthorisedWsClientDisconnect(
    input: ToAuthorisedWsClientDisconnectEnqueueInput,
  ): Promise<Either<string, AuthorisedWsClientMutationResult>> {
    const result = await super.processEntryUntilCompletionResult(
      toAuthorisedWsClientDisconnectEnqueue(input),
      decodeAuthorisedWsClientMutationResult,
    );
    return result.mapLeft(toLegacyAppInboxFailure);
  }

  public async enqueueAuthorisedWsClientDisconnect(
    input: ToAuthorisedWsClientDisconnectEnqueueInput,
  ) {
    return await super.enqueue(toAuthorisedWsClientDisconnectEnqueue(input));
  }

  public async processExpiredSessions(
    atEpochMs: number = Date.now(),
  ): Promise<Either<string, readonly ClientStateWritten[]>> {
    const result = await super.processEntryUntilCompletionIfResult(
      this.toExpiredSessionsEnqueue(atEpochMs),
      (entry) => isCompletedOrFailed(entry.status),
      decodeExpiredClientSessionsResult,
    );
    return result.mapLeft(toLegacyAppInboxFailure);
  }

  public async enqueueExpiredSessions(atEpochMs: number = Date.now()) {
    return await super.enqueue(
      this.toExpiredSessionsEnqueue(atEpochMs, `expire-client-sessions-${atEpochMs}`),
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
    this.onStateMessage<ClientPrincipalUpsertAppInboxPayload>(
      AppInboxType.CLIENT_PRINCIPAL_UPSERT,
      async (principal, context) =>
        await this.handler.processCommand(
          context,
          toUpsertPrincipalCommandInput(
            principal.scope,
            principal.principalId,
            principal.request,
            context.entry.key.resourceId,
          ),
        ),
    );
  }

  private registerClientInstanceUpsert(): void {
    this.onStateMessage<ClientInstanceUpsertAppInboxPayload>(
      AppInboxType.CLIENT_INSTANCE_UPSERT,
      async (instance, context) =>
        await this.handler.processCommand(
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
  }

  private registerClientSessionConnect(): void {
    this.onStateMessage<ClientSessionConnectAppInboxPayload>(
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
            {},
          ),
        ),
    );
  }

  private registerClientSessionHeartbeat(): void {
    this.onStateMessage<ClientSessionHeartbeatAppInboxPayload>(
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
            context.entry.key.resourceId,
          ),
        ),
    );
  }

  private registerClientSessionDisconnect(): void {
    this.onStateMessage<ClientSessionDisconnectAppInboxPayload>(
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
            context.entry.key.resourceId,
          ),
        ),
    );
  }

  private registerAuthorisedWsClientConnect(): void {
    this.onStateMessage<ClientAuthorisedWsSessionConnectAppInboxPayload>(
      AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
      async (session, context) => await this.handler.processAuthorisedWsConnect(session, context),
    );
  }

  private registerAuthorisedWsClientDisconnect(): void {
    this.onStateMessage<ClientAuthorisedWsSessionDisconnectAppInboxPayload>(
      AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
      async (input, context) => await this.handler.processAuthorisedWsDisconnect(input, context),
    );
  }

  private registerExpiredClientSessions(): void {
    this.onStateMessage<ClientExpiredSessionsAppInboxPayload>(
      AppInboxType.CLIENT_EXPIRED_SESSIONS,
      async (input, context) =>
        await this.handler.processExpiredSessionCommands(context, input.atEpochMs),
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
      data: { atEpochMs },
    };
  }
}
