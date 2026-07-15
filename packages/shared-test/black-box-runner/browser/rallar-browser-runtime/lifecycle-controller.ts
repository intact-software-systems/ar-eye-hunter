export type BlackBoxRallarLifecycleOperationContext = Readonly<{
    generation: number;
    assertCurrent(): void;
}>;

export type BlackBoxRallarLifecycleCloseContext<TConfig> = Readonly<{
    authenticationConfig?: TConfig;
    generation: number;
}>;

export type BlackBoxRallarLifecycleController<TConfig, TSession, TConnect, TClose> = Readonly<{
    generation(): number;
    operationSignal(): AbortSignal;
    isCurrent(generation: number): boolean;
    isClosing(): boolean;
    authenticationConfig(): TConfig | undefined;
    waitForAuthentication(): Promise<void>;
    runAuthentication(config: TConfig, effect: (signal: AbortSignal) => Promise<TSession>): Promise<TSession>;
    runConnect(
        key: string,
        effect: (context: BlackBoxRallarLifecycleOperationContext) => Promise<TConnect>,
    ): Promise<TConnect>;
    runExclusive<TResult>(
        key: string,
        effect: (context: BlackBoxRallarLifecycleOperationContext) => Promise<TResult>,
    ): Promise<TResult>;
    close(
        effect: (context: BlackBoxRallarLifecycleCloseContext<TConfig>) => Promise<TClose>,
        pending?: readonly Promise<unknown>[],
    ): Promise<TClose>;
}>;

export type CreateBlackBoxRallarLifecycleControllerOptions<TConfig> = Readonly<{
    authenticationKey(config: TConfig): string;
    mergeAuthenticationConfig(active: TConfig, next: TConfig): TConfig;
    authenticationClosedError(): Error;
    connectionClosedError(): Error;
}>;

type AuthenticationInFlight<TConfig, TSession> = Readonly<{
    key: string;
    config: TConfig;
    controller: AbortController;
    generation: number;
    promise: Promise<TSession>;
}>;

type ConnectInFlight = Readonly<{
    key: string;
    generation: number;
    promise: Promise<unknown>;
}>;

export function createBlackBoxRallarLifecycleController<TConfig, TSession, TConnect, TClose>(
    options: CreateBlackBoxRallarLifecycleControllerOptions<TConfig>,
): BlackBoxRallarLifecycleController<TConfig, TSession, TConnect, TClose> {
    let generation = 0;
    let authenticationInFlight: AuthenticationInFlight<TConfig, TSession> | undefined;
    let connectInFlight: ConnectInFlight | undefined;
    let closeInFlight: Promise<TClose> | undefined;
    let operationController = new AbortController();
    let faulted = false;

    const isCurrent = (candidate: number): boolean => candidate === generation && !closeInFlight && !faulted;

    const assertConnectionCurrent = (candidate: number): void => {
        if (!isCurrent(candidate)) {
            throw options.connectionClosedError();
        }
    };

    const runAuthentication = (
        config: TConfig,
        effect: (signal: AbortSignal) => Promise<TSession>,
    ): Promise<TSession> => {
        if (closeInFlight || faulted) {
            return Promise.reject(options.authenticationClosedError());
        }

        const key = options.authenticationKey(config);
        const active = authenticationInFlight;
        if (active) {
            if (active.key === key) {
                authenticationInFlight = {
                    ...active,
                    config: options.mergeAuthenticationConfig(active.config, config),
                };
                return active.promise;
            }
            return active.promise.then(
                () => runAuthentication(config, effect),
                () => runAuthentication(config, effect),
            );
        }

        const activeConnection = connectInFlight;
        if (activeConnection) {
            return activeConnection.promise.then(
                () => runAuthentication(config, effect),
                () => runAuthentication(config, effect),
            );
        }

        const operationGeneration = generation;
        const controller = new AbortController();
        const promise = (async () => {
            const session = await effect(controller.signal);
            if (operationGeneration !== generation || closeInFlight || faulted) {
                throw options.authenticationClosedError();
            }
            return session;
        })();
        authenticationInFlight = {
            key,
            config,
            controller,
            generation: operationGeneration,
            promise,
        };
        void promise
            .finally(() => {
                if (authenticationInFlight?.promise === promise) {
                    authenticationInFlight = undefined;
                }
            })
            .catch(() => undefined);
        return promise;
    };

    const runExclusive = <TResult>(
        key: string,
        effect: (context: BlackBoxRallarLifecycleOperationContext) => Promise<TResult>,
    ): Promise<TResult> => {
        if (closeInFlight || faulted) {
            return Promise.reject(options.connectionClosedError());
        }

        const active = connectInFlight;
        if (active) {
            if (active.key === key) {
                return active.promise as Promise<TResult>;
            }
            return active.promise.then(
                () => runExclusive(key, effect),
                () => runExclusive(key, effect),
            );
        }

        const operationGeneration = generation;
        const context: BlackBoxRallarLifecycleOperationContext = {
            generation: operationGeneration,
            assertCurrent: () => assertConnectionCurrent(operationGeneration),
        };
        const promise = effect(context);
        connectInFlight = {
            key,
            generation: operationGeneration,
            promise,
        };
        void promise
            .finally(() => {
                if (connectInFlight?.promise === promise) {
                    connectInFlight = undefined;
                }
            })
            .catch(() => undefined);
        return promise;
    };

    const runConnect = (
        key: string,
        effect: (context: BlackBoxRallarLifecycleOperationContext) => Promise<TConnect>,
    ): Promise<TConnect> => runExclusive(key, effect);

    const close = (
        effect: (context: BlackBoxRallarLifecycleCloseContext<TConfig>) => Promise<TClose>,
        pending: readonly Promise<unknown>[] = [],
    ): Promise<TClose> => {
        if (closeInFlight) {
            return closeInFlight;
        }

        const activeAuthentication = authenticationInFlight;
        const activeConnect = connectInFlight;
        const activeOperationController = operationController;
        generation += 1;
        operationController = new AbortController();
        activeOperationController.abort(options.connectionClosedError());
        activeAuthentication?.controller.abort(options.authenticationClosedError());
        const context: BlackBoxRallarLifecycleCloseContext<TConfig> = {
            authenticationConfig: activeAuthentication?.config,
            generation,
        };

        let closing!: Promise<TClose>;
        closing = (async () => {
            try {
                await Promise.allSettled([
                    ...(activeAuthentication ? [activeAuthentication.promise] : []),
                    ...(activeConnect ? [activeConnect.promise] : []),
                    ...pending,
                ]);
                const result = await effect(context);
                faulted = false;
                return result;
            } catch (error) {
                faulted = true;
                throw error;
            } finally {
                if (closeInFlight === closing) {
                    closeInFlight = undefined;
                }
            }
        })();
        closeInFlight = closing;
        return closing;
    };

    return {
        generation: () => generation,
        operationSignal: () => operationController.signal,
        isCurrent: candidate => candidate === generation && !closeInFlight && !faulted,
        isClosing: () => Boolean(closeInFlight),
        authenticationConfig: () => authenticationInFlight?.config,
        waitForAuthentication: async () => {
            try {
                await authenticationInFlight?.promise;
            } catch {
                // Callers use this only as a serialization barrier.
            }
        },
        runAuthentication,
        runConnect,
        runExclusive,
        close,
    };
}
