import type { Hono } from 'jsr:@hono/hono@4.11.9';

import type { RallarCrdtAdminReadRepository } from '@shared/crdt/mod.ts';
import type {
  RallarServerRouteInstaller,
} from '@shared-server/rallar-facade/RallarServerApplication.ts';
import type {
  AuthUserRepository,
} from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type {
  LoginClientData,
} from '@shared-server/rallar-system/auth/login/authenticate-auth-user.ts';
import {
  readGroupGraphDiagnostic,
  readScopedGlobalGraphDiagnostic,
} from '@shared-graph/graph-diagnostics-service.ts';

import * as adminOperationsRoutes from '../routes/admin-operations-routes.ts';
import * as adminSupportRoutes from '../routes/admin-support-routes.ts';
import * as configRoutes from '../routes/config-route.ts';
import * as crdtAdminRoutes from '../crdt/register-crdt-admin-routes.ts';
import {
  type ApiV1StateSnapshotRouteRuntime,
  createStateSnapshotReadRouteRegistrars,
} from '../routes/create-state-snapshot-read-route-registrars.ts';
import * as graphTopologyRoutes from '../routes/graph-topology-routes.ts';
import * as iceRoutes from '../routes/ice-route.ts';
import * as spaStatisticsRoutes from '../routes/spa-statistics-routes.ts';
import * as swaggerRoutes from '../routes/swagger-routes.ts';
import * as wsRoutes from '../routes/ws-routes.ts';
import {
  createApiCrdtDocumentAccessAuthorizer,
} from '../crdt/create-api-crdt-document-authorizer.ts';
import { requireApiAuthSession, requireWsAuthSession } from '../services/request-auth-service.ts';
import type { CrdtAdminMutations } from '../crdt/create-crdt-admin-mutations.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';
import type { ApiV1TopologyServices } from './create-api-v1-topology-services.ts';

export interface ApiV1WsAuthRequestFacts {
  readonly requestId: string;
  readonly capturedAtEpochMs: number;
}

export interface ApiV1RouteAuthRequest {
  readonly header: (name: string) => string | undefined;
}

export interface ApiV1RouteWsAuthRequest {
  readonly sessionId: string;
  readonly ticket?: string;
}

export interface ApiV1RouteInstallerRuntime extends ApiV1StateSnapshotRouteRuntime {
  readonly wsQBoxServerService: Pick<ApiV1Runtime['wsQBoxServerService'], 'socket'>;
  readonly appAuthInboxService: configRoutes.ConfigRouteDependencies['appAuthInbox'];
  readonly appClientInboxService: Pick<
    ApiV1Runtime['appClientInboxService'],
    'enqueueAuthorisedWsClientConnect' | 'processAuthenticatedEntryUntilCompletion'
  >;
  readonly groupsRepository: Pick<ApiV1Runtime['groupsRepository'], 'readSnapshot'>;
  readonly clientsRepository: Pick<ApiV1Runtime['clientsRepository'], 'readSnapshot'>;
}

export interface ApiV1RouteInstallerTopology {
  readonly topologyManagement: graphTopologyRoutes.GraphTopologyRouteTopologyManagement;
  readonly adminClientIds: readonly string[];
  readonly groupStateRepository: Readonly<{
    readLifecyclePolicy: graphTopologyRoutes.GraphTopologyRouteDependencies['readLifecyclePolicy'];
  }>;
}

export interface ApiV1RouteInstallerAdminServices {
  readonly operations: adminOperationsRoutes.AdminOperationsServiceLike;
  readonly support: adminSupportRoutes.AdminSupportServiceLike;
  readonly statistics: spaStatisticsRoutes.SpaStatisticsRouteService;
}

export interface CreateApiV1RouteInstallersInput<
  Runtime extends ApiV1RouteInstallerRuntime = ApiV1Runtime,
  Topology extends ApiV1RouteInstallerTopology = ApiV1TopologyServices,
