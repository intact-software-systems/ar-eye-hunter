import type { Hono } from 'jsr:@hono/hono@4.11.9';

import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import type { RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';
import { PSqlAppDataRepository } from '@shared-server/postgres/app-data/PSqlAppDataRepository.ts';
// prettier-ignore
import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/\
psql-crdt-log-repository.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
  createAuthUserRepository,
  createRuntimeStateRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
// prettier-ignore
import type { RallarServerApplication } from '@shared-server/rallar-facade/\
RallarServerApplication.ts';
import type { RallarServerWsFacadeOptions } from '@shared-server/rallar-facade/ws-topic-router.ts';

import { getSql } from '../db/db.ts';
import { readApiV1DatabaseBackendConfig } from '../db/database-config.ts';
import { readApiV1DatabasePubSubConfig } from '../db/database-pubsub-config.ts';
import { toPSqlSql } from '../db/to-p-sql-sql.ts';
import { toResilienceDto } from '../middleware-resilience.ts';
import { readApiGroupCapacityConfig } from '../runtime/group-formation/group-capacity-config.ts';
import {
  readApiGroupFormationDampingConfig,
  readApiGroupFormationTopologyIntent,
} from '../runtime/group-formation/group-formation-damping-config.ts';
import {
  readApiGroupStateDisseminationConfig,
} from '../runtime/group-formation/group-state-dissemination-config.ts';
import {
  readApiRtcTopologyReplayConfig,
} from '../runtime/rtc-topology/rtc-topology-replay-config.ts';
import { myPublisherId, myRtcTopologyStreamId, myServerId } from '../runtime/runtime-identity.ts';
import { readAuthorisedClients } from '../services/api-login-service.ts';
import {
  readConfiguredAdminClientIds,
  readConfiguredCrdtPolicies,
} from '../services/create-api-mutation-inbox-factories.ts';
import { readAdminClientIds } from '../services/read-admin-client-ids.ts';
import {
  getApiRtcTopologyServiceOptions,
  readApiGlobalGraphRecomputeLimit,
  readApiRtcRttRefinementGateConfig,
} from '../services/rtc-topology-config.ts';
import { createRuntimeStateExpiryLifecycle } from '../services/runtime-state-expiry-startup.ts';
import { getApiAppInboxServiceOptions, getApiTimingSink } from '../services/timing-service.ts';
import { createApiV1RoomWsAuthorizer } from '../services/ws-topic-room-authorizer.ts';
import { createApiV1BackgroundTaskLifecycle } from './api-v1-background-task-lifecycle.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';
import {
  createApiV1AdminServices,
  readApiV1WebSocketStatus,
} from './create-api-v1-admin-services.ts';
import { createApiV1RouteInstallers } from './create-api-v1-route-installers.ts';
import { createApiV1Runtime } from './create-api-v1-runtime.ts';
import { createApiV1SystemInstallers } from './create-api-v1-system-installers.ts';
import { createApiV1TopologyServices } from './create-api-v1-topology-services.ts';
import { createRallarServer } from './create-rallar-server.ts';

export interface CreateDefaultRallarServerOptions {
  readonly ws?: RallarServerWsFacadeOptions;
}

export function createDefaultRallarServer(
  options: CreateDefaultRallarServerOptions = {},
): RallarServerApplication<ApiV1Runtime, Hono> {
  const crdtPolicies = readConfiguredCrdtPolicies();
  const databaseConfig = readApiV1DatabaseBackendConfig();
  const databasePubSub = readApiV1DatabasePubSubConfig(Deno.env, databaseConfig);
  const authCredentialSecret = requireAuthCredentialSecret();
  const database = toPSqlSql(getSql());
  const nowEpochMs = Date.now;
  const timing = getApiTimingSink();

  const backgroundTasks = createApiV1BackgroundTaskLifecycle({
    runtimeStateExpiry: createRuntimeStateExpiryLifecycle(),
  });
  const runtime = createDefaultApiV1Runtime({
    database,
    databasePubSub,
    databaseConfig,
    authCredentialSecret,
    crdtPolicies,
    backgroundTasks,
    nowEpochMs,
    timing,
  });

  const crdtLogRepository = new PSqlCrdtLogRepository(database, {
    policies: crdtPolicies,
  });
  const runtimeStateRepository = createRuntimeStateRepository(database);
  const authUserRepository = createAuthUserRepository(runtimeStateRepository);
  const rtcTopologyOptions = getApiRtcTopologyServiceOptions();
  const topology = createApiV1TopologyServices({
    runtimeStateRepository,
    groupStateService: runtime.groupStateService,
    groupInbox: runtime.appGroupInboxService,
    groupFormationRttMutation: runtime.groupFormationMetrics.rttMutation,
    webSocketServer: runtime.wsQBoxServerService.socket,
    topologyReplayMetrics: runtime.rtcTopologyReplay,
    serviceId: myServerId,
    adminClientIds: readAdminClientIds(),
    rtcTopologyOptions,
    rttRefinementGateConfig: readApiRtcRttRefinementGateConfig(),
    nowEpochMs,
    timing,
  });

  const appAdminInboxService = runtime.appAdminInboxService;
  const appCrdtInboxService = runtime.appCrdtInboxService;
  if (!appAdminInboxService || !appCrdtInboxService) {
    throw new Error('Admin database mutations require AppInbox services');
  }
  const admin = createApiV1AdminServices({
    database,
    databaseConfig,
    databasePubSub,
    nowEpochMs,
    serviceId: myServerId,
    timing,
    readWebSocketStatus: () => readApiV1WebSocketStatus(runtime.wsQBoxServerService.socket),
    readRtcTopologyMetrics: topology.readRtcTopologyMetrics,
    resetRtcTopologyMetrics: topology.resetRtcTopologyMetrics,
    readGroupFormationMetrics: runtime.groupFormationMetrics.readMetrics,
    resetGroupFormationMetrics: runtime.groupFormationMetrics.resetMetrics,
    crdtAdminRepository: crdtLogRepository,
    topologyManagement: topology.topologyManagement,
    clientStateService: runtime.clientStateService,
    groupStateService: runtime.groupStateService,
    appAdminInboxService,
    appCrdtInboxService,
    appGroupInboxService: runtime.appGroupInboxService,
  });

  const systemInstallers = createApiV1SystemInstallers({
    database,
    serviceId: myServerId,
    nowEpochMs,
    topology,
    crdtLogRepository,
    crdtPolicies,
    globalGraphRecomputeLimit: readApiGlobalGraphRecomputeLimit(),
  });
  const routeInstallers = createApiV1RouteInstallers({
    runtime,
    topology,
    admin,
    crdtLogRepository,
    crdtMutations: appCrdtInboxService,
    crdtAuditSink: undefined,
    authUserRepository,
    staticClients: readAuthorisedClients(Deno.env),
    authRegistrationMode: readAuthRegistrationMode(Deno.env),
    readEnv: (name) => Deno.env.get(name),
    nowEpochMs,
    createTokenId: () => crypto.randomUUID(),
    createWsAuthRequestFacts: () => ({
      requestId: crypto.randomUUID(),
      capturedAtEpochMs: Date.now(),
    }),
  });

  return createRallarServer({
    runtime,
    repositories: defaultRepositoryManager,
    appDataRepository: new PSqlAppDataRepository(database),
    ws: {
      authorizeRoomMessage: createApiV1RoomWsAuthorizer(runtime.groupStateService),
      ...options.ws,
    },
    systemInstallers,
    routeInstallers,
  });
}

interface CreateDefaultApiV1RuntimeInput {
  readonly database: PSqlSql;
  readonly databasePubSub: ReturnType<typeof readApiV1DatabasePubSubConfig>;
  readonly databaseConfig: ReturnType<typeof readApiV1DatabaseBackendConfig>;
  readonly authCredentialSecret: string;
  readonly crdtPolicies: readonly RallarCrdtDocumentTypePolicy[] | undefined;
  readonly backgroundTasks: ReturnType<typeof createApiV1BackgroundTaskLifecycle>;
  readonly nowEpochMs: () => number;
  readonly timing: ReturnType<typeof getApiTimingSink>;
}

function createDefaultApiV1Runtime(
  input: CreateDefaultApiV1RuntimeInput,
): ApiV1Runtime {
  return createApiV1Runtime({
    database: input.database,
    serviceId: myServerId,
    publisherStreamId: myRtcTopologyStreamId,
    queuePubSubPublisherId: myPublisherId,
    queuePubSubChannel: 'ws-channel',
    wsRuntimeName: 'default-qbox-server',
    authCredentialSecret: input.authCredentialSecret,
    nowEpochMs: input.nowEpochMs,
    timing: input.timing,
    appInboxOptions: getApiAppInboxServiceOptions(),
    clientFormationDamping: readApiGroupFormationDampingConfig().damping,
    groupCapacity: readApiGroupCapacityConfig(),
    groupStateDissemination: readApiGroupStateDisseminationConfig().dissemination,
    createGroupFormationTopologyIntent: readApiGroupFormationTopologyIntent,
    databasePubSub: input.databasePubSub,
    rtcTopologyReplayMode: readApiRtcTopologyReplayConfig(
      Deno.env,
      input.databaseConfig,
    ).replay,
    adminClientIds: readConfiguredAdminClientIds(),
    crdtPolicies: input.crdtPolicies,
    resilience: {
      inbox: toResilienceDto(),
      outbox: toResilienceDto(),
      appOutbox: toResilienceDto(),
    },
    backgroundTasks: input.backgroundTasks,
  });
}

function requireAuthCredentialSecret(): string {
  const secret = Deno.env.get('RALLAR_AUTH_CREDENTIAL_SECRET')?.trim();
  if (!secret) {
    throw new Error('RALLAR_AUTH_CREDENTIAL_SECRET is required');
  }
  return secret;
}

function readAuthRegistrationMode(
  env: Pick<Deno.Env, 'get'>,
): 'public' | 'admin' {
  return env.get('AUTH_REGISTRATION_MODE')?.trim().toLowerCase() === 'admin' ? 'admin' : 'public';
}
