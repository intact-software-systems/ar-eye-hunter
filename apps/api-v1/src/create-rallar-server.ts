import type { Hono } from 'jsr:@hono/hono';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import {
    createRallarServerApplication,
    type RallarServerApplication,
} from '@shared-server/rallar-facade/RallarServerApplication.ts';
import { RallarServerDataFacade, RallarServerSystemFacade, } from '@shared-server/rallar-facade/RallarServer.ts';
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/ws-system-topics.ts';
import type { RallarServerWsFacadeOptions } from '@shared-server/rallar-facade/ws-topic-router.ts';
import type { Middleware } from './middleware.ts';
import { initialiseMiddleware } from './middleware.ts';
import { authorizeApiV1RoomWsMessage } from './services/ws-topic-room-authorizer.ts';
import * as configRoutes from './routes/config-route.ts';
import * as wsRoutes from './routes/ws-routes.ts';
import * as iceRoutes from './routes/ice-route.ts';
import * as clientStateRoutes from './routes/client-state-routes.ts';
import * as groupStateRoutes from './routes/group-state-routes.ts';
import * as graphRoutes from './routes/graph-routes.ts';
import * as swaggerRoutes from './routes/swagger-routes.ts';
import {
    initWsLifecycle as initSharedWsLifecycle
} from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';
import { getClientStateService } from './services/client-state-service.ts';
import { getGroupStateService } from './services/group-state-service.ts';

export { RallarServerDataFacade, RallarServerSystemFacade };

export type CreateRallarServerOptions = Readonly<{
    middleware?: Middleware;
    repositories?: RepositoryManager;
    ws?: RallarServerWsFacadeOptions;
}>;

export function createRallarServer(options: CreateRallarServerOptions = {}): RallarServerApplication<Middleware, Hono> {
    const middleware = options.middleware ?? initialiseMiddleware();

    return createRallarServerApplication({
        runtime: middleware,
        repositories: options.repositories ?? defaultRepositoryManager,
        ws: {
            authorizeRoomMessage: authorizeApiV1RoomWsMessage,
            ...options.ws,
        },
        system: {
            installDefaultMiddlewareTopics: (runtime) => {
                initRallarSystemWsTopics(runtime.wsQBoxServerService, {
                    initDynamicTopics: false,
                });
            },
            installWebSocketLifecycle: (runtime) => {
                initSharedWsLifecycle(runtime.wsQBoxServerService, {
                    disconnectClientSession: async (sessionId) =>
                        await getClientStateService().disconnectAuthorisedWsClientSession(sessionId),
                    disconnectGroupSessionsBySessionId: async (sessionId, request) =>
                        await getGroupStateService().disconnectPresenceSessionsBySessionId(sessionId, request),
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