> {
  readonly runtime: Runtime;
  readonly topology: Topology;
  readonly admin: ApiV1RouteInstallerAdminServices;
  readonly crdtLogRepository: RallarCrdtAdminReadRepository;
  readonly crdtMutations: CrdtAdminMutations;
  readonly authUserRepository: AuthUserRepository;
  readonly staticClients: readonly LoginClientData[];
  readonly authRegistrationMode: 'public' | 'admin';
  readonly readEnv: (name: string) => string | undefined;
  readonly nowEpochMs: () => number;
  readonly createTokenId: () => string;
  readonly createWsAuthRequestFacts: () => ApiV1WsAuthRequestFacts;
}

export interface ApiV1RouteInstallers {
  readonly ws: RallarServerRouteInstaller<Hono>;
  readonly rest: readonly RallarServerRouteInstaller<Hono>[];
}

export interface ApiV1RouteInstallerOperations<Runtime extends ApiV1RouteInstallerRuntime> {
  readonly requireApiAuthSession: (
    request: ApiV1RouteAuthRequest,
    repository: Runtime['authSessionRepository'],
  ) => Promise<IssuedAuthSession>;
  readonly requireWsAuthSession: (
    input: ApiV1RouteWsAuthRequest,
    appAuthInbox: Runtime['appAuthInboxService'],
    facts: ApiV1WsAuthRequestFacts,
  ) => Promise<IssuedAuthSession>;
}

interface ApiV1RouteConstruction<
  Runtime extends ApiV1RouteInstallerRuntime,
  Topology extends ApiV1RouteInstallerTopology,
> {
  readonly input: CreateApiV1RouteInstallersInput<Runtime, Topology>;
  readonly operations: ApiV1RouteInstallerOperations<Runtime>;
  readonly requireSession: (request: ApiV1RouteAuthRequest) => Promise<IssuedAuthSession>;
  readonly snapshots: ReturnType<typeof createStateSnapshotReadRouteRegistrars>;
  readonly authorizeCrdtDocumentAccess: ReturnType<
    typeof createApiCrdtDocumentAccessAuthorizer
  >;
}

export function createApiV1RouteInstallers(
  input: CreateApiV1RouteInstallersInput,
): ApiV1RouteInstallers {
  return constructApiV1RouteInstallers<ApiV1Runtime, ApiV1TopologyServices>(
    input,
    PRODUCTION_OPERATIONS,
  );
}

export function constructApiV1RouteInstallers<
  Runtime extends ApiV1RouteInstallerRuntime,
  Topology extends ApiV1RouteInstallerTopology,
>(
  input: CreateApiV1RouteInstallersInput<Runtime, Topology>,
  operations: ApiV1RouteInstallerOperations<Runtime>,
): ApiV1RouteInstallers {
  const construction = createApiV1RouteConstruction(input, operations);
  return {
    ws: createApiV1WsRouteInstaller(construction),
    rest: [
      ...createApiV1StateRouteInstallers(construction),
      ...createApiV1AdministrationRouteInstallers(construction),
    ],
  };
}

function createApiV1RouteConstruction<
  Runtime extends ApiV1RouteInstallerRuntime,
  Topology extends ApiV1RouteInstallerTopology,
>(
  input: CreateApiV1RouteInstallersInput<Runtime, Topology>,
  operations: ApiV1RouteInstallerOperations<Runtime>,
): ApiV1RouteConstruction<Runtime, Topology> {
  const { runtime } = input;
  const requireSession = (request: ApiV1RouteAuthRequest) =>
    operations.requireApiAuthSession(request, runtime.authSessionRepository);
  const snapshots = createStateSnapshotReadRouteRegistrars(runtime, {
    requireApiAuthSession: operations.requireApiAuthSession,
  });
  const authorizeCrdtDocumentAccess = createApiCrdtDocumentAccessAuthorizer({
    readGroupSnapshot: (ref) => runtime.groupsRepository.readSnapshot(ref),
    readClientSnapshot: (ref) => runtime.clientsRepository.readSnapshot(ref),
    nowEpochMs: input.nowEpochMs,
  });
  return {
    input,
    operations,
    requireSession,
    snapshots,
    authorizeCrdtDocumentAccess,
  };
}

function createApiV1WsRouteInstaller<
  Runtime extends ApiV1RouteInstallerRuntime,
  Topology extends ApiV1RouteInstallerTopology,
