import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';

import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';

import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';

import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';

import { GROUP_TOPOLOGY_CONFIG_NAMESPACE } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';

import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';

import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import { createGroupTopologyMutationOwners } from '@shared-server/rallar-system/topology/mutation/create-group-topology-mutation-owners.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';

import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';

import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';

import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';

import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';

import type { PostgresAppInboxWorkerTrace, TopologyReadBarrierPrimitive } from './postgres-app-inbox-worker-runtime.ts';

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
    readonly group: GroupStateInboxService;
    readonly topology: TopologyInboxService;
    readonly authSessions: AuthSessionRepository;
    readonly resourceInbox: PSqlResourceInboxRepository;
    readonly resourceInboxResults: ResourceInboxResultsRepository;
    readonly inbox: InboxQueueReader;
}

interface PostgresAppInboxWorkerStateServices {
    readonly clientState: ReturnType<typeof createClientStateService>;
    readonly groupState: ReturnType<typeof createGroupStateService>;
}

interface PostgresAppInboxWorkerInboxServicesInput {
    readonly worker: CreatePostgresAppInboxWorkerServicesInput;
    readonly inbox: InboxQueueReader;
    readonly resourceInbox: PSqlResourceInboxRepository;
    readonly resourceInboxResults: ResourceInboxResultsRepository;
    readonly waitOptions: ReturnType<typeof createPostgresAppInboxWorkerWaitOptions>;
    readonly stateServices: PostgresAppInboxWorkerStateServices;
}

interface CreatePostgresAppInboxWorkerStateServicesInput {
    readonly worker: CreatePostgresAppInboxWorkerServicesInput;
    readonly runtimeRepository: PSqlRuntimeStateRepository;
    readonly authSessions: AuthSessionRepository;
}

interface CreatePostgresAppInboxWorkerTopologyServiceInput {
    readonly worker: CreatePostgresAppInboxWorkerServicesInput;
    readonly inbox: InboxQueueReader;
    readonly resourceInbox: PSqlResourceInboxRepository;
    readonly resourceInboxResults: ResourceInboxResultsRepository;
    readonly runtimeRepository: PSqlRuntimeStateRepository;
    readonly topologyRuntimeRepository: PSqlRuntimeStateRepository;
    readonly waitOptions: ReturnType<typeof createPostgresAppInboxWorkerWaitOptions>;
    readonly groupState: ReturnType<typeof createGroupStateService>;
}

export function createPostgresAppInboxWorkerServices(
    input: CreatePostgresAppInboxWorkerServicesInput
): PostgresAppInboxWorkerServices {
    const runtimeRepository = new PSqlRuntimeStateRepository(input.sql);
    const topologyRuntimeRepository = createTopologyRuntimeRepository(input, runtimeRepository);
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const resourceInbox = createPSqlResourceInboxRepository(input.sql);
    const inbox = createPostgresAppInboxWorkerInbox(resourceInbox, input.trace);
    const resourceInboxResults = new ResourceInboxResultsRepository(input.sql);
    const waitOptions = createPostgresAppInboxWorkerWaitOptions(input.atEpochMs);
    const stateServices = createPostgresAppInboxWorkerStateServices({
        worker: input,
        runtimeRepository,
        authSessions
    });
    const inboxServices = createPostgresAppInboxWorkerInboxServices({
        worker: input,
        inbox,
        resourceInbox,
        resourceInboxResults,
        waitOptions,
        stateServices
    });
    const topology = createPostgresAppInboxWorkerTopologyService({
        worker: input,
        inbox,
        resourceInbox,
        resourceInboxResults,
        runtimeRepository,
        topologyRuntimeRepository,
        waitOptions,
        groupState: stateServices.groupState
    });
    return {
        ...inboxServices,
        topology,
        authSessions,
        resourceInbox,
        resourceInboxResults,
        inbox
    };
}

