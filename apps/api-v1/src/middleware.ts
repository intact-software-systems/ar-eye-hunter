import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import {
  initResourceInboxExpiryEviction,
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import {
  initRuntimeStateExpiryEviction,
  PSqlRuntimeStateRepository,
} from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
  configureServerWsQBoxALRuntimeStores,
  resolveServerWsQBoxALInboundRuntimeStores,
  resolveServerWsQBoxALOutboundRuntimeStores,
} from '@shared-server/postgres/al-runtime/createPSqlALRuntimeStores.ts';
import {
  createRallarMiddleware,
  type RallarMiddlewareRuntime,
} from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import { AppGroupInboxService } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { createClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import { createGroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import { createWsStateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { myPublisherId, myServerId } from './runtime/runtime-identity.ts';
import { toResilienceDto } from './middleware-resilience.ts';
import {
  createClientStateEventRepository,
  createClientStateRepository,
  createGroupStateEventRepository,
  createGroupStateRepository,
  createRuntimeStateRepository,
} from './repository/createStateRepositories.ts';
import { sql } from './db/db.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import {
  createGroupStateSnapshotReadThroughCache,
} from '@shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts';
import {
  initPresenceExpiryReconciliation,
} from '@shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts';
import { getApiAppInboxServiceOptions, getApiTimingSink } from './services/timing-service.ts';
import { readApiV1DatabasePubSubConfig } from './db/database-pubsub-config.ts';
import {
  createApiV1QueuePubSubBridge,
  queuePubSubDeliveryForConfig,
  shouldInstallQueuePubSubBridge,
} from './db/api-v1-queue-pubsub-bridge.ts';

export type Middleware = RallarMiddlewareRuntime;

let middleware: Middleware | undefined = undefined;

export function getMiddleware(): Middleware {
  if (middleware === undefined) {
    throw new Error('Middleware not initialised');
  }
  return middleware;
}

export function initialiseMiddleware() {
  middleware = initialise();
  return middleware;
}

function initialise(): Middleware {
  const dbWsChannelId = 'ws-channel';
  const wsRuntimeName = 'default-qbox-server';
  const postgresSql = sql as unknown as PSqlSql;
  const resourceInboxRepository = new ResourceInboxRepository(postgresSql);
  const resourceInboxResultsRepository = new ResourceInboxResultsRepository(postgresSql);
  const queueBox = new PSqlQueueBox(resourceInboxRepository);
  const webSocketServer = new JsonWebSocketServer();
  const resilienceInbox = toResilienceDto();
  const resilienceOutbox = toResilienceDto();
  const clientsRepository = createClientStateRepository(sql);
  const groupsRepository = createGroupStateRepository(sql);
  const timing = getApiTimingSink();
  const appInboxOptions = getApiAppInboxServiceOptions();
  const pubSubConfig = readApiV1DatabasePubSubConfig();
  const groupSnapshotReadThroughCache = createGroupStateSnapshotReadThroughCache({
    groupsRepository,
  });

  configureServerWsQBoxALRuntimeStores(wsRuntimeName, { sql: postgresSql });
  initResourceInboxExpiryEviction(queueBox.repo).catch((e) =>
    console.error('Failed to initialise resource inbox expiry eviction:', e)
  );
  initRuntimeStateExpiryEviction(new PSqlRuntimeStateRepository(postgresSql)).catch((e) =>
    console.error('Failed to initialise runtime state expiry eviction:', e)
  );

  const runtime = createRallarMiddleware({
    inbox: queueBox,
    outbox: queueBox,
    webSocketServer,
    wsRuntimeName,
    findGroupSnapshotByRef: (ref) => groupSnapshotReadThroughCache.findByRef(ref),
    findGroupSnapshotById: groupStateSnapshotsRepository.findLatestGroupSnapshotById,
    inboundStores: resolveServerWsQBoxALInboundRuntimeStores(wsRuntimeName),
    outboundStores: resolveServerWsQBoxALOutboundRuntimeStores(wsRuntimeName),
    createAppGroupInboxService: ({ inboxQueueReader, wsQBoxServerService }) => {
      const stateSyncPublisher = createWsStateSyncPublisher(
        wsQBoxServerService,
        { serverId: myServerId, timing },
      );
      return new AppGroupInboxService(
        inboxQueueReader,
        resourceInboxRepository,
        resourceInboxResultsRepository,
        createGroupStateService({
          runtimeRepository: createRuntimeStateRepository(sql),
          createGroupStateEventStore: createGroupStateEventRepository,
          syncPublisher: stateSyncPublisher,
          serviceId: myServerId,
          timing,
        }),
        stateSyncPublisher,
        myServerId,
        timing,
        appInboxOptions,
      );
    },
    createAppClientInboxService: ({ inboxQueueReader, wsQBoxServerService }) => {
      const stateSyncPublisher = createWsStateSyncPublisher(
        wsQBoxServerService,
        { serverId: myServerId, timing },
      );
      return new AppClientInboxService(
        inboxQueueReader,
        resourceInboxRepository,
        resourceInboxResultsRepository,
        createClientStateService({
          runtimeRepository: createRuntimeStateRepository(sql),
          createClientStateEventStore: createClientStateEventRepository,
          syncPublisher: stateSyncPublisher,
          serviceId: myServerId,
          timing,
        }),
        stateSyncPublisher,
        myServerId,
        timing,
        appInboxOptions,
      );
    },
    resilience: {
      inbox: resilienceInbox,
      outbox: resilienceOutbox,
    },
    clientsRepository,
    groupsRepository,
  });

  if (shouldInstallQueuePubSubBridge(pubSubConfig)) {
    installQueueBoxPubSubBridge({
      wsQBoxServerService: runtime.wsQBoxServerService,
      bridge: createApiV1QueuePubSubBridge(pubSubConfig, myPublisherId),
      channel: dbWsChannelId,
      publisherId: myPublisherId,
      delivery: queuePubSubDeliveryForConfig(pubSubConfig),
      timing,
    });
  }

  initPresenceExpiryReconciliation(runtime)
    .catch((e) => console.error('Failed to initialise presence expiry reconciliation:', e));

  return runtime;
}
