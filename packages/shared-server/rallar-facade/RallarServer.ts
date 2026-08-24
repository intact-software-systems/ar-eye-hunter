import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { RepositoryToken } from '@shared/cache/RepositoryToken.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { AppDataRepositoryLike } from '../app-data/AppDataRepository.ts';
import {
    RallarServerAppDataFacade,
    type RallarServerAppDataStore,
    type RallarServerAppDataStoreDefinition,
    type RallarServerAppDataStoreOptions
} from '../app-data/RallarServerAppData.ts';
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
import { RallarServerWsRouter } from '../rallar-system/websocket/router/rallar-server-ws-router.ts';
import type { RallarServerWsStatus } from '../rallar-system/websocket/router/rallar-server-ws-status.ts';

export interface RallarServerQueueEngine {
    start(): void;
    wake?(): void;
}

export interface RallarServerRuntime {
    readonly wsQBoxServerService: WsQueueBoxServerService;
    readonly qboxEngine?: RallarServerQueueEngine;
}

export interface RallarServerSystemInstallers<TRuntime extends RallarServerRuntime> {
    readonly installDefaultMiddlewareTopics?: (
        runtime: TRuntime,
        ws: RallarServerWsRouter
    ) => void;
    readonly installWebSocketLifecycle?: (
        runtime: TRuntime,
        ws: RallarServerWsRouter
    ) => void;
}

export interface RallarServerFacadeAppDataOptions {
    readonly repository?: AppDataRepositoryLike;
}

export interface CreateRallarServerFacadeOptions<TRuntime extends RallarServerRuntime> {
    readonly runtime: TRuntime;
    readonly repositories?: RepositoryManager;
    readonly ws?: RallarServerWsRouterOptions;
    readonly system?: RallarServerSystemInstallers<TRuntime>;
    readonly appData?: RallarServerFacadeAppDataOptions;
}

export class RallarServer<TRuntime extends RallarServerRuntime = RallarServerRuntime> {
    readonly ws: RallarServerWebSocketFacade;
    readonly system: RallarServerSystemFacade<TRuntime>;
    readonly data: RallarServerDataFacade;

    readonly runtime: TRuntime;

    constructor(
        runtime: TRuntime,
        repositories: RepositoryManager = defaultRepositoryManager,
        wsOptions: RallarServerWsRouterOptions = {},
        systemInstallers: RallarServerSystemInstallers<TRuntime> = {},
        appDataRepository?: AppDataRepositoryLike
    ) {
        this.runtime = runtime;
        const wsRouter = new RallarServerWsRouter(
            runtime.wsQBoxServerService,
            {
                ...wsOptions,
                wakeOutbox: () => runtime.qboxEngine?.wake?.()
            }
        );

        this.ws = new RallarServerWebSocketFacade(wsRouter);
        this.system = new RallarServerSystemFacade(
            runtime,
            wsRouter,
            systemInstallers
        );
        this.data = new RallarServerDataFacade(repositories, appDataRepository);
    }

    start(): void {
        this.runtime.qboxEngine?.start();
    }
}

export function createRallarServerFacade<TRuntime extends RallarServerRuntime>(
    options: CreateRallarServerFacadeOptions<TRuntime>
): RallarServer<TRuntime> {
    return new RallarServer(
        options.runtime,
        options.repositories ?? defaultRepositoryManager,
        options.ws,
        options.system,
        options.appData?.repository
    );
}

export class RallarServerSystemFacade<TRuntime extends RallarServerRuntime = RallarServerRuntime> {
    private defaultTopicsInstalled = false;
    private lifecycleInstalled = false;

    private readonly runtime: TRuntime;
    private readonly ws: RallarServerWsRouter;
    private readonly installers: RallarServerSystemInstallers<TRuntime>;

    constructor(
        runtime: TRuntime,
        ws: RallarServerWsRouter,
        installers: RallarServerSystemInstallers<TRuntime>
    ) {
        this.runtime = runtime;
        this.ws = ws;
        this.installers = installers;
    }

    useDefaultMiddlewareTopics(): this {
        if (this.defaultTopicsInstalled) {
            return this;
        }

        this.installers.installDefaultMiddlewareTopics?.(this.runtime, this.ws);
        this.ws.install();
        this.defaultTopicsInstalled = true;
        return this;
    }

