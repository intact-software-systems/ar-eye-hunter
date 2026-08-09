import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
  PSqlRtcTopologyDeliveryRepository,
} from '@shared-server/postgres/rtc-topology/p-sql-rtc-topology-delivery-repository.ts';
import {
  createRtcTopologyPublicationFanout,
  type RtcTopologyPublicationFanout,
} from '@shared-server/rallar-system/pubsub/RtcTopologyClusterTransport.ts';
import {
  DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
  RtcTopologyPublicationRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
  RtcTopologyExecutionRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import type {
  RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

import {
  createApiV1RtcTopologyClusterTransport,
} from '../../db/api-v1-rtc-topology-cluster-transport.ts';
import type { ApiV1DatabasePubSubConfig } from '../../db/database-pubsub-config.ts';
import {
  startApiRtcTopologyDelivery,
} from './rtc-topology-delivery-startup.ts';

interface CreateApiRtcTopologyRuntimeInput {
  readonly database: PSqlSql;
  readonly runtimeStateRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
  readonly pubSubConfig: ApiV1DatabasePubSubConfig;
  readonly webSocketServer: JsonWebSocketServer;
  readonly publisherId: string;
  readonly publisherStreamId: string;
  readonly nowEpochMs: () => number;
  readonly onCompactionFailure: (error: Error) => void;
}

export interface ApiRtcTopologyRuntime {
  readonly publicationRepository: RtcTopologyPublicationRepository;
  readonly executionRepository: RtcTopologyExecutionRepository;
  readonly publicationFanout: RtcTopologyPublicationFanout;
  readonly topologyDelivery: Readonly<{
    publisherStreamId: string;
    append: PSqlRtcTopologyDeliveryRepository;
  }>;
  readonly readiness: Promise<void>;
  readonly healthFailure: Promise<never>;
  stop(): void;
}

export function createApiRtcTopologyRuntime(
  input: CreateApiRtcTopologyRuntimeInput,
): ApiRtcTopologyRuntime {
  const publicationRepository = new RtcTopologyPublicationRepository(
    input.runtimeStateRepository,
    DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
    input.nowEpochMs,
  );
  const executionRepository = new RtcTopologyExecutionRepository(
    input.runtimeStateRepository,
    DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
    input.nowEpochMs,
  );
  const publicationFanout = createRtcTopologyPublicationFanout({
    publisherId: input.publisherId,
    repository: publicationRepository,
    transport: createApiV1RtcTopologyClusterTransport(
      input.pubSubConfig,
      input.publisherId,
    ),
    server: input.webSocketServer,
  });
  const deliveryRepository = new PSqlRtcTopologyDeliveryRepository(input.database);
  const delivery = startApiRtcTopologyDelivery({
    streamId: input.publisherStreamId,
    repository: deliveryRepository,
    onCompactionFailure: input.onCompactionFailure,
  });
  return {
    publicationRepository,
    executionRepository,
    publicationFanout,
    topologyDelivery: {
      publisherStreamId: input.publisherStreamId,
      append: deliveryRepository,
    },
    readiness: Promise.all([
      publicationFanout.readiness,
      delivery.readiness,
    ]).then(() => undefined),
    healthFailure: delivery.healthFailure,
    stop: delivery.stop,
  };
}
