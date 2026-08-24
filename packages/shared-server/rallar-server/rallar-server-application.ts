import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { AppDataRepository } from '../app-data/app-data-repository.ts';
import { RallarServerAppData } from '../app-data/rallar-server-app-data.ts';
import type { RallarServerWsRouterOptions } from '../rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { RallarServerWsRouter } from '../rallar-system/websocket/router/rallar-server-ws-router.ts';

export interface RallarServerQueueEngine {
    start(): void;
    wake(): void;
}

export interface RallarServerRuntime {
    readonly wsQBoxServerService: WsQueueBoxServerService;
    readonly qboxEngine: RallarServerQueueEngine;
}

export type RallarServerRouteInstaller<TApp> = (app: TApp) => void;

export interface RallarServerApplicationSystemInstallers<TRuntime extends RallarServerRuntime> {
    readonly installSystemTopics: (
        runtime: TRuntime,
        ws: RallarServerWsRouter
    ) => void;
    readonly installWebSocketLifecycle: (
        runtime: TRuntime,
        ws: RallarServerWsRouter
    ) => void;
}

export interface RallarServerApplicationRouteInstallers<TApp> {
    readonly webSocket: RallarServerRouteInstaller<TApp>;
    readonly rest: readonly RallarServerRouteInstaller<TApp>[];
}

export interface CreateRallarServerApplicationInput<TRuntime extends RallarServerRuntime, TApp> {
    readonly runtime: TRuntime;
    readonly repositories: RepositoryManager;
    readonly appDataRepository: AppDataRepository;
    readonly nowEpochMs: () => number;
    readonly ws: RallarServerWsRouterOptions;
    readonly systemInstallers: RallarServerApplicationSystemInstallers<TRuntime>;
    readonly routeInstallers: RallarServerApplicationRouteInstallers<TApp>;
}

export class RallarServerApplication<TRuntime extends RallarServerRuntime, TApp> {
    readonly runtime: TRuntime;
    readonly repositories: RepositoryManager;
    readonly ws: RallarServerWsRouter;
    readonly appData: RallarServerAppData;

    private readonly systemInstallers: RallarServerApplicationSystemInstallers<TRuntime>;
    private readonly routeInstallers: RallarServerApplicationRouteInstallers<TApp>;
    private systemTopicsInstalled = false;
    private webSocketLifecycleInstalled = false;
    private webSocketMounted = false;
    private restMounted = false;

    constructor(input: CreateRallarServerApplicationInput<TRuntime, TApp>) {
        this.runtime = input.runtime;
        this.repositories = input.repositories;
        this.systemInstallers = input.systemInstallers;
        this.routeInstallers = input.routeInstallers;
        this.ws = new RallarServerWsRouter(input.runtime.wsQBoxServerService, {
            ...input.ws,
            wakeOutbox: () => input.runtime.qboxEngine.wake()
        });
        this.appData = new RallarServerAppData({
            repositories: input.repositories,
            repository: input.appDataRepository,
            nowEpochMs: input.nowEpochMs
        });
    }

    installSystemTopics(): this {
        if (!this.systemTopicsInstalled) {
            this.systemInstallers.installSystemTopics(this.runtime, this.ws);
            this.systemTopicsInstalled = true;
        }
        return this;
    }

    installWebSocketLifecycle(): this {
        if (!this.webSocketLifecycleInstalled) {
            this.systemInstallers.installWebSocketLifecycle(this.runtime, this.ws);
            this.webSocketLifecycleInstalled = true;
        }
        return this;
    }

    mountWebSocket(app: TApp): this {
        if (!this.webSocketMounted) {
            this.routeInstallers.webSocket(app);
            this.webSocketMounted = true;
        }
        return this;
    }

    mountRest(app: TApp): this {
        if (!this.restMounted) {
            for (const install of this.routeInstallers.rest) {
                install(app);
            }
            this.restMounted = true;
        }
        return this;
    }

    start(): void {
        this.runtime.qboxEngine.start();
    }
}

export function createRallarServerApplication<TRuntime extends RallarServerRuntime, TApp>(
    input: CreateRallarServerApplicationInput<TRuntime, TApp>
): RallarServerApplication<TRuntime, TApp> {
    return new RallarServerApplication(input);
}
