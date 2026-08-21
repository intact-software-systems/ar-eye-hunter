import { Temporal } from '@js-temporal/polyfill';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';

import type {
  ResourceInboxAttemptReleaseTelemetry,
} from '@shared/queuebox/ResourceInboxAttemptTelemetry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';

import {
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';

import {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';

import {
  PSqlRuntimeStateRepository,
} from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
  createClientStateEventRepository,
  createGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';

import {
  AuthSessionRepository,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';

import {
  GroupStateRepository,
} from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';

import {
  AppClientInboxService,
} from '@shared-server/rallar-system/services/AppClientInboxService.ts';

import {
  AppGroupInboxService,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';

import {
  createClientStateService,
} from '@shared-server/rallar-system/services/client-state-service.ts';

import {
  createGroupStateService,
} from '@shared-server/rallar-system/services/group-state-service.ts';

import {
  RallarRtcTopologyService,
} from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import type {
  RallarTimingEvent,
  RallarTimingSink,
} from '@shared-server/rallar-system/services/timing.ts';

import {
  GroupTopologyConfigRepository,
} from '@shared-server/rallar-system/topology/config/persistence/\
group-topology-config-repository.ts';

import {
  GroupTopologyManagementService,
} from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
import type { Sql } from 'postgres';

import { toPSqlSql } from '../../apps/api-v1/src/db/to-p-sql-sql.ts';
import {
  createInstrumentedStateWriteSql,
  type StateWriteSqlMetrics,
} from './create-instrumented-state-write-sql.ts';

import {
  STATE_WRITE_REQUIRED_CONCURRENCY,
} from './state-write/api-v1-state-write-benchmark-options.ts';
import { STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS } from './state-write-wait-options.ts';

export interface StateWriteServiceRuntimeContext {
  sql: StateWriteSqlMetrics;
  timingEvents: RallarTimingEvent[];
  attemptReleases: ResourceInboxAttemptReleaseTelemetry[];
}

export interface StateWriteServiceRuntime {
  client: AppClientInboxService;
  group: AppGroupInboxService;
  inbox: InboxQueueReader;
  resilience: ResilienceDto;
  serviceId: string;
}

export type CreateStateWriteServiceRuntimeInput = Readonly<{
  sql: Sql;
  serviceId: string;
  context: StateWriteServiceRuntimeContext;
  timing: RallarTimingSink;
}>;

export function createStateWriteServiceRuntime({
  sql,
  serviceId,
  context,
  timing,
}: CreateStateWriteServiceRuntimeInput): StateWriteServiceRuntime {
  const instrumentedSql = createInstrumentedStateWriteSql({
    sql: toPSqlSql(sql),
    metrics: context.sql,
    timing,
  });
  const runtimeRepository = new PSqlRuntimeStateRepository(instrumentedSql);
  const authSessionRepository = new AuthSessionRepository(runtimeRepository);
  const groupState = createGroupStateService({
    runtimeRepository,
    formationDamping: 'damped',
    createGroupStateEventStore: createGroupStateEventRepository,
    serviceId,
    timing,
    authSessionRepository,
  });
  const resourceInbox = new ResourceInboxRepository(instrumentedSql);
  const inbox = new InboxQueueReader(new PSqlQueueBox(resourceInbox), {
    onAttemptReleaseTelemetry: (event) => context.attemptReleases.push(event),
  });
  const results = new ResourceInboxResultsRepository(instrumentedSql);
  const client = new AppClientInboxService(
    {
      inboxQueueReader: inbox,
      resourceInboxRepository: resourceInbox,
      resourceInboxResultsRepository: results,
      database: instrumentedSql,
      clientStateService: createClientStateService({
        runtimeRepository,
        formationDamping: 'damped',
        createClientStateEventStore: createClientStateEventRepository,
        serviceId,
        timing,
      }),
    },
    {
      serviceId,
      timing,
      options: STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS.client,
    },
  );
  const group = new AppGroupInboxService(
    {
      inboxQueueReader: inbox,
      resourceInboxRepository: resourceInbox,
      resourceInboxResultsRepository: results,
      database: instrumentedSql,
      groupStateService: groupState,
    },
    {
      serviceId,
      timing,
      options: STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS.group,
    },
  );
  group.setTopologyManagementService(
    new GroupTopologyManagementService({
      findGroupSnapshotByRef: (ref) => groupState.readSnapshot(ref),
      groupStateRepository: new GroupStateRepository(runtimeRepository),
      configRepository: new GroupTopologyConfigRepository(runtimeRepository),
      topologyService: new RallarRtcTopologyService(),
      timing,
      serviceId,
    }),
  );
  return { client, group, inbox, resilience: createBenchmarkResilience(), serviceId };
}

function createBenchmarkResilience(): ResilienceDto {
  const duration = Temporal.Duration.from({ seconds: 10 });
  return ResilienceDto.toResilienceDto(
    new CircuitBreakerPolicy(100, duration, duration, duration),
    STATE_WRITE_REQUIRED_CONCURRENCY,
    STATE_WRITE_REQUIRED_CONCURRENCY,
    1,
    1,
  );
}
