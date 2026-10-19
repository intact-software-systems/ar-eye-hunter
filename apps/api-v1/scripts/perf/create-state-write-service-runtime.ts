import { Temporal } from '@js-temporal/polyfill';
import type { Sql } from 'postgres';
import type { StateWriteBenchmarkDiagnosticPhase } from './state-write/state-write-benchmark-diagnostics.ts';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type {
    RallarTimingEvent,
    RallarTimingSink
} from '@shared-server/rallar-system/observability/timing.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import { createGroupTopologyMutationOwners } from '@shared-server/rallar-system/topology/mutation/create-group-topology-mutation-owners.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { toApiV1PostgresClient } from '../../src/db/api-v1-database-lifecycle.ts';
import {
    createInstrumentedStateWriteSql,
    type StateWriteSqlMetrics
} from './create-instrumented-state-write-sql.ts';
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
    readonly diagnosticPhase?: StateWriteBenchmarkDiagnosticPhase;
    readonly sql: Sql;
    readonly serviceId: string;
    readonly context: StateWriteServiceRuntimeContext;
    readonly timing: RallarTimingSink;
}

interface CreateStateWriteInboxRuntimeInput {
    readonly diagnosticPhase?: StateWriteBenchmarkDiagnosticPhase;
    readonly database: PSqlSql;
    readonly nowEpochMs: () => number;
    readonly context: StateWriteServiceRuntimeContext;
}

interface StateWriteInboxRuntime {
    readonly database: PSqlSql;
    readonly inboxQueueReader: InboxQueueReader;
    readonly resourceInboxRepository: TopologyInboxService.Dependencies['resourceInboxRepository'];
    readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
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

interface StateWriteTopologyServiceInput extends StateWriteDomainServiceInput {
    readonly nowEpochMs: () => number;
    readonly runtimeRepository: PSqlRuntimeStateRepository;
    readonly groupState: GroupStateService;
    readonly groupStateRepository: GroupStateRepository;
    readonly inboxQueueReader: InboxQueueReader;
    readonly resourceInboxRepository: TopologyInboxService.Dependencies['resourceInboxRepository'];
    readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
}

export function createStateWriteServiceRuntime(input: CreateStateWriteServiceRuntimeInput): StateWriteServiceRuntime {
    const { sql, serviceId, context, timing } = input;
    const nowEpochMs = Date.now;
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
    const appInboxDependencies = createStateWriteInboxRuntime({
        database: instrumentedSql,
        nowEpochMs,
        context,
        diagnosticPhase: input.diagnosticPhase
    });
    const inbox = appInboxDependencies.inboxQueueReader;
    const client = new AppClientInboxService(
        {
            ...appInboxDependencies,
            clientStateService: clientState,
            wsTickets: new AuthSessionRepository(runtimeRepository)
        },
        {
            serviceId,
            timing,
            options: STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS.client
        }
    );
    const group = new GroupStateInboxService(
        {
            ...appInboxDependencies,
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
        ...appInboxDependencies,
        nowEpochMs,
        serviceId,
        timing,
        runtimeRepository,
        groupState,
        groupStateRepository
    });
    return { client, group, topology, inbox, resilience: createBenchmarkResilience(), serviceId };
}

function createStateWriteInboxRuntime(
    { database, nowEpochMs, context, diagnosticPhase }: CreateStateWriteInboxRuntimeInput
): StateWriteInboxRuntime {
    const resourceInbox = createPSqlResourceInboxRepository(database, () => new Date(nowEpochMs()));
    const queue = new PSqlQueueBox(resourceInbox, Temporal.Now.instant);
    const ordinaryOptions: InboxQueueReader.Options = {
        laneBudgetPolicy: 'fixed-retry-two',
        newLaneConcurrency: 1,
        onAttemptReleaseTelemetry: (event) => context.attemptReleases.push(event)
    };
    const inboxQueueReader = diagnosticPhase === undefined
        ? new InboxQueueReader(queue, ordinaryOptions)
        : diagnosticPhase.createInboxQueueReader(queue, ordinaryOptions);

    return {
        database,
        inboxQueueReader,
        resourceInboxRepository: resourceInbox.entries,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(database)
    };
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
        // deno-lint-ignore require-await -- The benchmark supplies the asynchronous layout-read port.
        readPlannedLayoutRow: async () => null,
        // deno-lint-ignore require-await -- The benchmark supplies the asynchronous layout-read port.
        readAcceptedLayoutRow: async () => null
    });
    const clientState = createClientStateService({ runtimeRepository, clientStateEventStore, serviceId, timing });
    return { runtimeRepository, clientState, groupStateRepository, groupState };
}

function createStateWriteTopologyService({
    nowEpochMs,
    database,
    serviceId,
    timing,
    runtimeRepository,
    groupState,
    groupStateRepository,
    inboxQueueReader,
    resourceInboxRepository,
    resourceInboxResultsRepository
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
        nowEpochMs,
        isPlatformAdmin: () => false,
        outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined })
    });
    return new TopologyInboxService(
        {
            inboxQueueReader,
            resourceInboxRepository,
            resourceInboxResultsRepository,
            database,
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
