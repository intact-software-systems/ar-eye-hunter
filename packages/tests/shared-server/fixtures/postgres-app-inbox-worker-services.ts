import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
// prettier-ignore
import {
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
// prettier-ignore
import {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import {
  createClientStateEventRepository,
  createGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
// prettier-ignore
import {
  PSqlRuntimeStateRepository,
} from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
// prettier-ignore
import {
  AuthSessionRepository,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
// prettier-ignore
import {
  GroupStateRepository,
} from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
// prettier-ignore
import {
  GroupTopologyConfigRepository,
} from '@shared-server/rallar-system/topology/config/persistence/\
group-topology-config-repository.ts';
// prettier-ignore
import {
  GROUP_TOPOLOGY_CONFIG_NAMESPACE,
} from '@shared-server/rallar-system/topology/config/persistence/\
group-topology-config-runtime-namespaces.ts';
// prettier-ignore
import {
  AppClientInboxService,
} from '@shared-server/rallar-system/services/AppClientInboxService.ts';
// prettier-ignore
import {
  AppGroupInboxService,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
// prettier-ignore
import {
  createClientStateService,
} from '@shared-server/rallar-system/services/client-state-service.ts';
// prettier-ignore
import {
  createGroupStateService,
} from '@shared-server/rallar-system/services/group-state-service.ts';
// prettier-ignore
import {
  GroupTopologyManagementService,
} from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
// prettier-ignore
import {
  RallarRtcTopologyService,
} from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import type {
  RuntimeStateReadBatchSelection,
  RuntimeStateReadBatchSelector,
} from '@shared-server/runtime-state/RuntimeStateReadBatch.ts';

import type {
  PostgresAppInboxWorkerTrace,
  TopologyReadBarrierPrimitive,
} from './postgres-app-inbox-worker-runtime.ts';

export interface CreatePostgresAppInboxWorkerServicesInput {
  readonly sql: PSqlSql;
  readonly transactionSql: PSqlSql;
  readonly serviceId: string;
  readonly atEpochMs: number;
  readonly beforeTopologyConfigRead?: (primitive: TopologyReadBarrierPrimitive) => Promise<void>;
  readonly trace: PostgresAppInboxWorkerTrace;
}

export interface PostgresAppInboxWorkerServices {
  readonly client: AppClientInboxService;
  readonly group: AppGroupInboxService;
  readonly authSessions: AuthSessionRepository;
  readonly resourceInbox: ResourceInboxRepository;
  readonly resourceInboxResults: ResourceInboxResultsRepository;
  readonly inbox: InboxQueueReader;
}

export function createPostgresAppInboxWorkerServices(
  input: CreatePostgresAppInboxWorkerServicesInput,
): PostgresAppInboxWorkerServices {
  const runtimeRepository = new PSqlRuntimeStateRepository(input.sql);
  const topologyRuntimeRepository = createTopologyRuntimeRepository(input, runtimeRepository);
  const authSessions = new AuthSessionRepository(runtimeRepository);
  const resourceInbox = new ResourceInboxRepository(input.sql);
  const inbox = createPostgresAppInboxWorkerInbox(resourceInbox, input.trace);
  const resourceInboxResults = new ResourceInboxResultsRepository(input.sql);
  const waitOptions = createPostgresAppInboxWorkerWaitOptions(input.atEpochMs);
  const clientState = createClientStateService({
    runtimeRepository,
    formationDamping: 'damped',
    createClientStateEventStore: createClientStateEventRepository,
    serviceId: input.serviceId,
  });
  const groupState = createGroupStateService({
    runtimeRepository,
    formationDamping: 'damped',
    createGroupStateEventStore: createGroupStateEventRepository,
    authSessionRepository: authSessions,
    now: () => input.atEpochMs,
    serviceId: input.serviceId,
  });
  const client = new AppClientInboxService(
    {
      inboxQueueReader: inbox,
      resourceInboxRepository: resourceInbox,
      resourceInboxResultsRepository: resourceInboxResults,
      database: input.transactionSql,
      clientStateService: clientState,
    },
    {
      serviceId: input.serviceId,
      timing: undefined,
      options: waitOptions,
    },
  );
  const group = new AppGroupInboxService(
    {
      inboxQueueReader: inbox,
      resourceInboxRepository: resourceInbox,
      resourceInboxResultsRepository: resourceInboxResults,
      database: input.transactionSql,
      groupStateService: groupState,
    },
    {
      serviceId: input.serviceId,
      timing: undefined,
      options: waitOptions,
    },
  );
  group.setTopologyManagementService(
    new GroupTopologyManagementService({
      findGroupSnapshotByRef: (ref) => groupState.readSnapshot(ref),
      groupStateRepository: new GroupStateRepository(runtimeRepository),
      configRepository: new GroupTopologyConfigRepository(topologyRuntimeRepository),
      topologyService: new RallarRtcTopologyService(),
      now: () => input.atEpochMs,
      serviceId: input.serviceId,
    }),
  );
  return { client, group, authSessions, resourceInbox, resourceInboxResults, inbox };
}

function createTopologyRuntimeRepository(
  input: CreatePostgresAppInboxWorkerServicesInput,
  runtimeRepository: PSqlRuntimeStateRepository,
): PSqlRuntimeStateRepository {
  if (!input.beforeTopologyConfigRead) return runtimeRepository;
  return new TopologyReadBarrierRuntimeStateRepository(
    input.sql,
    input.beforeTopologyConfigRead,
    input.trace,
  );
}

function createPostgresAppInboxWorkerWaitOptions(atEpochMs: number) {
  return {
    nowEpochMs: () => atEpochMs,
    waitRetryIntervalMsecs: 1,
    waitMaxRetryIntervalMsecs: 5,
    waitJitterRatio: 0,
  } as const;
}

function createPostgresAppInboxWorkerInbox(
  resourceInbox: ResourceInboxRepository,
  trace: PostgresAppInboxWorkerTrace,
): InboxQueueReader {
  return new InboxQueueReader(new PSqlQueueBox(resourceInbox), {
    onAttemptReleaseTelemetry: (event) =>
      trace.attempts.push({
        resourceId: event.key.resourceId,
        attempt: event.attempt,
        classification: event.classification,
        status: event.status,
        retryDelayMs: event.retryDelayMs,
      }),
  });
}

class TopologyReadBarrierRuntimeStateRepository extends PSqlRuntimeStateRepository {
  private consumed = false;

  private readonly beforeRead: (primitive: TopologyReadBarrierPrimitive) => Promise<void>;
  private readonly trace: Pick<PostgresAppInboxWorkerTrace, 'barrierWaitCount'>;

  constructor(
    sql: PSqlSql,
    beforeRead: (primitive: TopologyReadBarrierPrimitive) => Promise<void>,
    trace: Pick<PostgresAppInboxWorkerTrace, 'barrierWaitCount'>,
  ) {
    super(sql);
    this.beforeRead = beforeRead;
    this.trace = trace;
  }

  override async readRuntimeStateBatch(
    selectors: readonly RuntimeStateReadBatchSelector[],
  ): Promise<readonly RuntimeStateReadBatchSelection[]> {
    const selections = await super.readRuntimeStateBatch(selectors);
    if (selectors.some((selector) => selector.namespace === GROUP_TOPOLOGY_CONFIG_NAMESPACE)) {
      await this.pauseOnce('readRuntimeStateBatch');
    }
    return selections;
  }

  private async pauseOnce(primitive: TopologyReadBarrierPrimitive): Promise<void> {
    if (this.consumed) return;
    this.consumed = true;
    this.trace.barrierWaitCount += 1;
    await this.beforeRead(primitive);
  }
}
