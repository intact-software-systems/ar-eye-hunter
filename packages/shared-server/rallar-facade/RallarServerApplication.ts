import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import {
    createRallarServerFacade,
    type RallarServer as RallarServerFacadeCore,
    RallarServerDataFacade,
    type RallarServerRuntime,
    RallarServerSystemFacade,
    type RallarServerSystemInstallers,
    type RallarServerWebSocketFacade as RallarServerWebSocketFacadeCore,
} from './RallarServer.ts';
import type {
    RallarServerWsFacadeOptions,
    RallarServerWsFanout,
    RallarServerWsHandler,
    RallarServerWsProxyRule,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition,
} from './ws-topic-router.ts';

export type RallarServerRouteInstaller<TApp> = (app: TApp) => void;

export type CreateRallarServerApplicationOptions<
    TRuntime extends RallarServerRuntime,
    TApp,
> = Readonly<{
    runtime: TRuntime;
    repositories?: RepositoryManager;
    ws?: RallarServerWsFacadeOptions;
    system?: RallarServerSystemInstallers<TRuntime>;
    routes?: Readonly<{
        ws?: RallarServerRouteInstaller<TApp>;
        rest?: readonly RallarServerRouteInstaller<TApp>[];
    }>;
}>;

export class RallarServerApplication<
    TRuntime extends RallarServerRuntime,
    TApp,
> {
    readonly ws: RallarServerWebSocketApplicationFacade<TApp>;
    readonly rest: RallarServerRestApplicationFacade<TApp>;
    readonly system: RallarServerSystemFacade<TRuntime>;
    readonly data: RallarServerDataFacade;

    constructor(
        readonly core: RallarServerFacadeCore<TRuntime>,
        routes: CreateRallarServerApplicationOptions<TRuntime, TApp>['routes'] = {},
    ) {
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

export function createRallarServerApplication<
    TRuntime extends RallarServerRuntime,
    TApp,
>(
    options: CreateRallarServerApplicationOptions<TRuntime, TApp>,
): RallarServerApplication<TRuntime, TApp> {
    const core = createRallarServerFacade({
        runtime: options.runtime,
        repositories: options.repositories ?? defaultRepositoryManager,
        ws: options.ws,
        system: options.system,
    });

    return new RallarServerApplication(core, options.routes);
}

export class RallarServerWebSocketApplicationFacade<TApp> {
    private mounted = false;

    constructor(
        private readonly core: RallarServerWebSocketFacadeCore,
        private readonly routeInstaller?: RallarServerRouteInstaller<TApp>,
    ) {}

    mount(app: TApp): this {
        if (this.mounted) {
            return this;
        }

        this.core.install();
        this.routeInstaller?.(app);
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

export class RallarServerRestApplicationFacade<TApp> {
    private mounted = false;

    constructor(
        private readonly routeInstallers: readonly RallarServerRouteInstaller<TApp>[],
    ) {}

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
