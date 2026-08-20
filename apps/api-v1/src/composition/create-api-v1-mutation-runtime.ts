import type { RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';
import type {
  DequeueResourceEntryOptions,
  ResilienceDto,
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
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
  createAuthSessionRepository,
  createClientStateEventRepository,
  createClientStateRepository,
  createGroupStateEventRepository,
  createGroupStateRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import {
  createAuthMutationService,
} from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import {
  createHmacAuthCredentialIssuer,
} from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import {
  AppAuthInboxService,
} from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import {
  AppClientInboxService,
} from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import {
  createClientStateService,
} from '@shared-server/rallar-system/client-state/client-state-service.ts';
import {
  createCachedClientStateService,
} from '@shared-server/rallar-system/client-state/snapshot/cached-client-state-service.ts';
import {
  ClientStateSnapshotReadThroughCache,
} from '@shared-server/rallar-system/client-state/snapshot/\
client-state-snapshot-read-through-cache.ts';
import {
  createGroupStateService,
} from '@shared-server/rallar-system/group-state/group-state-service.ts';
import type {
  GroupPresenceSummaryTopologyIntent,
  GroupStateDisseminationMode,
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts';
import {
  GroupPresenceSummaryWork,
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts';
import {
  createCachedGroupStateService,
} from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import {
  GroupStateSnapshotReadThroughCache,
} from '@shared-server/rallar-system/group-state/snapshot/\
group-state-snapshot-read-through-cache.ts';
import type {
  CreateRallarMiddlewareOptions,
} from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import {
  AppGroupInboxService,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
  type AppInboxServiceOptions,
  createAppInboxRetryExhaustionHandler,
  createAppInboxRetryExhaustionRecoveryHandler,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { AppOutboxType } from '@shared-server/rallar-system/services/AppOutboxService.ts';
import {
  createGroupFormationMetricsRecorder,
  type RallarGroupFormationMetricsRecorder,
} from '@shared-server/rallar-system/formation-metrics.ts';
import {
  type RallarTimingSink,
  recordRallarTiming,
} from '@shared-server/rallar-system/services/timing.ts';

import type { ApiGroupCapacityConfig } from '../runtime/group-formation/group-capacity-config.ts';
import type {
  GroupFormationDampingMode,
} from '../runtime/group-formation/group-formation-damping-config.ts';
import { createApiCrdtDocumentAuthorizer } from '../crdt/create-api-crdt-document-authorizer.ts';
import {
  createApiCrdtInboxFactory,
  resolveApiCrdtPolicies,
} from '../crdt/create-api-crdt-inbox-factory.ts';
import {
  type ApiMutationInboxFactories,
  createApiMutationInboxFactories,
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
  readonly appInboxOptions: AppInboxServiceOptions;
  readonly clientFormationDamping: GroupFormationDampingMode;
  readonly groupCapacity: ApiGroupCapacityConfig;
  readonly groupStateDissemination: GroupStateDisseminationMode;
  readonly createGroupFormationTopologyIntent: (
    outboxQueueReader: OutboxQueueReader,
  ) => GroupPresenceSummaryTopologyIntent;
  readonly adminClientIds: readonly string[];
  readonly crdtPolicies: readonly RallarCrdtDocumentTypePolicy[] | undefined;
  readonly resilience: ApiV1MutationRuntimeResilience;
}

export interface ApiV1MutationRuntime {
  readonly queueBox: PSqlQueueBox;
  readonly resourceInboxRepository: ResourceInboxRepository;
  readonly webSocketServer: JsonWebSocketServer;
  readonly runtimeStateRepository: PSqlRuntimeStateRepository;
  readonly authSessionRepository: ReturnType<typeof createAuthSessionRepository>;
  readonly clientsRepository: ReturnType<typeof createClientStateRepository>;
  readonly groupsRepository: ReturnType<typeof createGroupStateRepository>;
  readonly clientSnapshotCache: ClientStateSnapshotReadThroughCache;
  readonly groupSnapshotCache: GroupStateSnapshotReadThroughCache;
  readonly groupFormationMetrics: RallarGroupFormationMetricsRecorder;
  readonly appInboxDequeueOptions: DequeueResourceEntryOptions;
  readonly createAppGroupInboxService: CreateRallarMiddlewareOptions['createAppGroupInboxService'];
  readonly createAppClientInboxService:
    CreateRallarMiddlewareOptions['createAppClientInboxService'];
  readonly createAppAuthInboxService: NonNullable<
    CreateRallarMiddlewareOptions['createAppAuthInboxService']
  >;
  readonly createAppAdminInboxService: NonNullable<
    CreateRallarMiddlewareOptions['createAppAdminInboxService']
  >;
  readonly createAppCrdtInboxService: NonNullable<
    CreateRallarMiddlewareOptions['createAppCrdtInboxService']
  >;
  readonly resilience: CreateRallarMiddlewareOptions['resilience'];
}

interface ApiV1StateMutationDependencies {
  readonly database: PSqlSql;
  readonly serviceId: string;
  readonly nowEpochMs: () => number;
  readonly timing: RallarTimingSink;
  readonly appInboxOptions: AppInboxServiceOptions;
  readonly resourceInboxRepository: ResourceInboxRepository;
  readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
  readonly runtimeStateRepository: PSqlRuntimeStateRepository;
  readonly authSessionRepository: ReturnType<typeof createAuthSessionRepository>;
  readonly clientSnapshotCache: ClientStateSnapshotReadThroughCache;
  readonly groupSnapshotCache: GroupStateSnapshotReadThroughCache;
  readonly groupFormationMetrics: RallarGroupFormationMetricsRecorder;
}

interface ApiV1MutationResources {
  readonly queueBox: PSqlQueueBox;
  readonly resourceInboxRepository: ResourceInboxRepository;
  readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
  readonly runtimeStateRepository: PSqlRuntimeStateRepository;
  readonly authSessionRepository: ReturnType<typeof createAuthSessionRepository>;
  readonly clientsRepository: ReturnType<typeof createClientStateRepository>;
  readonly groupsRepository: ReturnType<typeof createGroupStateRepository>;
  readonly clientSnapshotCache: ClientStateSnapshotReadThroughCache;
  readonly groupSnapshotCache: GroupStateSnapshotReadThroughCache;
  readonly groupFormationMetrics: RallarGroupFormationMetricsRecorder;
}

interface CreateAppGroupInboxServiceFactoryInput extends ApiV1StateMutationDependencies {
  readonly groupCapacity: ApiGroupCapacityConfig;
  readonly groupStateDissemination: GroupStateDisseminationMode;
  readonly createGroupFormationTopologyIntent: (
    outboxQueueReader: OutboxQueueReader,
  ) => GroupPresenceSummaryTopologyIntent;
}

interface CreateAppClientInboxServiceFactoryInput extends ApiV1StateMutationDependencies {
  readonly clientFormationDamping: GroupFormationDampingMode;
}

interface CreateAppAuthInboxServiceFactoryInput extends ApiV1StateMutationDependencies {
  readonly authCredentialSecret: string;
}

export function createApiV1MutationRuntime(
  input: CreateApiV1MutationRuntimeInput,
): ApiV1MutationRuntime {
  const resources = createApiV1MutationResources(input.database);
  const stateDependencies = createApiV1StateMutationDependencies(input, resources);
  const mutationFactories = createApiV1MutationInboxFactories(input, resources);

  return {
    queueBox: resources.queueBox,
    resourceInboxRepository: resources.resourceInboxRepository,
    webSocketServer: new JsonWebSocketServer(),
    runtimeStateRepository: resources.runtimeStateRepository,
    authSessionRepository: resources.authSessionRepository,
    clientsRepository: resources.clientsRepository,
    groupsRepository: resources.groupsRepository,
    clientSnapshotCache: resources.clientSnapshotCache,
    groupSnapshotCache: resources.groupSnapshotCache,
    groupFormationMetrics: resources.groupFormationMetrics,
    appInboxDequeueOptions: createAppInboxDequeueOptions(input),
    createAppGroupInboxService: createAppGroupInboxServiceFactory({
      ...stateDependencies,
      groupCapacity: input.groupCapacity,
      groupStateDissemination: input.groupStateDissemination,
      createGroupFormationTopologyIntent: input.createGroupFormationTopologyIntent,
    }),
    createAppClientInboxService: createAppClientInboxServiceFactory({
      ...stateDependencies,
      clientFormationDamping: input.clientFormationDamping,
    }),
    createAppAuthInboxService: createAppAuthInboxServiceFactory({
      ...stateDependencies,
      authCredentialSecret: input.authCredentialSecret,
    }),
    ...mutationFactories,
    resilience: input.resilience,
  };
}

function createApiV1MutationResources(
  database: PSqlSql,
): ApiV1MutationResources {
  const resourceInboxRepository = new ResourceInboxRepository(database);
  const resourceInboxResultsRepository = new ResourceInboxResultsRepository(database);
  const runtimeStateRepository = new PSqlRuntimeStateRepository(database);
  const authSessionRepository = createAuthSessionRepository(runtimeStateRepository);
  const clientsRepository = createClientStateRepository(database);
  const groupsRepository = createGroupStateRepository(database);
  return {
    queueBox: new PSqlQueueBox(resourceInboxRepository),
    resourceInboxRepository,
    resourceInboxResultsRepository,
    runtimeStateRepository,
    authSessionRepository,
    clientsRepository,
    groupsRepository,
    clientSnapshotCache: new ClientStateSnapshotReadThroughCache({ clientsRepository }),
    groupSnapshotCache: new GroupStateSnapshotReadThroughCache({ groupsRepository }),
    groupFormationMetrics: createGroupFormationMetricsRecorder(),
  };
}

function createApiV1StateMutationDependencies(
  input: CreateApiV1MutationRuntimeInput,
  resources: ApiV1MutationResources,
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
    clientSnapshotCache: resources.clientSnapshotCache,
    groupSnapshotCache: resources.groupSnapshotCache,
    groupFormationMetrics: resources.groupFormationMetrics,
  };
}

function createApiV1MutationInboxFactories(
  input: CreateApiV1MutationRuntimeInput,
  resources: ApiV1MutationResources,
): ApiMutationInboxFactories {
  const readSession = (sessionId: string) =>
    resources.authSessionRepository.findBySessionId(sessionId);
  const currentAuthority = {
    readSession,
    authorizeDocument: createApiCrdtDocumentAuthorizer({
      readGroupSnapshot: (ref) => resources.groupsRepository.readSnapshot(ref),
      readClientSnapshot: (ref) => resources.clientsRepository.readSnapshot(ref),
      nowEpochMs: input.nowEpochMs,
    }),
    adminClientIds: input.adminClientIds,
  };
  const createAppCrdtInboxService = createApiCrdtInboxFactory({
    resourceInboxRepository: resources.resourceInboxRepository,
    resourceInboxResultsRepository: resources.resourceInboxResultsRepository,
    database: input.database,
    serviceId: input.serviceId,
    timing: input.timing,
    options: input.appInboxOptions,
    currentAuthority,
    policies: resolveApiCrdtPolicies(input.crdtPolicies),
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
      adminClientIds: input.adminClientIds,
    },
  });
}

function createAppGroupInboxServiceFactory(
  input: CreateAppGroupInboxServiceFactoryInput,
): CreateRallarMiddlewareOptions['createAppGroupInboxService'] {
  return ({ inboxQueueReader, outboxQueueReader, wakeQueueEngine }) => {
    const topologyIntent = input.createGroupFormationTopologyIntent(outboxQueueReader);
    const groupStateService = createCachedGroupStateService({
      durable: createGroupStateService({
        runtimeRepository: input.runtimeStateRepository,
        formationDamping: topologyIntent.damping,
        capacity: input.groupCapacity,
        authSessionRepository: input.authSessionRepository,
        createGroupStateEventStore: createGroupStateEventRepository,
        serviceId: input.serviceId,
        timing: input.timing,
      }),
      cache: input.groupSnapshotCache,
    });
    const presenceSummary = new GroupPresenceSummaryWork({
      runtimeRepository: input.runtimeStateRepository,
      topologyIntent,
      disseminationMode: input.groupStateDissemination,
      database: input.database,
      serviceId: input.serviceId,
      wakeQueue: wakeQueueEngine,
      now: input.nowEpochMs,
      timing: input.timing,
      formationMetrics: input.groupFormationMetrics.presenceSummary,
    });
    outboxQueueReader.onOutboxMessageDo(AppOutboxType.GROUP_PRESENCE_SUMMARY, {
      onMessage: async (message, entry) =>
        await presenceSummary.processReservedEntry(message, entry),
    });

    return new AppGroupInboxService(
      {
        inboxQueueReader: inboxQueueReader,
        resourceInboxRepository: input.resourceInboxRepository,
        resourceInboxResultsRepository: input.resourceInboxResultsRepository,
        database: input.database,
        groupStateService: groupStateService,
      },
      {
        serviceId: input.serviceId,
        timing: input.timing,
        options: input.appInboxOptions,
        wakeOwningQueue: wakeQueueEngine,
        formationMetrics: input.groupFormationMetrics.groupMutation,
      },
    );
  };
}

function createAppClientInboxServiceFactory(
  input: CreateAppClientInboxServiceFactoryInput,
): CreateRallarMiddlewareOptions['createAppClientInboxService'] {
  return ({ inboxQueueReader, wakeQueueEngine }) => {
    const clientStateService = createCachedClientStateService({
      durable: createClientStateService({
        runtimeRepository: input.runtimeStateRepository,
        formationDamping: input.clientFormationDamping,
        createClientStateEventStore: createClientStateEventRepository,
        serviceId: input.serviceId,
        timing: input.timing,
      }),
      cache: input.clientSnapshotCache,
    });

    return new AppClientInboxService(
      {
        inboxQueueReader: inboxQueueReader,
        resourceInboxRepository: input.resourceInboxRepository,
        resourceInboxResultsRepository: input.resourceInboxResultsRepository,
        database: input.database,
        clientStateService: clientStateService,
      },
      {
        serviceId: input.serviceId,
        timing: input.timing,
        options: input.appInboxOptions,
        wakeOwningQueue: wakeQueueEngine,
      },
    );
  };
}

function createAppAuthInboxServiceFactory(
  input: CreateAppAuthInboxServiceFactoryInput,
): NonNullable<CreateRallarMiddlewareOptions['createAppAuthInboxService']> {
  const credentialIssuer = createHmacAuthCredentialIssuer(input.authCredentialSecret);

  return ({ inboxQueueReader, wakeQueueEngine }) =>
    new AppAuthInboxService(
      {
        inboxQueueReader: inboxQueueReader,
        resourceInboxRepository: input.resourceInboxRepository,
        resourceInboxResultsRepository: input.resourceInboxResultsRepository,
        database: input.database,
        authMutationService: createAuthMutationService({
          runtimeRepository: input.runtimeStateRepository,
          serviceId: input.serviceId,
        }),
        credentialIssuer: credentialIssuer,
      },
      {
        serviceId: input.serviceId,
        timing: input.timing,
        options: input.appInboxOptions,
        wakeOwningQueue: wakeQueueEngine,
        authFactNowEpochMs: input.appInboxOptions.nowEpochMs,
      },
    );
}

function createAppInboxDequeueOptions(
  input: CreateApiV1MutationRuntimeInput,
): DequeueResourceEntryOptions {
  return {
    nowEpochMs: input.nowEpochMs,
    onRetryExhausted: createAppInboxRetryExhaustionHandler({
      database: input.database,
      timing: input.timing,
    }),
    onRetryExhaustionRecovery: createAppInboxRetryExhaustionRecoveryHandler({
      database: input.database,
      timing: input.timing,
    }),
    onRetryExhaustionTelemetry: (exhaustion) => {
      recordRallarTiming(
        input.timing,
        {
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
            dueAgeMs: exhaustion.dueAgeMs,
          },
        },
        'ok',
        0,
      );
    },
  };
}