function createPostgresAppInboxWorkerStateServices(
    input: CreatePostgresAppInboxWorkerStateServicesInput
): PostgresAppInboxWorkerStateServices {
    return {
        clientState: createClientStateService({
            runtimeRepository: input.runtimeRepository,
            clientStateEventStore: new PSqlClientStateEventRepository(input.worker.sql),
            serviceId: input.worker.serviceId
        }),
        groupState: createGroupStateService({
            runtimeRepository: input.runtimeRepository,
            groupStateEventStore: new PSqlGroupStateEventRepository(input.worker.sql),
            authSessionRepository: input.authSessions,
            now: () => input.worker.atEpochMs,
            serviceId: input.worker.serviceId,
            readPlannedLayoutRow: async () => null,
            readAcceptedLayoutRow: async () => null
        })
    };
}

function createPostgresAppInboxWorkerInboxServices(
    input: PostgresAppInboxWorkerInboxServicesInput
): Readonly<{ client: AppClientInboxService; group: GroupStateInboxService; }> {
    const client = new AppClientInboxService(
        {
            inboxQueueReader: input.inbox,
            resourceInboxRepository: input.resourceInbox.entries,
            resourceInboxResultsRepository: input.resourceInboxResults,
            database: input.worker.transactionSql,
            clientStateService: input.stateServices.clientState
        },
        { serviceId: input.worker.serviceId, timing: undefined, options: input.waitOptions }
    );
    const group = new GroupStateInboxService(
        {
            inboxQueueReader: input.inbox,
            resourceInboxRepository: input.resourceInbox.entries,
            resourceInboxResultsRepository: input.resourceInboxResults,
            database: input.worker.transactionSql,
            groupStateService: input.stateServices.groupState,
            resultReader: input.stateServices.groupState
        },
        { serviceId: input.worker.serviceId, timing: undefined, options: input.waitOptions }
    );
    return { client, group };
}

function createPostgresAppInboxWorkerTopologyService(
    input: CreatePostgresAppInboxWorkerTopologyServiceInput
): TopologyInboxService {
    const groupStateRepository = createTestGroupStateRepository(
        input.runtimeRepository,
        new PSqlGroupStateEventRepository(input.worker.sql)
    );
    const configRepository = new GroupTopologyConfigRepository(input.topologyRuntimeRepository);
    const runtimeOwners = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: (ref) => input.groupState.readSnapshot(ref),
        readCurrentGroupSnapshot: async (ref) => await groupStateRepository.readSnapshot(ref),
        readRttMeasurements: () => [],
        configRepository,
        topologyService: new RallarRtcTopologyService()
    });
    const mutationOwners = createGroupTopologyMutationOwners({
        groupStateRepository,
        configRepository,
        planning: runtimeOwners.planning,
        nowEpochMs: () => input.worker.atEpochMs,
        isPlatformAdmin: () => false,
        outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined })
    });
    return new TopologyInboxService(
        {
            inboxQueueReader: input.inbox,
            resourceInboxRepository: input.resourceInbox.entries,
            resourceInboxResultsRepository: input.resourceInboxResults,
            database: input.worker.transactionSql,
            groupStateService: input.groupState,
            mutationOwners: {
                configMutationService: mutationOwners.configMutation,
                reconfigureMutation: mutationOwners.reconfigureMutation
            }
        },
        { serviceId: input.worker.serviceId, options: input.waitOptions }
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

function createPostgresAppInboxWorkerWaitOptions(atEpochMs: number) {
    return {
        nowEpochMs: () => atEpochMs,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 5,
        waitJitterRatio: 0
    } as const;
}

function createPostgresAppInboxWorkerInbox(
    resourceInbox: PSqlResourceInboxRepository,
    trace: PostgresAppInboxWorkerTrace
): InboxQueueReader {
    return new InboxQueueReader(new PSqlQueueBox(resourceInbox), {
        onAttemptReleaseTelemetry: (event) =>
            trace.attempts.push({
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
