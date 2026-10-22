import { Temporal } from '@js-temporal/polyfill';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import { createAppInboxRetryFinalizer } from '@shared-server/rallar-system/app-inbox/app-inbox-retry-finalization.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { toGroupCommandExclusionKey } from '@shared-server/rallar-system/group-state/inbox/to-group-command-exclusion-key.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { GROUP_TOPOLOGY_CONFIG_NAMESPACE } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import { createGroupTopologyMutationOwners } from '@shared-server/rallar-system/topology/mutation/create-group-topology-mutation-owners.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { TEST_DISCONNECTED_SESSION_RETENTION_MS } from '../../../rallar-system/client-state/test-disconnected-session-retention.ts';
import type {
    PostgresAppInboxWorkerTrace,
    TopologyReadBarrierPrimitive
} from './postgres-app-inbox-worker-runtime.ts';

export interface CreatePostgresAppInboxWorkerServicesInput {
    readonly sql: PSqlSql;
    readonly transactionSql: PSqlSql;
    readonly serviceId: string;
    readonly atEpochMs: number;
    /** How long a finished command's fact, result, derived outbox rows and idempotency record stay. */
    readonly finishedRetentionMs: number;
    /** How many distinct-context heads one NEW round claims and computes together, keyed as the API server keys them. */
    readonly newLaneConcurrency: number;
    /** The rows a standing NEW-lane flight holds across passes, as the API server holds them; undefined drains each pass. */
    readonly newLaneHeldRows: number | undefined;
    /** Told of every row a standing flight takes; undefined without one. */
    readonly flightEntryListener: InboxQueueReader.FlightEntryListener | undefined;
    readonly beforeTopologyConfigRead?: (primitive: TopologyReadBarrierPrimitive) => Promise<void>;
    readonly trace: PostgresAppInboxWorkerTrace;
}

export interface PostgresAppInboxWorkerServices {
    readonly client: AppClientInboxService;
    readonly group: GroupStateInboxService;
    readonly topology: TopologyInboxService;
    readonly authSessions: AuthSessionRepository;
    readonly resourceInbox: PSqlResourceInboxRepository;
    readonly resourceInboxResults: ResourceInboxResultsRepository;
    readonly inbox: InboxQueueReader;
}

export function createPostgresAppInboxWorkerServices(
    input: CreatePostgresAppInboxWorkerServicesInput
): PostgresAppInboxWorkerServices {
    const runtimeRepository = new PSqlRuntimeStateRepository(input.sql);
    const topologyRuntimeRepository = createTopologyRuntimeRepository(input, runtimeRepository);
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const resourceInbox = createPSqlResourceInboxRepository(input.sql, () => new Date(input.atEpochMs));
    const inbox = createPostgresAppInboxWorkerInbox(resourceInbox, input);
    const resourceInboxResults = new ResourceInboxResultsRepository(input.sql);
    const inboxOptions: AppInboxOptions = {
        nowEpochMs: Date.now,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 5,
        waitJitterRatio: 0
    };
    const clientState = createClientStateService({
        runtimeRepository,
        clientStateEventStore: new PSqlClientStateEventRepository(input.sql),
        serviceId: input.serviceId
    });
    const groupEventStore = new PSqlGroupStateEventRepository(input.sql);
    const groupState = createGroupStateService({
        runtimeRepository,
        groupStateEventStore: groupEventStore,
        now: () => input.atEpochMs,
        serviceId: input.serviceId,
        finishedRetentionMs: input.finishedRetentionMs,
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null
    });
    const inboxDependencies = {
        inboxQueueReader: inbox,
        resourceInboxRepository: resourceInbox.entries,
        resourceInboxResultsRepository: resourceInboxResults,
        database: input.transactionSql
    };
    const handlerOptions = {
        serviceId: input.serviceId,
        finishedRetentionMs: input.finishedRetentionMs,
        timing: undefined,
        options: inboxOptions
    };
    const client = new AppClientInboxService(
        { ...inboxDependencies, clientStateService: clientState },
        { ...handlerOptions, disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS }
    );
    const group = new GroupStateInboxService({
        ...inboxDependencies,
        groupStateService: groupState,
        resultReader: createTestGroupStateRepository(runtimeRepository, groupEventStore)
    }, handlerOptions);
    const topology = createPostgresAppInboxTopology({
        input,
        runtimeRepository,
        topologyRuntimeRepository,
        groupEventStore,
        groupState,
        inbox,
        resourceInbox,
        resourceInboxResults,
        inboxOptions
    });
    return { client, group, topology, authSessions, resourceInbox, resourceInboxResults, inbox };
}

interface CreatePostgresAppInboxTopologyInput {
    readonly input: CreatePostgresAppInboxWorkerServicesInput;
    readonly runtimeRepository: PSqlRuntimeStateRepository;
    readonly topologyRuntimeRepository: PSqlRuntimeStateRepository;
    readonly groupEventStore: PSqlGroupStateEventRepository;
    readonly groupState: GroupStateService;
    readonly inbox: InboxQueueReader;
    readonly resourceInbox: PSqlResourceInboxRepository;
    readonly resourceInboxResults: ResourceInboxResultsRepository;
    readonly inboxOptions: AppInboxOptions;
}

