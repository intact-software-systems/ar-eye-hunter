import { toResilienceDto } from './middleware-resilience.ts';
import { toPSqlSql } from './db/to-p-sql-sql.ts';
import { sql } from './db/db.ts';
import { readApiV1DatabaseBackendConfig } from './db/database-config.ts';
import { readApiV1DatabasePubSubConfig } from './db/database-pubsub-config.ts';
import {
  createApiV1BackgroundTaskLifecycle,
} from './composition/api-v1-background-task-lifecycle.ts';
import type { ApiV1Runtime } from './composition/api-v1-runtime.ts';
import { createApiV1Runtime } from './composition/create-api-v1-runtime.ts';
import { myPublisherId, myRtcTopologyStreamId, myServerId } from './runtime/runtime-identity.ts';
import { readApiGroupCapacityConfig } from './runtime/group-formation/group-capacity-config.ts';
import {
  readApiGroupFormationDampingConfig,
  readApiGroupFormationTopologyIntent,
} from './runtime/group-formation/group-formation-damping-config.ts';
import {
  readApiGroupStateDisseminationConfig,
} from './runtime/group-formation/group-state-dissemination-config.ts';
import {
  readApiRtcTopologyReplayConfig,
} from './runtime/rtc-topology/rtc-topology-replay-config.ts';
import {
  readConfiguredAdminClientIds,
  readConfiguredCrdtPolicies,
} from './services/create-api-mutation-inbox-factories.ts';
import { createRuntimeStateExpiryLifecycle } from './services/runtime-state-expiry-startup.ts';
import { getApiAppInboxServiceOptions, getApiTimingSink } from './services/timing-service.ts';

export function initialiseMiddleware(): ApiV1Runtime {
  const databaseConfig = readApiV1DatabaseBackendConfig();
  const authCredentialSecret = Deno.env.get('RALLAR_AUTH_CREDENTIAL_SECRET')?.trim();
  if (!authCredentialSecret) {
    throw new Error('RALLAR_AUTH_CREDENTIAL_SECRET is required');
  }

  return createApiV1Runtime({
    database: toPSqlSql(sql),
    serviceId: myServerId,
    publisherStreamId: myRtcTopologyStreamId,
    queuePubSubPublisherId: myPublisherId,
    queuePubSubChannel: 'ws-channel',
    wsRuntimeName: 'default-qbox-server',
    authCredentialSecret,
    nowEpochMs: () => Date.now(),
    timing: getApiTimingSink(),
    appInboxOptions: getApiAppInboxServiceOptions(),
    clientFormationDamping: readApiGroupFormationDampingConfig().damping,
    groupCapacity: readApiGroupCapacityConfig(),
    groupStateDissemination: readApiGroupStateDisseminationConfig().dissemination,
    createGroupFormationTopologyIntent: readApiGroupFormationTopologyIntent,
    databasePubSub: readApiV1DatabasePubSubConfig(Deno.env, databaseConfig),
    rtcTopologyReplayMode: readApiRtcTopologyReplayConfig(Deno.env, databaseConfig).replay,
    adminClientIds: readConfiguredAdminClientIds(),
    crdtPolicies: readConfiguredCrdtPolicies(),
    resilience: {
      inbox: toResilienceDto(),
      outbox: toResilienceDto(),
      appOutbox: toResilienceDto(),
    },
    backgroundTasks: createApiV1BackgroundTaskLifecycle({
      runtimeStateExpiry: createRuntimeStateExpiryLifecycle(),
    }),
  });
}
