import type { ALInboundRuntimeStores } from '@shared/alm/ALInboundMessageRuntime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type {
  DequeueResourceEntryOptions,
  ResilienceDto,
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
  WsQueueBoxServerService,
  type WsServerTargetResolver,
} from '@shared/services/WsQueueBoxServerService.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { initialiseServerCacheRepositories } from '../cache-repositories.ts';
import type { ClientStateRepository } from '../client-state/persistence/client-state-repository.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import type { AppClientInboxService } from '../client-state/inbox/app-client-inbox-service.ts';
import type { AppGroupInboxService } from '../services/AppGroupInboxService.ts';
import type { ClientStateService } from '../client-state/client-state-service-contracts.ts';
import type { GroupStateService } from '../services/group-state-service.ts';
import type { RallarSnapshotPresenceClock } from '../snapshot-presence.ts';
import type { RtcTopologyPublicationRepository } from '../repositories/RtcTopologyPublicationRepository.ts';
import type { RtcTopologyPublicationFanout } from '../pubsub/RtcTopologyClusterTransport.ts';
import type { RtcTopologyExecutionRepository } from '../repositories/RtcTopologyExecutionRepository.ts';
import {
  installQueueBoxPubSubBridge,
  type InstallQueueBoxPubSubBridgeOptions,
} from '../pubsub/QueueBoxPubSubBridge.ts';
import type {
  RallarAdminInboxServiceFactory,
  RallarAuthInboxServiceFactory,
  RallarCrdtInboxServiceFactory,
  RallarGroupSnapshotResolverOptions,
} from './rallar-middleware-options.ts';
import { createWsServerTargetResolver } from './ws-server-target-resolver.ts';
export type { RallarGroupSnapshotResolverOptions } from './rallar-middleware-options.ts';
export { createWsServerTargetResolver } from './ws-server-target-resolver.ts';
export type RallarMiddlewareRuntime = Readonly<{
  qboxEngine: InboxOutboxEngine;
  wsQBoxServerService: WsQueueBoxServerService;
  inboxQueueReader: InboxQueueReader;
  outboxQueueReader: OutboxQueueReader;
  appInboxResilience: ResilienceDto;
  appOutboxResilience: ResilienceDto;
  appGroupInboxService: AppGroupInboxService;
  appClientInboxService: AppClientInboxService;
  appAuthInboxService?: ReturnType<RallarAuthInboxServiceFactory>;
  appAdminInboxService?: ReturnType<RallarAdminInboxServiceFactory>;
  appCrdtInboxService?: ReturnType<RallarCrdtInboxServiceFactory>;
  clientStateService: ClientStateService;
  groupStateService: GroupStateService;
  clientsRepository: ClientStateRepository;
  groupsRepository: GroupStateRepository;
  rtcTopologyPublicationRepository?: RtcTopologyPublicationRepository;
  rtcTopologyExecutionRepository?: RtcTopologyExecutionRepository;
  rtcTopologyPublicationFanout?: RtcTopologyPublicationFanout;
  readiness: Promise<void>;
}>;
export type CreateRallarMiddlewareOptions = Readonly<{
  inbox: QueueBoxResourceEntryRepository;
  outbox?: QueueBoxResourceEntryRepository;
  appInboxDequeueOptions?: DequeueResourceEntryOptions;
  webSocketServer?: JsonWebSocketServer;
  wsRuntimeName?: string;
  targetResolver?: WsServerTargetResolver;
  findGroupSnapshotByRef?: RallarGroupSnapshotResolverOptions['findGroupSnapshotByRef'];
  findClientSnapshotByRef?: RallarGroupSnapshotResolverOptions['findClientSnapshotByRef'];
  findGroupSnapshotById?: RallarGroupSnapshotResolverOptions['findGroupSnapshotById'];
  resolveGroupRef?: RallarGroupSnapshotResolverOptions['resolveGroupRef'];
  now?: RallarSnapshotPresenceClock;
  inboundStores?: ALInboundRuntimeStores;
  outboundStores?: ALOutboundRuntimeStores;
  createAppGroupInboxService: (
    input: Readonly<{
      inboxQueueReader: InboxQueueReader;
      outboxQueueReader: OutboxQueueReader;
      wsQBoxServerService: WsQueueBoxServerService;
      appInboxResilience: ResilienceDto;
      appOutboxResilience: ResilienceDto;
      wakeQueueEngine: () => void;
    }>,
  ) => AppGroupInboxService;
  createAppClientInboxService: (
    input: Readonly<{
      inboxQueueReader: InboxQueueReader;
      wsQBoxServerService: WsQueueBoxServerService;
      appInboxResilience: ResilienceDto;
      wakeQueueEngine: () => void;
    }>,
  ) => AppClientInboxService;
  createAppAuthInboxService?: RallarAuthInboxServiceFactory;
  createAppAdminInboxService?: RallarAdminInboxServiceFactory;
  createAppCrdtInboxService?: RallarCrdtInboxServiceFactory;
  resilience: Readonly<{
    inbox: ResilienceDto;
    outbox?: ResilienceDto;
    appInbox?: ResilienceDto;
    appOutbox: ResilienceDto;
  }>;
  clientsRepository: ClientStateRepository;
  groupsRepository: GroupStateRepository;
  rtcTopologyPublicationRepository?: RtcTopologyPublicationRepository;
  rtcTopologyExecutionRepository?: RtcTopologyExecutionRepository;
  rtcTopologyPublicationFanout?: RtcTopologyPublicationFanout;
  queuePubSubBridge?: Omit<
    InstallQueueBoxPubSubBridgeOptions,
    'wsQBoxServerService'
  >;
  readiness?: Promise<void>;
}>;
export function createRallarMiddleware(
  options: CreateRallarMiddlewareOptions,
): RallarMiddlewareRuntime {
  initialiseServerCacheRepositories();
  const qboxEngine = new InboxOutboxEngine();
  const webSocketServer = options.webSocketServer ?? new JsonWebSocketServer();
  const targetResolver = options.targetResolver ??
    createWsServerTargetResolver(webSocketServer, {
      findGroupSnapshotByRef: options.findGroupSnapshotByRef,
      findClientSnapshotByRef: options.findClientSnapshotByRef,
      findGroupSnapshotById: options.findGroupSnapshotById,
      resolveGroupRef: options.resolveGroupRef,
      now: options.now,
    });
  const wsQBoxServerService = new WsQueueBoxServerService(
    options.inbox,
    options.outbox ?? options.inbox,
    webSocketServer,
    options.wsRuntimeName ?? 'default-qbox-server',
    {
      targetResolver,
      inboundStores: options.inboundStores,
      outboundStores: options.outboundStores,
    },
  );
  const queuePubSubBridgeReadiness = options.queuePubSubBridge
    ? installQueueBoxPubSubBridge({
      ...options.queuePubSubBridge,
      wsQBoxServerService,
    })
    : Promise.resolve();
  const inboxQueueReader = new InboxQueueReader(
    options.inbox,
    options.appInboxDequeueOptions,
  );
  const outboxQueueReader = new OutboxQueueReader(
    options.outbox ?? options.inbox,
  );
  const appInboxResilience = options.resilience.appInbox ?? options.resilience.inbox;
  const appOutboxResilience = options.resilience.appOutbox;
  const wakeQueueEngine = () => qboxEngine.wake();
  const appGroupInboxService = options.createAppGroupInboxService({
    inboxQueueReader,
    outboxQueueReader,
    wsQBoxServerService,
    appInboxResilience,
    appOutboxResilience,
    wakeQueueEngine,
  });
  const appClientInboxService = options.createAppClientInboxService({
    inboxQueueReader,
    wsQBoxServerService,
    appInboxResilience,
    wakeQueueEngine,
  });
  const appAuthInboxService = options.createAppAuthInboxService?.({
    inboxQueueReader,
    appInboxResilience,
    wakeQueueEngine,
  });
  const appAdminInboxService = options.createAppAdminInboxService?.({
    inboxQueueReader,
    outboxQueueReader,
    appInboxResilience,
    wakeQueueEngine,
  });
  const appCrdtInboxService = options.createAppCrdtInboxService?.({
    inboxQueueReader,
    outboxQueueReader,
    appInboxResilience,
    wakeQueueEngine,
  });
  includeWsQueueBoxEngineTasks(
    qboxEngine,
    wsQBoxServerService,
    options.resilience.inbox,
    options.resilience.outbox ?? options.resilience.inbox,
  );
  includeInboxQueueReaderEngineTasks(
    qboxEngine,
    inboxQueueReader,
    appInboxResilience,
  );
  includeOutboxQueueReaderEngineTasks(
    qboxEngine,
    outboxQueueReader,
    appOutboxResilience,
  );
  return {
    qboxEngine,
    wsQBoxServerService,
    inboxQueueReader,
    outboxQueueReader,
    appInboxResilience,
    appOutboxResilience,
    appGroupInboxService,
    appClientInboxService,
    appAuthInboxService,
    appAdminInboxService,
    appCrdtInboxService,
    groupStateService: appGroupInboxService.groupStateService,
    clientStateService: appClientInboxService.clientStateService,
    clientsRepository: options.clientsRepository,
    groupsRepository: options.groupsRepository,
    rtcTopologyPublicationRepository: options.rtcTopologyPublicationRepository,
    rtcTopologyExecutionRepository: options.rtcTopologyExecutionRepository,
    rtcTopologyPublicationFanout: options.rtcTopologyPublicationFanout,
    readiness: Promise.all([
      options.readiness ?? Promise.resolve(),
      queuePubSubBridgeReadiness,
    ]).then(() => undefined),
  };
}
export function includeWsQueueBoxEngineTasks(
  engine: InboxOutboxEngine,
  wsQBoxServerService: WsQueueBoxServerService,
  resilienceInbox: ResilienceDto,
  resilienceOutbox: ResilienceDto,
): void {
  engine.includeTask(WsQueueBoxServerService.INBOX_ENQUEUE_TYPE, {
    name: WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
    maxConcurrency: () => 1,
    isWork: () =>
      wsQBoxServerService.inbox.isAnyEntryToLock(
        WsQueueBoxServerService.INBOX_DEQUEUE_TYPES,
        resilienceInbox.toWorkAdvertisementOptions(),
      ),
    runnable: () =>
      wsQBoxServerService.dequeueInbox(
        WsQueueBoxServerService.INBOX_DEQUEUE_TYPES,
        resilienceInbox,
      ),
    ongoingTasks: [],
  });
  engine.includeTask(WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE, {
    name: WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
    maxConcurrency: () => 1,
    isWork: () =>
      wsQBoxServerService.outbox.isAnyEntryToLock(
        WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
        resilienceOutbox.toWorkAdvertisementOptions(),
      ),
    runnable: () =>
      wsQBoxServerService.dequeueOutbox(
        WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
        resilienceOutbox,
      ),
    ongoingTasks: [],
  });
}
export function includeInboxQueueReaderEngineTasks(
  engine: InboxOutboxEngine,
  inboxQueueReader: InboxQueueReader,
  resilience: ResilienceDto,
): void {
  engine.includeTask(InboxQueueReader.INBOX_ENQUEUE_TYPE, {
    name: InboxQueueReader.INBOX_ENQUEUE_TYPE,
    maxConcurrency: () => 1,
    isWork: () =>
      inboxQueueReader.inbox.isAnyEntryToLock(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        resilience.toWorkAdvertisementOptions(),
      ),
    runnable: () =>
      inboxQueueReader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        resilience,
      ),
    ongoingTasks: [],
  });
}
export function includeOutboxQueueReaderEngineTasks(
  engine: InboxOutboxEngine,
  outboxQueueReader: OutboxQueueReader,
  resilience: ResilienceDto,
): void {
  engine.includeTask(OutboxQueueReader.OUTBOX_ENQUEUE_TYPE, {
    name: OutboxQueueReader.OUTBOX_ENQUEUE_TYPE,
    maxConcurrency: () => 1,
    isWork: () =>
      outboxQueueReader.outbox.isAnyEntryToLock(
        OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
        resilience.toWorkAdvertisementOptions(),
      ),
    runnable: () =>
      outboxQueueReader.dequeueOutbox(
        OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
        resilience,
      ),
    ongoingTasks: [],
  });
}
