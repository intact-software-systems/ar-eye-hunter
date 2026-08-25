import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import type { CreateRallarMiddlewareOptions } from '@shared-server/rallar-system/middleware/rallar-middleware-construction.ts';
import { RtcRttInboxService } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import { createGroupTopologyMutationOwners } from '@shared-server/rallar-system/topology/mutation/create-group-topology-mutation-owners.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { createTestClientStateRepository, createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';

import { createAppInboxTestDatabase } from '../../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { TestResourceInbox, TestResourceInboxResults } from '../../group-state/inbox/group-state-inbox-resource-fixtures.ts';

const TEST_SERVICE_ID = 'rallar-middleware-test';

export type RallarMiddlewareInboxConstructionEvent =
    | 'group-state-handlers-registered'
    | 'topology-handlers-registered'
    | 'rtc-rtt-handlers-registered'
    | 'client-state-handlers-registered';

export interface CreateRallarMiddlewareTestRuntimeInput {
    readonly resilience: CreateRallarMiddlewareOptions['resilience'];
    readonly outbox?: QueueBoxResourceEntryRepository;
    readonly wsRuntimeName?: string;
    readonly readiness?: Promise<void>;
    readonly healthFailure?: Promise<never>;
    readonly queuePubSubBridge?: CreateRallarMiddlewareOptions['queuePubSubBridge'];
    readonly constructionEvents?: RallarMiddlewareInboxConstructionEvent[];
}

export interface RallarMiddlewareTestRuntime {
    readonly options: CreateRallarMiddlewareOptions;
    readonly inbox: TestResourceInbox;
    readonly outbox: QueueBoxResourceEntryRepository;
}

export function createRallarMiddlewareTestRuntime(
    input: CreateRallarMiddlewareTestRuntimeInput
): RallarMiddlewareTestRuntime {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const inbox = new TestResourceInbox();
    const outbox = input.outbox ?? inbox;
    const results = new TestResourceInboxResults();
    const database = createAppInboxTestDatabase(inbox, results, { runtimeRepository });
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const clientStateService = createClientStateService({
        runtimeRepository,
        clientStateEventStore: database.clientEventStore,
        serviceId: TEST_SERVICE_ID
    });
    const groupStateService = createGroupStateService({
        runtimeRepository,
        groupStateEventStore: database.groupEventStore,
        authSessionRepository: authSessions,
        serviceId: TEST_SERVICE_ID
    });
    const clientsRepository = createTestClientStateRepository(
        runtimeRepository,
        database.clientEventStore
    );
    const groupsRepository = createTestGroupStateRepository(
        runtimeRepository,
        database.groupEventStore
    );
    const topologyOutboxWriter = new RtcTopologyOutboxWriter({ recordWrite: () => undefined });
    const topologyConfigRepository = new GroupTopologyConfigRepository(runtimeRepository);
    const topologyRuntimeOwners = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: async (ref) => await groupStateService.readSnapshot(ref),
        readCurrentGroupSnapshot: async (ref) => await groupsRepository.readSnapshot(ref),
        readRttMeasurements: () => [],
        configRepository: topologyConfigRepository,
        topologyService: new RallarRtcTopologyService()
    });
    const topologyMutationOwners = createGroupTopologyMutationOwners({
        groupStateRepository: groupsRepository,
        configRepository: topologyConfigRepository,
        planning: topologyRuntimeOwners.planning,
        nowEpochMs: () => Date.now(),
        isPlatformAdmin: () => false,
        outboxWriter: topologyOutboxWriter
    });
    const configMutationService = topologyMutationOwners.configMutation;
    const reconfigureMutation = topologyMutationOwners.reconfigureMutation;

    const options: CreateRallarMiddlewareOptions = {
        inbox,
        outbox,
        wsRuntimeName: input.wsRuntimeName,
        resilience: input.resilience,
        clientsRepository,
        groupsRepository,
        readiness: input.readiness,
        healthFailure: input.healthFailure,
        queuePubSubBridge: input.queuePubSubBridge,
        createGroupStateInboxService: (factoryInput) => {
            const service = new GroupStateInboxService(
                {
                    inboxQueueReader: factoryInput.inboxQueueReader,
                    resourceInboxRepository: inbox,
                    resourceInboxResultsRepository: results,
                    database,
                    groupStateService
                },
                {
                    serviceId: TEST_SERVICE_ID,
                    wakeOwningQueue: factoryInput.wakeQueueEngine
                }
            );
            input.constructionEvents?.push('group-state-handlers-registered');
            return service;
        },
        createTopologyInboxService: (factoryInput) => {
            const service = new TopologyInboxService(
                {
                    inboxQueueReader: factoryInput.inboxQueueReader,
                    resourceInboxRepository: inbox,
                    resourceInboxResultsRepository: results,
                    database,
                    groupStateService,
                    mutationOwners: {
                        configMutationService,
                        reconfigureMutation
                    }
                },
                {
                    serviceId: TEST_SERVICE_ID,
                    wakeOwningQueue: factoryInput.wakeQueueEngine
                }
            );
            input.constructionEvents?.push('topology-handlers-registered');
            return service;
        },
        createRtcRttInboxService: (factoryInput) => {
            const service = new RtcRttInboxService(
                {
                    inboxQueueReader: factoryInput.inboxQueueReader,
                    resourceInboxRepository: inbox,
                    resourceInboxResultsRepository: results,
                    database,
                    groupStateService,
                    mutationDependencies: {
                        repository: new RtcRttRepository(runtimeRepository),
                        outboxWriter: topologyOutboxWriter,
                        readPolicyInputs: async () => ({
                            candidateGroups: [],
                            overlaySnapshotsByGroupKey: new Map(),
                            degreeLimit: 2
                        })
                    }
                },
                {
                    serviceId: TEST_SERVICE_ID,
                    wakeOwningQueue: factoryInput.wakeQueueEngine
                }
            );
            input.constructionEvents?.push('rtc-rtt-handlers-registered');
            return service;
        },
        createAppClientInboxService: (factoryInput) => {
            const service = new AppClientInboxService(
                {
                    inboxQueueReader: factoryInput.inboxQueueReader,
                    resourceInboxRepository: inbox,
                    resourceInboxResultsRepository: results,
                    database,
                    clientStateService
                },
                {
                    serviceId: TEST_SERVICE_ID,
                    wakeOwningQueue: factoryInput.wakeQueueEngine
                }
            );
            input.constructionEvents?.push('client-state-handlers-registered');
            return service;
        }
    };

    return { options, inbox, outbox };
}