    useWebSocketLifecycle(): this {
        if (this.lifecycleInstalled) {
            return this;
        }

        this.installers.installWebSocketLifecycle?.(this.runtime, this.ws);
        this.lifecycleInstalled = true;
        return this;
    }
}

export class RallarServerWebSocketFacade {
    private readonly topics: RallarServerWsRouter;

    constructor(topics: RallarServerWsRouter) {
        this.topics = topics;
    }

    install(): this {
        this.topics.install();
        return this;
    }

    defineTopic<T extends RallarServerWsPayload>(
        definition: RallarServerWsTopicDefinition<T>
    ): this {
        this.topics.defineTopic(definition);
        return this;
    }

    removeTopic(selector: RallarServerWsSelector): boolean {
        return this.topics.removeTopic(selector);
    }

    on<T extends RallarServerWsPayload>(
        selector: RallarServerWsSelector,
        handler: RallarServerWsHandler<T>
    ): () => boolean {
        return this.topics.on(selector, handler);
    }

    proxy<T extends RallarServerWsPayload>(rule: RallarServerWsProxyRule<T>): () => boolean {
        return this.topics.proxy(rule);
    }

    publish(
        message: ALMessage,
        fanout?: RallarServerWsFanout
    ): Promise<RallarServerWsPublishResult> {
        return this.topics.publish(message, fanout);
    }

    status(): RallarServerWsStatus {
        return this.topics.status();
    }
}

export class RallarServerDataFacade {
    private readonly appData: RallarServerAppDataFacade;

    readonly repositories: RepositoryManager;

    constructor(
        repositories: RepositoryManager,
        appDataRepository?: AppDataRepositoryLike
    ) {
        this.repositories = repositories;
        this.appData = new RallarServerAppDataFacade(
            repositories,
            appDataRepository
        );
    }

    define<V>(
        name: string,
        options?: RallarServerAppDataStoreOptions<V>
    ): RallarServerAppDataStoreDefinition<V> {
        return this.appData.define(name, options);
    }

    open<V>(
        input: string | RallarServerAppDataStoreDefinition<V>,
        options?: RallarServerAppDataStoreOptions<V>
    ): Promise<RallarServerAppDataStore<V>> {
        return this.appData.open(input, options);
    }

    lookupStore<V>(
        input: string | RallarServerAppDataStoreDefinition<V>,
        options?: RallarServerAppDataStoreOptions<V>
    ): RallarServerAppDataStore<V> | undefined {
        return this.appData.lookup(input, options);
    }

    closeStore<V>(
        input: string | RallarServerAppDataStoreDefinition<V>,
        options?: RallarServerAppDataStoreOptions<V>
    ): Promise<boolean> {
        return this.appData.close(input, options);
    }

    has(token: RepositoryToken<unknown>): boolean;
    has(id: string): boolean;
    has(tokenOrId: RepositoryToken<unknown> | string): boolean {
        return this.repositories.has(tokenOrId as RepositoryToken<unknown>);
    }

    ids(): readonly string[] {
        return this.repositories.ids();
    }

    lookup<R>(token: RepositoryToken<R>): R | undefined {
        return this.repositories.get(token);
    }

    require<R>(token: RepositoryToken<R>): R {
        return this.repositories.require(token);
    }

    register<R>(token: RepositoryToken<R>, repository: R): R {
        return this.repositories.register(token, repository);
    }

    set<R>(token: RepositoryToken<R>, repository: R): R {
        return this.repositories.set(token, repository);
    }

    resolve<R>(token: RepositoryToken<R>): R {
        return this.repositories.resolve(token);
    }

    replace<R>(token: RepositoryToken<R>, repository: R): Promise<R> {
        return this.repositories.replace(token, repository);
    }

    delete(token: RepositoryToken<unknown>): Promise<boolean>;
    delete(id: string): Promise<boolean>;
    delete(tokenOrId: RepositoryToken<unknown> | string): Promise<boolean> {
        return this.repositories.delete(tokenOrId as RepositoryToken<unknown>);
    }

    clear(): Promise<void> {
        return this.repositories.clear();
    }
}
