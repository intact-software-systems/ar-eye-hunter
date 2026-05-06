import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import type { RepositoryToken } from '@shared/cache/RepositoryToken.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import {
    RallarServerWsFacade,
    type RallarServerWsFacadeOptions,
    type RallarServerWsFanout,
    type RallarServerWsHandler,
    type RallarServerWsProxyRule,
    type RallarServerWsSelector,
    type RallarServerWsTopicDefinition,
} from './ws-topic-router.ts';

export type RallarServerRuntime = Readonly<{
    wsQBoxServerService: WsQueueBoxServerService;
    qboxEngine?: Readonly<{
        start(): void;
    }>;
}>;

export type RallarServerSystemInstallers<TRuntime extends RallarServerRuntime> =
    Readonly<{
        installDefaultMiddlewareTopics?: (
            runtime: TRuntime,
            ws: RallarServerWsFacade,
        ) => void;
        installWebSocketLifecycle?: (
            runtime: TRuntime,
            ws: RallarServerWsFacade,
        ) => void;
    }>;

export type CreateRallarServerFacadeOptions<
    TRuntime extends RallarServerRuntime,
> = Readonly<{
    runtime: TRuntime;
    repositories?: RepositoryManager;
    ws?: RallarServerWsFacadeOptions;
    system?: RallarServerSystemInstallers<TRuntime>;
}>;

export class RallarServer<TRuntime extends RallarServerRuntime = RallarServerRuntime> {
    readonly ws: RallarServerWebSocketFacade;
    readonly system: RallarServerSystemFacade<TRuntime>;
    readonly data: RallarServerDataFacade;

    constructor(
        readonly runtime: TRuntime,
        repositories: RepositoryManager = defaultRepositoryManager,
        wsOptions: RallarServerWsFacadeOptions = {},
        systemInstallers: RallarServerSystemInstallers<TRuntime> = {},
    ) {
        const wsTopicsFacade = new RallarServerWsFacade(
            runtime.wsQBoxServerService,
            wsOptions,
        );

        this.ws = new RallarServerWebSocketFacade(wsTopicsFacade);
        this.system = new RallarServerSystemFacade(
            runtime,
            wsTopicsFacade,
            systemInstallers,
        );
        this.data = new RallarServerDataFacade(repositories);
    }

    start(): void {
        this.runtime.qboxEngine?.start();
    }
}

export function createRallarServerFacade<
    TRuntime extends RallarServerRuntime,
>(
    options: CreateRallarServerFacadeOptions<TRuntime>,
): RallarServer<TRuntime> {
    return new RallarServer(
        options.runtime,
        options.repositories ?? defaultRepositoryManager,
        options.ws,
        options.system,
    );
}

export class RallarServerSystemFacade<
    TRuntime extends RallarServerRuntime = RallarServerRuntime,
> {
    private defaultTopicsInstalled = false;
    private lifecycleInstalled = false;

    constructor(
        private readonly runtime: TRuntime,
        private readonly ws: RallarServerWsFacade,
        private readonly installers: RallarServerSystemInstallers<TRuntime>,
    ) {
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
    constructor(private readonly topics: RallarServerWsFacade) {
    }

    install(): this {
        this.topics.install();
        return this;
    }

    defineTopic<T>(definition: RallarServerWsTopicDefinition<T>): this {
        this.topics.defineTopic(definition);
        return this;
    }

    removeTopic(selector: RallarServerWsSelector): boolean {
        return this.topics.removeTopic(selector);
    }

    on<T>(
        selector: RallarServerWsSelector,
        handler: RallarServerWsHandler<T>,
    ): () => boolean {
        return this.topics.on(selector, handler);
    }

    proxy<T>(rule: RallarServerWsProxyRule<T>): () => boolean {
        return this.topics.proxy(rule);
    }

    publish(
        message: ALMessage,
        fanout?: RallarServerWsFanout,
    ): Promise<number | undefined> {
        return this.topics.publish(message, fanout);
    }
}

export class RallarServerDataFacade {
    constructor(readonly repositories: RepositoryManager) {
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
