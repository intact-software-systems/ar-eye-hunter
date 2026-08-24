import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { AppDataRepositoryLike } from '../app-data/AppDataRepository.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsHandler,
    RallarServerWsPayload,
    RallarServerWsProxyRule,
    RallarServerWsPublishResult,
    RallarServerWsRouterOptions,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition
} from '../rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import type { RallarServerWsStatus } from '../rallar-system/websocket/router/rallar-server-ws-status.ts';
import * as rallarServer from './rallar-server.ts';

export type RallarServerRouteInstaller<TApp> = (app: TApp) => void;

export interface RallarServerApplicationAppDataOptions {
    readonly repository?: AppDataRepositoryLike;
}

export interface RallarServerApplicationRoutes<TApp> {
    readonly ws?: RallarServerRouteInstaller<TApp>;
    readonly rest?: readonly RallarServerRouteInstaller<TApp>[];
}

export interface CreateRallarServerApplicationOptions<TRuntime extends rallarServer.RallarServerRuntime, TApp> {
    readonly runtime: TRuntime;
    readonly repositories?: RepositoryManager;
    readonly ws?: RallarServerWsRouterOptions;
    readonly system?: rallarServer.RallarServerSystemInstallers<TRuntime>;
    readonly appData?: RallarServerApplicationAppDataOptions;
    readonly routes?: RallarServerApplicationRoutes<TApp>;
}

export class RallarServerApplication<TRuntime extends rallarServer.RallarServerRuntime, TApp> {
    readonly ws: RallarServerWebSocketApplicationFacade<TApp>;
    readonly rest: RallarServerRestApplicationFacade<TApp>;
    readonly system: rallarServer.RallarServerSystemFacade<TRuntime>;
    readonly data: rallarServer.RallarServerDataFacade;

    readonly core: rallarServer.RallarServer<TRuntime>;

    constructor(
        core: rallarServer.RallarServer<TRuntime>,
        routes: CreateRallarServerApplicationOptions<TRuntime, TApp>['routes'] = {}
    ) {
        this.core = core;
        this.ws = new RallarServerWebSocketApplicationFacade(core.ws, routes.ws);
        this.rest = new RallarServerRestApplicationFacade(routes.rest ?? []);
        this.system = core.system;
        this.data = core.data;
    }

    get middleware(): TRuntime {
        return this.core.runtime;
    }

    get runtime(): TRuntime {
        return this.core.runtime;
    }

    start(): void {
        this.core.start();
    }
}

export function createRallarServerApplication<TRuntime extends rallarServer.RallarServerRuntime, TApp>(
    options: CreateRallarServerApplicationOptions<TRuntime, TApp>
): RallarServerApplication<TRuntime, TApp> {
    const core = rallarServer.createRallarServerFacade({
        runtime: options.runtime,
        repositories: options.repositories ?? defaultRepositoryManager,
        ws: options.ws,
        system: options.system,
        appData: options.appData
    });

    return new RallarServerApplication(core, options.routes);
}

export class RallarServerWebSocketApplicationFacade<TApp> {
    private mounted = false;

    private readonly core: rallarServer.RallarServerWebSocketFacade;
    private readonly routeInstaller?: RallarServerRouteInstaller<TApp>;

    constructor(
        core: rallarServer.RallarServerWebSocketFacade,
        routeInstaller?: RallarServerRouteInstaller<TApp>
    ) {
        this.core = core;
        this.routeInstaller = routeInstaller;
    }

    mount(app: TApp): this {
        if (this.mounted) {
            return this;
        }

        this.routeInstaller?.(app);
        this.mounted = true;
        return this;
    }

    install(): this {
        this.core.install();
        return this;
    }

    defineTopic<T extends RallarServerWsPayload>(
        definition: RallarServerWsTopicDefinition<T>
    ): this {
        this.core.defineTopic(definition);
        return this;
    }

    removeTopic(selector: RallarServerWsSelector): boolean {
        return this.core.removeTopic(selector);
    }

    on<T extends RallarServerWsPayload>(
        selector: RallarServerWsSelector,
        handler: RallarServerWsHandler<T>
    ): () => boolean {
        return this.core.on(selector, handler);
    }

    proxy<T extends RallarServerWsPayload>(rule: RallarServerWsProxyRule<T>): () => boolean {
        return this.core.proxy(rule);
    }

    publish(
        message: ALMessage,
        fanout?: RallarServerWsFanout
    ): Promise<RallarServerWsPublishResult> {
        return this.core.publish(message, fanout);
    }

    status(): RallarServerWsStatus {
        return this.core.status();
    }
}

export class RallarServerRestApplicationFacade<TApp> {
    private mounted = false;

    private readonly routeInstallers: readonly RallarServerRouteInstaller<TApp>[];

    constructor(
        routeInstallers: readonly RallarServerRouteInstaller<TApp>[]
    ) {
        this.routeInstallers = routeInstallers;
    }

    mount(app: TApp): this {
        if (this.mounted) {
            return this;
        }

        for (const install of this.routeInstallers) {
            install(app);
        }

        this.mounted = true;
        return this;
    }
}
