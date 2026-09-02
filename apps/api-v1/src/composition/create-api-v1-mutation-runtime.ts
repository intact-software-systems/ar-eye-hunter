import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import { createAppInboxRetryFinalizer } from '@shared-server/rallar-system/app-inbox/app-inbox-retry-finalization.ts';
import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import {
    createHmacAuthCredentialIssuer
} from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import {
    createCachedClientStateService
} from '@shared-server/rallar-system/client-state/snapshot/cached-client-state-service.ts';
import { ClientStateSnapshotReadThroughCache } from '@shared-server/rallar-system/client-state/snapshot/client-state-snapshot-read-through-cache.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type {
    GroupPolicyCapacityConfig
} from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import {
    GroupPresenceSummaryWork
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import {
    createCachedGroupStateService
} from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import { GroupStateSnapshotReadThroughCache } from '@shared-server/rallar-system/group-state/snapshot/group-state-snapshot-read-through-cache.ts';
import type { CreateRallarMiddlewareOptions } from '@shared-server/rallar-system/middleware/rallar-middleware-construction.ts';
import {
    createGroupFormationMetricsRecorder,
    type RallarGroupFormationMetricsRecorder
} from '@shared-server/rallar-system/observability/formation-metrics.ts';
import { recordRallarTiming, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';
import type { DequeueResourceEntryOptions, ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import { RtcTopologyInputFingerprintRepository } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import { createApiCrdtDocumentAuthorizer } from '../crdt/create-api-crdt-document-authorizer.ts';
import { createApiCrdtInboxFactory } from '../crdt/create-api-crdt-inbox-factory.ts';
import {
    createApiMutationInboxFactories,
    type ApiMutationInboxFactories
} from '../services/create-api-mutation-inbox-factories.ts';

export interface ApiV1MutationRuntimeResilience {
    readonly inbox: ResilienceDto;
    readonly outbox: ResilienceDto;
    readonly appOutbox: ResilienceDto;
}

export interface CreateApiV1MutationRuntimeInput {
    readonly database: PSqlSql;
    readonly serviceId: string;
    readonly authCredentialSecret: string;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink;
    readonly appInboxOptions: AppInboxOptions;
    readonly groupCapacity: GroupPolicyCapacityConfig;
    readonly groupFormationRecomputeDebounceMs: number;
    readonly adminClientIds: readonly string[];
    readonly crdtPolicies: readonly RallarCrdtDocumentTypePolicy[];
    readonly resilience: ApiV1MutationRuntimeResilience;
}

export interface ApiV1MutationRuntime {
    readonly database: PSqlSql;
    readonly serviceId: string;
    readonly appInboxOptions: AppInboxOptions;
    readonly queueBox: PSqlQueueBox;
    readonly resourceInboxRepository: PSqlResourceInboxRepository;
    readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
    readonly webSocketServer: JsonWebSocketServer;
    readonly runtimeStateRepository: PSqlRuntimeStateRepository;
    readonly authSessionRepository: AuthSessionRepository;
    readonly clientsRepository: ClientStateRepository;
    readonly groupsRepository: GroupStateRepository;
    readonly clientSnapshotCache: ClientStateSnapshotReadThroughCache;
    readonly groupSnapshotCache: GroupStateSnapshotReadThroughCache;
    readonly groupFormationMetrics: RallarGroupFormationMetricsRecorder;
    readonly groupStateService: ReturnType<typeof createCachedGroupStateService>;
    readonly appInboxDequeueOptions: DequeueResourceEntryOptions;
    readonly createGroupStateInboxService: CreateRallarMiddlewareOptions['createGroupStateInboxService'];
    readonly createAppClientInboxService: CreateRallarMiddlewareOptions['createAppClientInboxService'];
    readonly createAppAuthInboxService: NonNullable<CreateRallarMiddlewareOptions['createAppAuthInboxService']>;
    readonly createAppAdminInboxService: NonNullable<CreateRallarMiddlewareOptions['createAppAdminInboxService']>;
    readonly createAppCrdtInboxService: NonNullable<CreateRallarMiddlewareOptions['createAppCrdtInboxService']>;
    readonly resilience: CreateRallarMiddlewareOptions['resilience'];
}

interface ApiV1StateMutationDependencies {
    readonly database: PSqlSql;
    readonly serviceId: string;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink;
    readonly appInboxOptions: AppInboxOptions;
    readonly resourceInboxRepository: PSqlResourceInboxRepository;
    readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
    readonly runtimeStateRepository: PSqlRuntimeStateRepository;
    readonly authSessionRepository: AuthSessionRepository;
    readonly clientStateEventStore: PSqlClientStateEventRepository;
    readonly clientSnapshotCache: ClientStateSnapshotReadThroughCache;
    readonly groupSnapshotCache: GroupStateSnapshotReadThroughCache;
    readonly groupFormationMetrics: RallarGroupFormationMetricsRecorder;
}

interface ApiV1MutationResources {
    readonly queueBox: PSqlQueueBox;
    readonly resourceInboxRepository: PSqlResourceInboxRepository;
    readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
    readonly runtimeStateRepository: PSqlRuntimeStateRepository;
    readonly authSessionRepository: AuthSessionRepository;
    readonly clientsRepository: ClientStateRepository;
    readonly groupsRepository: GroupStateRepository;
    readonly clientStateEventStore: PSqlClientStateEventRepository;
    readonly groupStateEventStore: PSqlGroupStateEventRepository;
    readonly clientSnapshotCache: ClientStateSnapshotReadThroughCache;
    readonly groupSnapshotCache: GroupStateSnapshotReadThroughCache;
    readonly groupFormationMetrics: RallarGroupFormationMetricsRecorder;
}

interface CreateGroupStateInboxServiceFactoryInput extends ApiV1StateMutationDependencies {
    readonly groupStateService: ReturnType<typeof createCachedGroupStateService>;
    readonly groupFormationRecomputeDebounceMs: number;
}

interface CreateAppAuthInboxServiceFactoryInput extends ApiV1StateMutationDependencies {
    readonly authCredentialSecret: string;
}

export function createApiV1MutationRuntime(
    input: CreateApiV1MutationRuntimeInput
): ApiV1MutationRuntime {
    const resources = createApiV1MutationResources(input.database);
    const stateDependencies = createApiV1StateMutationDependencies(input, resources);
    const mutationFactories = createApiV1MutationInboxFactories(input, resources);
    const plannedSnapshotRepository = new RtcTopologySnapshotRepository(
        resources.runtimeStateRepository
    );
    const acceptedSnapshotRepository = new RtcTopologySnapshotRepository(
        resources.runtimeStateRepository,
        RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE
    );
    const groupStateService = createCachedGroupStateService({
        durable: createGroupStateService({
            runtimeRepository: resources.runtimeStateRepository,
            capacity: input.groupCapacity,
            authSessionRepository: resources.authSessionRepository,
            groupStateEventStore: resources.groupStateEventStore,
            serviceId: input.serviceId,
            timing: input.timing,
            readPlannedLayoutRow: async (ref) => {
                const planned = await plannedSnapshotRepository.findSnapshotEntry(ref);
                if (!planned) {
                    return null;
                }
                const inputFingerprint = await new RtcTopologyInputFingerprintRepository(
                    resources.runtimeStateRepository,
                    'planned'
                ).findFingerprint(ref);
                return { snapshot: planned.value, revision: planned.entry.revision, inputFingerprint };
            },
            readAcceptedLayoutRow: async (ref) => {
                const accepted = await acceptedSnapshotRepository.findSnapshotEntry(ref);
                return accepted
                    ? { snapshot: accepted.value, revision: accepted.entry.revision }
                    : null;
            }
        }),
        cache: resources.groupSnapshotCache
    });

    return {
        database: input.database,
        serviceId: input.serviceId,
        appInboxOptions: input.appInboxOptions,
        queueBox: resources.queueBox,
        resourceInboxRepository: resources.resourceInboxRepository,
        resourceInboxResultsRepository: resources.resourceInboxResultsRepository,
        webSocketServer: new JsonWebSocketServer(),
        runtimeStateRepository: resources.runtimeStateRepository,
        authSessionRepository: resources.authSessionRepository,
        clientsRepository: resources.clientsRepository,
        groupsRepository: resources.groupsRepository,
        clientSnapshotCache: resources.clientSnapshotCache,
        groupSnapshotCache: resources.groupSnapshotCache,
        groupFormationMetrics: resources.groupFormationMetrics,
        groupStateService,
        appInboxDequeueOptions: createAppInboxDequeueOptions(input),
        createGroupStateInboxService: createGroupStateInboxServiceFactory({
            ...stateDependencies,
            groupStateService,
            groupFormationRecomputeDebounceMs: input.groupFormationRecomputeDebounceMs
        }),
        createAppClientInboxService: createAppClientInboxServiceFactory(stateDependencies),
        createAppAuthInboxService: createAppAuthInboxServiceFactory({
            ...stateDependencies,
            authCredentialSecret: input.authCredentialSecret
        }),
        ...mutationFactories,
        resilience: input.resilience
    };
}

function createApiV1MutationResources(
    database: PSqlSql
): ApiV1MutationResources {
    const resourceInboxRepository = createPSqlResourceInboxRepository(database);
    const resourceInboxResultsRepository = new ResourceInboxResultsRepository(database);
    const runtimeStateRepository = new PSqlRuntimeStateRepository(database);
    const authSessionRepository = new AuthSessionRepository(runtimeStateRepository);
    const clientStateEventStore = new PSqlClientStateEventRepository(database);
    const groupStateEventStore = new PSqlGroupStateEventRepository(database);
    const clientsRepository = new ClientStateRepository(runtimeStateRepository, clientStateEventStore);
    const groupsRepository = new GroupStateRepository(runtimeStateRepository, groupStateEventStore);
    return {
        queueBox: new PSqlQueueBox(resourceInboxRepository),
        resourceInboxRepository,
        resourceInboxResultsRepository,
        runtimeStateRepository,
        authSessionRepository,
        clientsRepository,
        groupsRepository,
        clientStateEventStore,
        groupStateEventStore,
        clientSnapshotCache: new ClientStateSnapshotReadThroughCache({ clientsRepository }),
        groupSnapshotCache: new GroupStateSnapshotReadThroughCache({ groupsRepository }),
        groupFormationMetrics: createGroupFormationMetricsRecorder()
    };
}

function createApiV1StateMutationDependencies(
    input: CreateApiV1MutationRuntimeInput,
    resources: ApiV1MutationResources
): ApiV1StateMutationDependencies {
    return {
        database: input.database,
        serviceId: input.serviceId,
        nowEpochMs: input.nowEpochMs,
        timing: input.timing,
        appInboxOptions: input.appInboxOptions,
        resourceInboxRepository: resources.resourceInboxRepository,
        resourceInboxResultsRepository: resources.resourceInboxResultsRepository,
        runtimeStateRepository: resources.runtimeStateRepository,
        authSessionRepository: resources.authSessionRepository,
        clientStateEventStore: resources.clientStateEventStore,
        clientSnapshotCache: resources.clientSnapshotCache,
        groupSnapshotCache: resources.groupSnapshotCache,
        groupFormationMetrics: resources.groupFormationMetrics
    };
}

function createApiV1MutationInboxFactories(
    input: CreateApiV1MutationRuntimeInput,
    resources: ApiV1MutationResources
): ApiMutationInboxFactories {
    const readSession = (sessionId: string) => resources.authSessionRepository.findBySessionId(sessionId);
    const currentAuthority = {
        readSession,
        authorizeDocument: createApiCrdtDocumentAuthorizer({
            readGroupSnapshot: (ref) => resources.groupsRepository.readSnapshot(ref),
            readClientSnapshot: (ref) => resources.clientsRepository.readSnapshot(ref),
            nowEpochMs: input.nowEpochMs
        }),
        adminClientIds: input.adminClientIds
    };
    const createAppCrdtInboxService = createApiCrdtInboxFactory({
        resourceInboxRepository: resources.resourceInboxRepository.entries,
        resourceInboxResultsRepository: resources.resourceInboxResultsRepository,
        database: input.database,
        serviceId: input.serviceId,
        timing: input.timing,
        options: input.appInboxOptions,
        currentAuthority,
        policies: input.crdtPolicies
    });
    return createApiMutationInboxFactories({
        createAppCrdtInboxService,
        resourceInboxRepository: resources.resourceInboxRepository,
        resourceInboxResultsRepository: resources.resourceInboxResultsRepository,
        database: input.database,
        serviceId: input.serviceId,
        timing: input.timing,
        options: input.appInboxOptions,
        currentAuthority: {
            readSession,
            adminClientIds: input.adminClientIds
        }
    });
}

function createGroupStateInboxServiceFactory(
    input: CreateGroupStateInboxServiceFactoryInput
): CreateRallarMiddlewareOptions['createGroupStateInboxService'] {
    return ({ inboxQueueReader, outboxQueueReader, wakeQueueEngine }) => {
        const presenceSummary = new GroupPresenceSummaryWork({
            runtimeRepository: input.runtimeStateRepository,
            outboxQueueReader,
            recomputeDebounceMs: input.groupFormationRecomputeDebounceMs,
            database: input.database,
            serviceId: input.serviceId,
            wakeQueue: wakeQueueEngine,
            now: input.nowEpochMs,
            formationMetrics: input.groupFormationMetrics.presenceSummary
        });
        outboxQueueReader.onOutboxMessageDo(AppOutboxType.GROUP_PRESENCE_SUMMARY, {
            onMessage: async (message, entry) => await presenceSummary.processReservedEntry(message, entry)
        });

        return new GroupStateInboxService(
            {
                inboxQueueReader: inboxQueueReader,
                resourceInboxRepository: input.resourceInboxRepository.entries,
                resourceInboxResultsRepository: input.resourceInboxResultsRepository,
                database: input.database,
                groupStateService: input.groupStateService
            },
            {
                serviceId: input.serviceId,
                timing: input.timing,
                options: input.appInboxOptions,
                wakeOwningQueue: wakeQueueEngine,
                formationMetrics: input.groupFormationMetrics.groupMutation
            }
        );
    };
}

function createAppClientInboxServiceFactory(
    input: ApiV1StateMutationDependencies
): CreateRallarMiddlewareOptions['createAppClientInboxService'] {
    return ({ inboxQueueReader, wakeQueueEngine }) => {
        const clientStateService = createCachedClientStateService({
            durable: createClientStateService({
                runtimeRepository: input.runtimeStateRepository,
                clientStateEventStore: input.clientStateEventStore,
                serviceId: input.serviceId,
                timing: input.timing
            }),
            cache: input.clientSnapshotCache
        });

        return new AppClientInboxService(
            {
                inboxQueueReader: inboxQueueReader,
                resourceInboxRepository: input.resourceInboxRepository.entries,
                resourceInboxResultsRepository: input.resourceInboxResultsRepository,
                database: input.database,
                clientStateService: clientStateService
            },
            {
                serviceId: input.serviceId,
                timing: input.timing,
                options: input.appInboxOptions,
                wakeOwningQueue: wakeQueueEngine
            }
        );
    };
}

function createAppAuthInboxServiceFactory(
    input: CreateAppAuthInboxServiceFactoryInput
): NonNullable<CreateRallarMiddlewareOptions['createAppAuthInboxService']> {
    const credentialIssuer = createHmacAuthCredentialIssuer(input.authCredentialSecret);

    return ({ inboxQueueReader, wakeQueueEngine }) =>
        new AppAuthInboxService(
            {
                inboxQueueReader: inboxQueueReader,
                resourceInboxRepository: input.resourceInboxRepository.entries,
                resourceInboxResultsRepository: input.resourceInboxResultsRepository,
                database: input.database,
                authMutationService: createAuthMutationService({
                    runtimeRepository: input.runtimeStateRepository,
                    serviceId: input.serviceId
                }),
                credentialIssuer: credentialIssuer
            },
            {
                serviceId: input.serviceId,
                timing: input.timing,
                options: input.appInboxOptions,
                wakeOwningQueue: wakeQueueEngine,
                authFactNowEpochMs: input.appInboxOptions.nowEpochMs
            }
        );
}

function createAppInboxDequeueOptions(
    input: CreateApiV1MutationRuntimeInput
): DequeueResourceEntryOptions {
    const finalizeAppInboxRetry = createAppInboxRetryFinalizer({
        database: input.database,
        timing: input.timing
    });
    return {
        nowEpochMs: input.nowEpochMs,
        onRetryExhausted: finalizeAppInboxRetry,
        onRetryExhaustionRecovery: finalizeAppInboxRetry,
        onRetryExhaustionTelemetry: (exhaustion) => {
            recordRallarTiming({
                sink: input.timing,
                event: {
                    component: 'app-inbox-handler',
                    operation: 'retry-exhaustion',
                    requestId: exhaustion.entry.key.resourceId,
                    details: {
                        processingAttempts: exhaustion.processingAttempts,
                        reservationAttempt: exhaustion.reservationAttempt,
                        selectedLane: exhaustion.lane,
                        classification: exhaustion.classification,
                        exhaustion: exhaustion.exhausted,
                        source: exhaustion.failure.source,
                        queueAgeMs: exhaustion.queueAgeMs,
                        dueAgeMs: exhaustion.dueAgeMs
                    }
                },
                status: 'ok',
                durationMs: 0
            });
        }
    };
}