>(
  construction: ApiV1RouteConstruction<Runtime, Topology>,
): RallarServerRouteInstaller<Hono> {
  const { input, operations } = construction;
  return (app) =>
    wsRoutes.registerWsRoutes(app, {
      socketServer: input.runtime.wsQBoxServerService.socket,
      appClientInboxService: input.runtime.appClientInboxService,
      requireWsAuthSession: (request) =>
        operations.requireWsAuthSession(
          request,
          input.runtime.appAuthInboxService,
          input.createWsAuthRequestFacts(),
        ),
    });
}

function createApiV1StateRouteInstallers<
  Runtime extends ApiV1RouteInstallerRuntime,
  Topology extends ApiV1RouteInstallerTopology,
>(
  construction: ApiV1RouteConstruction<Runtime, Topology>,
): readonly RallarServerRouteInstaller<Hono>[] {
  const { input, requireSession, snapshots } = construction;
  return [
    (app) =>
      configRoutes.registerConfigRoutes(app, {
        requireApiAuthSession: requireSession,
        readEnv: input.readEnv,
        now: input.nowEpochMs,
        createTokenId: input.createTokenId,
        appAuthInbox: input.runtime.appAuthInboxService,
        authUserRepository: input.authUserRepository,
        staticClients: input.staticClients,
        registrationMode: input.authRegistrationMode,
        adminClientIds: new Set(input.topology.adminClientIds),
      }),
    (app) => iceRoutes.registerIceRoutes(app, { requireApiAuthSession: requireSession }),
    snapshots.client,
    snapshots.group,
    (app) =>
      spaStatisticsRoutes.registerSpaStatisticsRoutes(app, {
        statistics: input.admin.statistics,
        requireApiAuthSession: requireSession,
      }),
    (app) =>
      graphTopologyRoutes.registerGraphTopologyRoutes(app, {
        groupStateService: snapshots.graphGroupStateService,
        graphDiagnostics: { readScopedGlobalGraphDiagnostic, readGroupGraphDiagnostic },
        topologyManagement: input.topology.topologyManagement,
        processTopologyAppInbox: (authority, enqueue) =>
          graphTopologyRoutes.processTopologyAppInbox(
            input.runtime.appGroupInboxService,
            authority,
            enqueue,
          ),
        requireApiAuthSession: requireSession,
        adminClientIds: input.topology.adminClientIds,
        readLifecyclePolicy: (ref) => input.topology.groupStateRepository.readLifecyclePolicy(ref),
        now: input.nowEpochMs,
      }),
  ];
}

function createApiV1AdministrationRouteInstallers<
  Runtime extends ApiV1RouteInstallerRuntime,
  Topology extends ApiV1RouteInstallerTopology,
>(
  construction: ApiV1RouteConstruction<Runtime, Topology>,
): readonly RallarServerRouteInstaller<Hono>[] {
  const { authorizeCrdtDocumentAccess, input, requireSession } = construction;
  return [
    (app) =>
      crdtAdminRoutes.registerCrdtAdminRoutes(app, {
        repository: input.crdtLogRepository,
        crdtAdminMutations: input.crdtMutations,
        adminClientIds: input.topology.adminClientIds,
        requireApiAdminSession: async (context) => await requireSession(context.req),
        requireApiUserSession: async (context) => await requireSession(context.req),
        authorizeCatchUp: ({ document, session }) =>
          authorizeCrdtDocumentAccess({
            document,
            actorPrincipalId: session.username,
            sessionId: session.sessionId,
          }),
      }),
    (app) =>
      adminOperationsRoutes.init(app, {
        adminClientIds: input.topology.adminClientIds,
        operations: input.admin.operations,
        now: input.nowEpochMs,
        requireApiAuthSession: requireSession,
      }),
    (app) =>
      adminSupportRoutes.init(app, {
        adminClientIds: input.topology.adminClientIds,
        support: input.admin.support,
        requireApiAuthSession: requireSession,
      }),
    swaggerRoutes.init,
  ];
}

const PRODUCTION_OPERATIONS: ApiV1RouteInstallerOperations<ApiV1Runtime> = {
  requireApiAuthSession,
  requireWsAuthSession,
};
