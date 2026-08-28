import { Temporal } from '@js-temporal/polyfill';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';

import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/ResourceInboxAttemptTelemetry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';

import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';

import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';

import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';

import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';

import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';

import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';

import type { RallarTimingEvent, RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';

import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';

import { createGroupTopologyMutationOwners } from '@shared-server/rallar-system/topology/mutation/create-group-topology-mutation-owners.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import type { Sql } from 'postgres';

import { toApiV1PostgresClient } from '../../apps/api-v1/src/db/api-v1-database-lifecycle.ts';
import { createInstrumentedStateWriteSql, type StateWriteSqlMetrics } from './create-instrumented-state-write-sql.ts';

import { STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS } from './state-write-wait-options.ts';
import { STATE_WRITE_REQUIRED_CONCURRENCY } from './state-write/api-v1-state-write-benchmark-options.ts';

export interface StateWriteServiceRuntimeContext {
    sql: StateWriteSqlMetrics;
    timingEvents: RallarTimingEvent[];
    attemptReleases: ResourceInboxAttemptReleaseTelemetry[];
}

export interface StateWriteServiceRuntime {
    client: AppClientInboxService;
    group: GroupStateInboxService;
    topology: TopologyInboxService;
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
    timing
}: CreateStateWriteServiceRuntimeInput): StateWriteServiceRuntime {
    const instrumentedSql = createInstrumentedStateWriteSql({
        sql: toApiV1PostgresClient(sql),
        metrics: context.sql,
        timing
    });
    const runtimeRepository = new PSqlRuntimeStateRepository(instrumentedSql);
    const authSessionRepository = new AuthSessionRepository(runtimeRepository);
    const clientStateEventStore = new PSqlClientStateEventRepository(instrumentedSql);
    const groupStateEventStore = new PSqlGroupStateEventRepository(instrumentedSql);
    const groupState = createGroupStateService({
        runtimeRepository,
        groupStateEventStore,
        serviceId,
        timing,
        authSessionRepository,
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null
    });
    const resourceInbox = createPSqlResourceInboxRepository(instrumentedSql);
    const inbox = new InboxQueueReader(new PSqlQueueBox(resourceInbox), {
        onAttemptReleaseTelemetry: (event) => context.attemptReleases.push(event)
    });
    const results = new ResourceInboxResultsRepository(instrumentedSql);
    const client = new AppClientInboxService(
        {
            inboxQueueReader: inbox,
            resourceInboxRepository: resourceInbox.entries,
            resourceInboxResultsRepository: results,
            database: instrumentedSql,
            clientStateService: createClientStateService({
                runtimeRepository,
                clientStateEventStore,
                serviceId,
                timing
            })
        },
        {
            serviceId,
            timing,
            options: STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS.client
        }
    );
    const group = new GroupStateInboxService(
        {
            inboxQueueReader: inbox,
            resourceInboxRepository: resourceInbox.entries,
            resourceInboxResultsRepository: results,
            database: instrumentedSql,
            groupStateService: groupState
        },
        {
            serviceId,
            timing,
            options: STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS.group
        }
    );
    const topologyGroupStateRepository = new GroupStateRepository(runtimeRepository, groupStateEventStore);
    const topologyConfigRepository = new GroupTopologyConfigRepository(runtimeRepository);
    const topologyRuntimeOwners = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: (ref) => groupState.readSnapshot(ref),
        readCurrentGroupSnapshot: async (ref) => await topologyGroupStateRepository.readSnapshot(ref),
        readRttMeasurements: () => [],
        configRepository: topologyConfigRepository,
        topologyService: new RallarRtcTopologyService()
    });
    const topologyMutationOwners = createGroupTopologyMutationOwners({
        groupStateRepository: topologyGroupStateRepository,
        configRepository: topologyConfigRepository,
        planning: topologyRuntimeOwners.planning,
        nowEpochMs: () => Date.now(),
        isPlatformAdmin: () => false,
        outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined })
    });
    const topology = new TopologyInboxService(
        {
            inboxQueueReader: inbox,
            resourceInboxRepository: resourceInbox.entries,
            resourceInboxResultsRepository: results,
            database: instrumentedSql,
            groupStateService: groupState,
            mutationOwners: {
                configMutationService: topologyMutationOwners.configMutation,
                reconfigureMutation: topologyMutationOwners.reconfigureMutation
            }
        },
        {
            serviceId,
            timing,
            options: STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS.group
        }
    );
    return { client, group, topology, inbox, resilience: createBenchmarkResilience(), serviceId };
}

function createBenchmarkResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(100, duration, duration, duration),
        STATE_WRITE_REQUIRED_CONCURRENCY,
        STATE_WRITE_REQUIRED_CONCURRENCY,
        1,
        1
    );
}
