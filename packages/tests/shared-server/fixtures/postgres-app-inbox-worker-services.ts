import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';

import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';

import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';

import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';

import { GROUP_TOPOLOGY_CONFIG_NAMESPACE } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';

import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';

import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';

import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';

import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';

import { createGroupTopologyOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-owners.ts';

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
    readonly resourceInbox: ResourceInboxRepository;
    readonly resourceInboxResults: ResourceInboxResultsRepository;
    readonly inbox: InboxQueueReader;
}

export function createPostgresAppInboxWorkerServices(
    input: CreatePostgresAppInboxWorkerServicesInput
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
        clientStateEventStore: new PSqlClientStateEventRepository(input.sql),
        serviceId: input.serviceId
    });
    const groupState = createGroupStateService({
        runtimeRepository,
        groupStateEventStore: new PSqlGroupStateEventRepository(input.sql),
        authSessionRepository: authSessions,
        now: () => input.atEpochMs,
        serviceId: input.serviceId
    });
    const client = new AppClientInboxService(
        {
            inboxQueueReader: inbox,
            resourceInboxRepository: resourceInbox,
            resourceInboxResultsRepository: resourceInboxResults,
            database: input.transactionSql,
            clientStateService: clientState
        },
        {
            serviceId: input.serviceId,
            timing: undefined,
            options: waitOptions
        }
    );
    const group = new GroupStateInboxService(
        {
            inboxQueueReader: inbox,
            resourceInboxRepository: resourceInbox,
            resourceInboxResultsRepository: resourceInboxResults,
            database: input.transactionSql,
            groupStateService: groupState
        },
        {
            serviceId: input.serviceId,
            timing: undefined,
            options: waitOptions
        }
    );
    const topologyOwners = createGroupTopologyOwners({
        findGroupSnapshotByRef: (ref) => groupState.readSnapshot(ref),
        groupStateRepository: createTestGroupStateRepository(runtimeRepository),
        configRepository: new GroupTopologyConfigRepository(topologyRuntimeRepository),
        topologyService: new RallarRtcTopologyService(),
        now: () => input.atEpochMs,
        serviceId: input.serviceId
    });
    if (!topologyOwners.configMutation || !topologyOwners.reconfigureMutation) {
        throw new TypeError('PostgreSQL worker topology mutation owners are required');
    }
    const topology = new TopologyInboxService(
        {
            inboxQueueReader: inbox,
            resourceInboxRepository: resourceInbox,
            resourceInboxResultsRepository: resourceInboxResults,
            database: input.transactionSql,
            groupStateService: groupState,
            mutationOwners: {
                configMutationService: topologyOwners.configMutation,
                reconfigureMutation: topologyOwners.reconfigureMutation
            }
        },
        {
            serviceId: input.serviceId,
            options: waitOptions
        }
    );
    return { client, group, topology, authSessions, resourceInbox, resourceInboxResults, inbox };
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
    resourceInbox: ResourceInboxRepository,
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
