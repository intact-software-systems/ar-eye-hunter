import type { Hono } from 'jsr:@hono/hono';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import type { AppDataRepositoryLike } from '@shared-server/app-data/AppDataRepository.ts';
import { PSqlAppDataRepository } from '@shared-server/postgres/app-data/PSqlAppDataRepository.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
    createRallarServerApplication,
    type RallarServerApplication,
} from '@shared-server/rallar-facade/RallarServerApplication.ts';
import { RallarServerDataFacade, RallarServerSystemFacade, } from '@shared-server/rallar-facade/RallarServer.ts';
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
import * as swaggerRoutes from './routes/swagger-routes.ts';
import {
    initWsLifecycle as initSharedWsLifecycle,
} from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';
import { sql } from './db/db.ts';

export { RallarServerDataFacade, RallarServerSystemFacade };

export type CreateRallarServerOptions = Readonly<{
    middleware?: Middleware;
    repositories?: RepositoryManager;
    appDataRepository?: AppDataRepositoryLike;
    ws?: RallarServerWsFacadeOptions;
}>;

export function createRallarServer(
    options: CreateRallarServerOptions = {},
): RallarServerApplication<Middleware, Hono> {
    const middleware = options.middleware ?? initialiseMiddleware();

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
            installDefaultMiddlewareTopics: (runtime) => {
                initRallarSystemWsTopics(runtime.wsQBoxServerService, {
                    initDynamicTopics: false,
                });
            },
            installWebSocketLifecycle: (runtime) => {
                initSharedWsLifecycle(runtime.wsQBoxServerService, {
                    disconnectClientSession: async (sessionId) => {
                        const result = await getMiddleware()
                            .appClientInboxService
                            .processAuthorisedWsClientDisconnect(sessionId);
                        result.fold(
                            (error) => {
                                throw new Error(error);
                            },
                            () => undefined,
                        );
                    },
                    disconnectGroupSessionsBySessionId: async (sessionId, request) => {
                        const result = await getMiddleware()
                            .appGroupInboxService
                            .processPresenceDisconnectsBySessionId(sessionId, request);
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
                swaggerRoutes.init,
            ],
        },
    });
}
