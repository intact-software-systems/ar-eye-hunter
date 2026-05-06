import type { Hono } from 'jsr:@hono/hono';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import {
    createRallarServerFacade,
    type RallarServer as SharedRallarServer,
    RallarServerDataFacade,
    RallarServerSystemFacade,
    type RallarServerWebSocketFacade as SharedRallarServerWebSocketFacade,
} from '@shared-server/rallar-facade/RallarServer.ts';
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/ws-system-topics.ts';
import type {
    RallarServerWsFacadeOptions,
    RallarServerWsFanout,
    RallarServerWsHandler,
    RallarServerWsProxyRule,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition,
} from '@shared-server/rallar-facade/ws-topic-router.ts';
import type { Middleware } from './middleware.ts';
import { initialiseMiddleware } from './middleware.ts';
import * as wsLifecycle from './services/ws-lifecycle-service.ts';
import { authorizeApiV1RoomWsMessage } from './services/ws-topic-room-authorizer.ts';
import * as configRoutes from './routes/config-route.ts';
import * as wsRoutes from './routes/ws-routes.ts';
import * as iceRoutes from './routes/ice-route.ts';
import * as clientStateRoutes from './routes/client-state-routes.ts';
import * as groupStateRoutes from './routes/group-state-routes.ts';
import * as graphRoutes from './routes/graph-routes.ts';
import * as swaggerRoutes from './routes/swagger-routes.ts';

export { RallarServerDataFacade, RallarServerSystemFacade };

export type CreateRallarServerOptions = Readonly<{
    middleware?: Middleware;
    repositories?: RepositoryManager;
    ws?: RallarServerWsFacadeOptions;
}>;

export class RallarServer {
    readonly ws: RallarServerWebSocketFacade;
    readonly rest = new RallarServerRestFacade();
    readonly system: RallarServerSystemFacade<Middleware>;
    readonly data: RallarServerDataFacade;

    constructor(readonly core: SharedRallarServer<Middleware>) {
        this.ws = new RallarServerWebSocketFacade(core.ws);
        this.system = core.system;
        this.data = core.data;
    }

    get middleware(): Middleware {
        return this.core.runtime;
    }

    start(): void {
        this.core.start();
    }
}

export function createRallarServer(options: CreateRallarServerOptions = {}): RallarServer {
    const middleware = options.middleware ?? initialiseMiddleware();
    const core = createRallarServerFacade({
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
                wsLifecycle.initWsLifecycle(runtime.wsQBoxServerService);
            },
        },
    });

    return new RallarServer(core);
}

export class RallarServerWebSocketFacade {
    private mounted = false;

    constructor(private readonly core: SharedRallarServerWebSocketFacade) {}

    mount(app: Hono): this {
        if (this.mounted) {
            return this;
        }

        this.core.install();
        wsRoutes.init(app);
        this.mounted = true;
        return this;
    }

    install(): this {
        this.core.install();
        return this;
    }

    defineTopic<T>(definition: RallarServerWsTopicDefinition<T>): this {
        this.core.defineTopic(definition);
        return this;
    }

    removeTopic(selector: RallarServerWsSelector): boolean {
        return this.core.removeTopic(selector);
    }

    on<T>(selector: RallarServerWsSelector, handler: RallarServerWsHandler<T>): () => boolean {
        return this.core.on(selector, handler);
    }

    proxy<T>(rule: RallarServerWsProxyRule<T>): () => boolean {
        return this.core.proxy(rule);
    }

    publish(message: ALMessage, fanout?: RallarServerWsFanout): Promise<number | undefined> {
        return this.core.publish(message, fanout);
    }
}

export class RallarServerRestFacade {
    private mounted = false;

    mount(app: Hono): this {
        if (this.mounted) {
            return this;
        }

        configRoutes.init(app);
        iceRoutes.init(app);
        clientStateRoutes.init(app);
        groupStateRoutes.init(app);
        graphRoutes.init(app);
        swaggerRoutes.init(app);
        this.mounted = true;
        return this;
    }
}
