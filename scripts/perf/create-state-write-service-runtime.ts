import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';

import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

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

import {
    createClientStateService,
    type ClientStateService
} from '@shared-server/rallar-system/client-state/client-state-service.ts';

import {
    createGroupStateService,
    type GroupStateService
} from '@shared-server/rallar-system/group-state/group-state-service.ts';
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
    resilience: ResourceInboxResilience;
    serviceId: string;
}

export interface CreateStateWriteServiceRuntimeInput {
    readonly sql: Sql;
    readonly serviceId: string;
    readonly context: StateWriteServiceRuntimeContext;
    readonly timing: RallarTimingSink;
}

export function createStateWriteServiceRuntime(input: CreateStateWriteServiceRuntimeInput): StateWriteServiceRuntime {
    const { sql, serviceId, context, timing } = input;
    const instrumentedSql = createInstrumentedStateWriteSql({
        sql: toApiV1PostgresClient(sql),
        metrics: context.sql,
        timing
    });
    const { runtimeRepository, clientState, groupStateRepository, groupState } = createStateWriteDomainServices({
        database: instrumentedSql,
        serviceId,
        timing
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
            clientStateService: clientState
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
            groupStateService: groupState,
            resultReader: groupStateRepository
        },
        {
            serviceId,
            timing,
            options: STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS.group
        }
    );
    const topology = createStateWriteTopologyService({
        database: instrumentedSql,
        serviceId,
        timing,
        runtimeRepository,
        groupState,
        groupStateRepository,
        inbox,
        resourceInbox,
        results
    });
    return { client, group, topology, inbox, resilience: createBenchmarkResilience(), serviceId };
}

interface StateWriteDomainServiceInput {
    readonly database: PSqlSql;
    readonly serviceId: string;
    readonly timing: RallarTimingSink;
}

interface StateWriteDomainServices {
    readonly runtimeRepository: PSqlRuntimeStateRepository;
    readonly clientState: ClientStateService;
    readonly groupStateRepository: GroupStateRepository;
    readonly groupState: GroupStateService;
}

function createStateWriteDomainServices(
    { database, serviceId, timing }: StateWriteDomainServiceInput
): StateWriteDomainServices {
    const runtimeRepository = new PSqlRuntimeStateRepository(database);
    const authSessionRepository = new AuthSessionRepository(runtimeRepository);
    const clientStateEventStore = new PSqlClientStateEventRepository(database);
    const groupStateEventStore = new PSqlGroupStateEventRepository(database);
    const groupStateRepository = new GroupStateRepository(runtimeRepository, groupStateEventStore);
    const groupState = createGroupStateService({
        runtimeRepository,
        groupStateEventStore,
        serviceId,
        timing,
        authSessionRepository,
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null
    });
    const clientState = createClientStateService({ runtimeRepository, clientStateEventStore, serviceId, timing });
    return { runtimeRepository, clientState, groupStateRepository, groupState };
}

interface StateWriteTopologyServiceInput extends StateWriteDomainServiceInput {
    readonly runtimeRepository: PSqlRuntimeStateRepository;
    readonly groupState: GroupStateService;
    readonly groupStateRepository: GroupStateRepository;
    readonly inbox: InboxQueueReader;
    readonly resourceInbox: PSqlResourceInboxRepository;
    readonly results: ResourceInboxResultsRepository;
}

function createStateWriteTopologyService({
    database,
    serviceId,
    timing,
    runtimeRepository,
    groupState,
    groupStateRepository,
    inbox,
    resourceInbox,
    results
}: StateWriteTopologyServiceInput): TopologyInboxService {
    const topologyConfigRepository = new GroupTopologyConfigRepository(runtimeRepository);
    const topologyRuntimeOwners = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: (ref) => groupState.readSnapshot(ref),
        readCurrentGroupSnapshot: async (ref) => await groupStateRepository.readSnapshot(ref),
        readRttMeasurements: () => [],
        configRepository: topologyConfigRepository,
        topologyService: new RallarRtcTopologyService()
    });
    const topologyMutationOwners = createGroupTopologyMutationOwners({
        groupStateRepository,
        configRepository: topologyConfigRepository,
        planning: topologyRuntimeOwners.planning,
        nowEpochMs: () => Date.now(),
        isPlatformAdmin: () => false,
        outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined })
    });
    return new TopologyInboxService(
        {
            inboxQueueReader: inbox,
            resourceInboxRepository: resourceInbox.entries,
            resourceInboxResultsRepository: results,
            database: database,
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
}

function createBenchmarkResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(100, duration, duration, duration),
        initialRate: STATE_WRITE_REQUIRED_CONCURRENCY,
        maxRate: STATE_WRITE_REQUIRED_CONCURRENCY,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1
    });
}
