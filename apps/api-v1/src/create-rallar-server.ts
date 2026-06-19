import type { Hono } from 'jsr:@hono/hono@4.11.9';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import type { AppDataRepositoryLike } from '@shared-server/app-data/AppDataRepository.ts';
import { installRallarCrdtWsTopics } from '@shared-server/crdt/RallarCrdtServer.ts';
import { PSqlAppDataRepository } from '@shared-server/postgres/app-data/PSqlAppDataRepository.ts';
import { PSqlCrdtLogRepository } from '@shared-server/postgres/crdt/PSqlCrdtLogRepository.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { RallarCrdtAdminLogRepository, RallarCrdtAuditSink } from '@shared/crdt/mod.ts';
import {
  createRallarServerApplication,
  type RallarServerApplication,
} from '@shared-server/rallar-facade/RallarServerApplication.ts';
import {
  RallarServerDataFacade,
  RallarServerSystemFacade,
} from '@shared-server/rallar-facade/RallarServer.ts';
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/ws-system-topics.ts';
import type { RallarServerWsFacadeOptions } from '@shared-server/rallar-facade/ws-topic-router.ts';
import type { Middleware } from './middleware.ts';
import { getMiddleware, initialiseMiddleware } from './middleware.ts';
import { createApiV1RoomWsAuthorizer } from './services/ws-topic-room-authorizer.ts';
import * as configRoutes from './routes/config-route.ts';
import * as wsRoutes from './routes/ws-routes.ts';
import * as iceRoutes from './routes/ice-route.ts';
import * as clientStateRoutes from './routes/client-state-routes.ts';
import * as groupStateRoutes from './routes/group-state-routes.ts';
import * as graphRoutes from './routes/graph-routes.ts';
import * as crdtAdminRoutes from './routes/crdt-admin-routes.ts';
import * as swaggerRoutes from './routes/swagger-routes.ts';
import { initWsLifecycle as initSharedWsLifecycle } from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';
import { sql } from './db/db.ts';
import { myServerId } from './runtime/runtime-identity.ts';

export { RallarServerDataFacade, RallarServerSystemFacade };

export type CreateRallarServerOptions = Readonly<{
  middleware?: Middleware;
  repositories?: RepositoryManager;
  appDataRepository?: AppDataRepositoryLike;
  crdtLogRepository?: RallarCrdtAdminLogRepository;
  crdtAuditSink?: RallarCrdtAuditSink;
  ws?: RallarServerWsFacadeOptions;
}>;

export function createRallarServer(
  options: CreateRallarServerOptions = {},
): RallarServerApplication<Middleware, Hono> {
  const middleware = options.middleware ?? initialiseMiddleware();
  const crdtLogRepository = options.crdtLogRepository ??
    new PSqlCrdtLogRepository(sql as unknown as PSqlSql, {
      serverId: myServerId,
      audit: options.crdtAuditSink,
    });

  return createRallarServerApplication({
    runtime: middleware,
    repositories: options.repositories ?? defaultRepositoryManager,
    ws: {
      authorizeRoomMessage: createApiV1RoomWsAuthorizer(
        middleware.groupsRepository,
      ),
      ...options.ws,
    },
    appData: {
      repository: options.appDataRepository ??
        new PSqlAppDataRepository(sql as unknown as PSqlSql),
    },
    system: {
      installDefaultMiddlewareTopics: (runtime, ws) => {
        initRallarSystemWsTopics(runtime.wsQBoxServerService, {
          initDynamicTopics: false,
        });
        installRallarCrdtWsTopics(ws, {
          logRepository: crdtLogRepository,
        });
      },
      installWebSocketLifecycle: (runtime) => {
        initSharedWsLifecycle(runtime.wsQBoxServerService, {
          disconnectClientSession: async (sessionId) => {
            const result = await getMiddleware().appClientInboxService
              .processAuthorisedWsClientDisconnect(
                sessionId,
              );
            result.fold(
              (error) => {
                throw new Error(error);
              },
              () => undefined,
            );
          },
          disconnectGroupSessionsBySessionId: async (
            sessionId,
            request,
          ) => {
            const result = await getMiddleware().appGroupInboxService
              .processPresenceDisconnectsBySessionId(
                sessionId,
                request,
              );
            result.fold(
              (error) => {
                throw new Error(error);
              },
              () => undefined,
            );
          },
        });
      },
    },
    routes: {
      ws: wsRoutes.init,
      rest: [
        configRoutes.init,
        iceRoutes.init,
        clientStateRoutes.init,
        groupStateRoutes.init,
        graphRoutes.init,
        (app) =>
          crdtAdminRoutes.init(app, {
            repository: crdtLogRepository,
            audit: options.crdtAuditSink,
            adminClientIds: readAdminClientIds(),
          }),
        swaggerRoutes.init,
      ],
    },
  });
}

function readAdminClientIds(): readonly string[] {
  return (Deno.env.get('AUTH_ADMIN_CLIENT_IDS') ?? 'admin')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