function createPostgresAppInboxTopology(composition: CreatePostgresAppInboxTopologyInput): TopologyInboxService {
    const { input, runtimeRepository, topologyRuntimeRepository, groupEventStore, groupState, inbox, resourceInbox, resourceInboxResults, inboxOptions } =
        composition;
    const topologyGroupStateRepository = createTestGroupStateRepository(
        runtimeRepository,
        groupEventStore
    );
    const topologyConfigRepository = new GroupTopologyConfigRepository(topologyRuntimeRepository);
    const topologyRuntimeOwners = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: (ref) => groupState.readSnapshot(ref),
        readCurrentGroupSnapshot: async (ref) => await topologyGroupStateRepository.readSnapshot(ref),
        readRttMeasurements: () => [],
        configRepository: topologyConfigRepository,
        topologyService: new RallarRtcTopologyService({ rttReplanMinimumLayoutAgeMs: 15_000 })
    });
    const topologyMutationOwners = createGroupTopologyMutationOwners({
        groupStateRepository: topologyGroupStateRepository,
        configRepository: topologyConfigRepository,
        planning: topologyRuntimeOwners.planning,
        nowEpochMs: () => input.atEpochMs,
        isPlatformAdmin: () => false,
        outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined }),
        finishedRetentionMs: input.finishedRetentionMs
    });
    return new TopologyInboxService(
        {
            inboxQueueReader: inbox,
            resourceInboxRepository: resourceInbox.entries,
            resourceInboxResultsRepository: resourceInboxResults,
            database: input.transactionSql,
            groupStateService: groupState,
            mutationOwners: {
                configMutationService: topologyMutationOwners.configMutation,
                reconfigureMutation: topologyMutationOwners.reconfigureMutation
            }
        },
        {
            serviceId: input.serviceId,
            finishedRetentionMs: input.finishedRetentionMs,
            options: inboxOptions
        }
    );
}

function createTopologyRuntimeRepository(
    input: CreatePostgresAppInboxWorkerServicesInput,
    runtimeRepository: PSqlRuntimeStateRepository
): PSqlRuntimeStateRepository {
    if (!input.beforeTopologyConfigRead) {
        return runtimeRepository;
    }
    return new TopologyReadBarrierRuntimeStateRepository(
        input.sql,
        input.beforeTopologyConfigRead,
        input.trace
    );
}

function createPostgresAppInboxWorkerInbox(
    resourceInbox: PSqlResourceInboxRepository,
    input: Pick<CreatePostgresAppInboxWorkerServicesInput, 'sql' | 'newLaneConcurrency' | 'newLaneHeldRows' | 'flightEntryListener' | 'trace'>
): InboxQueueReader {
    const finalizeRetry = createAppInboxRetryFinalizer({ database: input.sql });
    return new InboxQueueReader(new PSqlQueueBox(resourceInbox, Temporal.Now.instant), {
        newLaneConcurrency: input.newLaneConcurrency,
        newLaneHeldRows: input.newLaneHeldRows,
        flightEntryListener: input.flightEntryListener,
        toComputeExclusionKey: (_key, attempt) => toGroupCommandExclusionKey(attempt.entry),
        onRetryExhausted: finalizeRetry,
        onRetryExhaustionRecovery: finalizeRetry,
        onAttemptReleaseTelemetry: (event) =>
            input.trace.attempts.push({
                resourceId: event.key.resourceId,
                attempt: event.attempt,
                classification: event.classification,
                status: event.status,
                retryDelayMs: event.retryDelayMs
            })
    });
}

class TopologyReadBarrierRuntimeStateRepository extends PSqlRuntimeStateRepository {
    private consumed = false;

    private readonly beforeRead: (primitive: TopologyReadBarrierPrimitive) => Promise<void>;
    private readonly trace: Pick<PostgresAppInboxWorkerTrace, 'barrierWaitCount'>;

    constructor(
        sql: PSqlSql,
        beforeRead: (primitive: TopologyReadBarrierPrimitive) => Promise<void>,
        trace: Pick<PostgresAppInboxWorkerTrace, 'barrierWaitCount'>
    ) {
        super(sql);
        this.beforeRead = beforeRead;
        this.trace = trace;
    }

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        const selections = await super.readRuntimeStateBatch(selectors);
        if (selectors.some((selector) => selector.namespace === GROUP_TOPOLOGY_CONFIG_NAMESPACE)) {
            await this.pauseOnce('readRuntimeStateBatch');
        }
        return selections;
    }

    private async pauseOnce(primitive: TopologyReadBarrierPrimitive): Promise<void> {
        if (this.consumed) {
            return;
        }
        this.consumed = true;
        this.trace.barrierWaitCount += 1;
        await this.beforeRead(primitive);
    }
}
