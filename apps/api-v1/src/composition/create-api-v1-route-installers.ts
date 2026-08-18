import type { Hono } from 'jsr:@hono/hono@4.11.9';
import type { RallarCrdtAdminReadRepository } from '@shared/crdt/mod.ts';
import type {
  RallarServerRouteInstaller,
} from '@shared-server/rallar-facade/RallarServerApplication.ts';
import type {
  AuthUserRepository,
} from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
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
import * as crdtAdminRoutes from '../routes/crdt-admin-routes.ts';
import {
  createStateSnapshotReadRouteRegistrars,
} from '../routes/create-state-snapshot-read-route-registrars.ts';
import * as graphTopologyRoutes from '../routes/graph-topology-routes.ts';
import * as iceRoutes from '../routes/ice-route.ts';
import * as spaStatisticsRoutes from '../routes/spa-statistics-routes.ts';
import * as swaggerRoutes from '../routes/swagger-routes.ts';
import * as wsRoutes from '../routes/ws-routes.ts';
import { authorizeCrdtDocumentAccess } from '../services/create-api-crdt-document-authorizer.ts';
import { requireApiAuthSession, requireWsAuthSession } from '../services/request-auth-service.ts';
import type { CrdtAdminMutations } from '../crdt/create-crdt-admin-mutations.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';
import type { ApiV1AdminServices } from './create-api-v1-admin-services.ts';
import type { ApiV1TopologyServices } from './create-api-v1-topology-services.ts';

export interface ApiV1WsAuthRequestFacts {
  readonly requestId: string;
  readonly capturedAtEpochMs: number;
}

interface ApiV1RouteAuthRequest {
  readonly header: (name: string) => string | undefined;
}

export interface CreateApiV1RouteInstallersInput {
  readonly runtime: ApiV1Runtime;
  readonly topology: Pick<ApiV1TopologyServices, 'topologyManagement' | 'adminClientIds'>;
  readonly admin: ApiV1AdminServices;
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

export function createApiV1RouteInstallers(
  input: CreateApiV1RouteInstallersInput,
): ApiV1RouteInstallers {
  const runtime = input.runtime;
  const topology = input.topology;
  const requireSession = (request: ApiV1RouteAuthRequest) =>
    requireApiAuthSession(request, runtime.authSessionRepository);
  const snapshots = createStateSnapshotReadRouteRegistrars(runtime);
  return {
    ws: (app) =>
      wsRoutes.registerWsRoutes(app, {
        socketServer: runtime.wsQBoxServerService.socket,
        appClientInboxService: runtime.appClientInboxService,
        requireWsAuthSession: (request) =>
          requireWsAuthSession(
            request,
            runtime.appAuthInboxService,
            input.createWsAuthRequestFacts(),
          ),
      }),
    rest: [
      (app) =>
        configRoutes.registerConfigRoutes(app, {
          requireApiAuthSession: requireSession,
          readEnv: input.readEnv,
          now: input.nowEpochMs,
          createTokenId: input.createTokenId,
          appAuthInbox: runtime.appAuthInboxService,
          authUserRepository: input.authUserRepository,
          staticClients: input.staticClients,
          registrationMode: input.authRegistrationMode,
          adminClientIds: new Set(topology.adminClientIds),
        }),
      (app) =>
        iceRoutes.registerIceRoutes(app, {
          requireApiAuthSession: requireSession,
        }),
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
          graphDiagnostics: {
            readScopedGlobalGraphDiagnostic,
            readGroupGraphDiagnostic,
          },
          topologyManagement: topology.topologyManagement,
          processTopologyAppInbox: (authority, enqueue) =>
            graphTopologyRoutes.processTopologyAppInbox(
              runtime.appGroupInboxService,
              authority,
              enqueue,
            ),
          requireApiAuthSession: requireSession,
          adminClientIds: topology.adminClientIds,
          now: input.nowEpochMs,
        }),
      (app) =>
        crdtAdminRoutes.registerCrdtAdminRoutes(app, {
          repository: input.crdtLogRepository,
          mutations: input.crdtMutations,
          adminClientIds: topology.adminClientIds,
          requireApiAdminSession: async (context) => await requireSession(context.req),
          requireApiUserSession: async (context) => await requireSession(context.req),
          authorizeCatchUp: ({ document, session }) =>
            authorizeCrdtDocumentAccess(
              {
                readGroupSnapshot: (ref) => runtime.groupsRepository.readSnapshot(ref),
                readClientSnapshot: (ref) => runtime.clientsRepository.readSnapshot(ref),
                nowEpochMs: input.nowEpochMs,
              },
              {
                document,
                actorPrincipalId: session.username,
                sessionId: session.sessionId,
              },
            ),
        }),
      (app) =>
        adminOperationsRoutes.init(app, {
          adminClientIds: topology.adminClientIds,
          operations: input.admin.operations,
          now: input.nowEpochMs,
          requireApiAuthSession: requireSession,
        }),
      (app) =>
        adminSupportRoutes.init(app, {
          adminClientIds: topology.adminClientIds,
          support: input.admin.support,
          requireApiAuthSession: requireSession,
        }),
      swaggerRoutes.init,
    ],
  };
}
