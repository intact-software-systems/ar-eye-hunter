import type { Either } from '@shared/resilience/Either.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { isCompletedOrFailed } from '@shared/queuebox/ResourceEntry.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql } from '../../../postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../../../postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '../../../postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type { IssuedAuthSession } from '../../repositories/AuthSessionRepository.ts';
import {
  type AppInboxEnqueueInput,
  type AppInboxServiceOptions,
  AppInboxService,
  AppInboxType,
  SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
} from '../../services/AppInboxService.ts';
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

export class AppClientInboxService extends AppInboxService {
  private readonly handler: ClientStateInboxHandler;

  public override readonly inbox: InboxQueueReader;
  public override readonly resourceInbox: ResourceInboxRepository;
  public override readonly resourceInboxResults: ResourceInboxResultsRepository;
  public readonly clientStateService: ClientStateService;
  public override readonly serviceId: string;

  constructor(
    inbox: InboxQueueReader,
    resourceInbox: ResourceInboxRepository,
    resourceInboxResults: ResourceInboxResultsRepository,
    database: PSqlSql,
    clientStateService: ClientStateService,
    serviceId: string,
    timing?: RallarTimingSink,
    options?: AppInboxServiceOptions,
    wakeQueue?: () => void,
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
      wakeQueue,
    );
    this.inbox = inbox;
    this.resourceInbox = resourceInbox;
    this.resourceInboxResults = resourceInboxResults;
    this.clientStateService = clientStateService;
    this.serviceId = serviceId;
    this.handler = new ClientStateInboxHandler({
      mutationService: clientStateService,
      sessionGenerationLifecycle: clientStateService.sessionGenerationLifecycle,
      expiryCandidates: clientStateService,
      snapshotObserver: clientStateService,
      transactionWriter: this.transactionWriter,
      serviceId,
      formationDamping: clientStateService.formationDamping,
    });
    this.registerClientStateMessages();
  }

  public override processEntryUntilCompletion<V, R = V>(
    enqueue: AppInboxEnqueueInput<V>,
  ): Promise<Either<string, R>> {
    void enqueue;
    return Promise.reject(
      new NonRetryableException('Authenticated client mutation authority is required.'),
    );
  }

  public override processEntryUntilCompletionIf<V, R = V>(
    enqueue: AppInboxEnqueueInput<V>,
    enqueueIf: (entry: ResourceEntry) => boolean,
  ): Promise<Either<string, R>> {
    void enqueue;
    void enqueueIf;
    return Promise.reject(
      new NonRetryableException('Authenticated client mutation authority is required.'),
    );
  }

  public async processAuthenticatedEntryUntilCompletion<V, R = V>(
    enqueue: AppInboxEnqueueInput<V>,
    authority: IssuedAuthSession,
  ): Promise<Either<string, R>> {
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
