import type {
    ApiMiddleware,
    BrowserTransportRuntimePort
} from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    toRallarCommandOptions,
    toRallarOperationOptions,
    type RallarOperationOptions
} from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarConnectionRuntimePort } from '@shared-web/browser/rallar-runtime-context.ts';
import type { RallarLifecycleCoordinator } from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';
import { Command } from '@shared/cache/Command.ts';

export type CreateRallarSessionConnectionLifecycleInput = Readonly<{
    connectionRuntime: RallarConnectionRuntimePort;
    transportRuntime: BrowserTransportRuntimePort;
    lifecycle: RallarLifecycleCoordinator;
    clearCurrentRoom(): void;
    waitForAuthEnd(): Promise<void>;
    hasAuthEndInProgress(): boolean;
    scheduleAuthExpiry(session: AuthSession): void;
    endExpiredSession(session: AuthSession): Promise<void>;
    handleAuthInvalidError(error: Error): Promise<void>;
}>;

export type RallarSessionConnectionLifecycle = Readonly<{
    connect(options?: RallarScopedOperationOptions): Promise<ApiMiddleware>;
    disconnect(): Promise<void>;
}>;

export function createRallarSessionConnectionLifecycle(
    input: CreateRallarSessionConnectionLifecycleInput
): RallarSessionConnectionLifecycle {
    let connectionGeneration = 0;
    let connectionPromise: Promise<ApiMiddleware> | undefined;
    let disconnectPromise: Promise<void> | undefined;
    let lifecycleIsDisconnected = false;

    const disconnect = (): Promise<void> => {
        if (disconnectPromise) {
            return disconnectPromise;
        }
        if (isDisconnectedWithoutTransport(input, lifecycleIsDisconnected)) {
            return Promise.resolve();
        }

        const middleware = input.connectionRuntime.readMiddleware();
        disconnectPromise = Promise.resolve().then(() => {
            connectionGeneration += 1;
            input.lifecycle.detach(middleware);
            input.transportRuntime.shutdown();
            input.clearCurrentRoom();
            input.connectionRuntime.setConnectState('idle');
            input.lifecycle.disconnected();
            lifecycleIsDisconnected = true;
        }).finally(() => {
            disconnectPromise = undefined;
        });
        return disconnectPromise;
    };

    const connect = async (
        scopedOptions: RallarScopedOperationOptions = {}
    ): Promise<ApiMiddleware> => {
        await input.waitForAuthEnd();
        const operationOptions = input.connectionRuntime.resolveOperationOptions(scopedOptions);
        const scope = input.connectionRuntime.resolveOperationScope(operationOptions.scope);
        const session = readSession();
        const middlewareOptions = {
            ...toRallarOperationOptions(operationOptions),
            ...(scope ? { scope } : {}),
            onAuthInvalid: async (error: any) => await input.handleAuthInvalidError(toConnectionError(error))
        };

        const activeMiddleware = input.connectionRuntime.readMiddleware();
        if (activeMiddleware && !session) {
            await input.endExpiredSession(activeMiddleware.session);
        }
        else if (
            activeMiddleware &&
            session &&
            activeMiddleware.session.sessionId !== session.sessionId
        ) {
            await disconnect();
        }
        if (session) {
            input.scheduleAuthExpiry(session);
        }

        const cachedMiddleware = input.connectionRuntime.readMiddleware();
        if (cachedMiddleware) {
            return cachedMiddleware;
        }
        if (connectionPromise) {
            return await waitForRallarOperation(connectionPromise, middlewareOptions);
        }

        const generation = connectionGeneration;
        lifecycleIsDisconnected = false;
        input.connectionRuntime.setConnectState('connecting');
        const pendingConnection = input.transportRuntime.init(middlewareOptions)
            .then((middleware) => {
                if (
                    generation !== connectionGeneration ||
                    input.hasAuthEndInProgress() ||
                    readSession()?.sessionId !== middleware.session.sessionId
                ) {
                    input.transportRuntime.shutdown();
                    input.connectionRuntime.setConnectState('idle');
                    throw new Error('Rallar connection was cancelled because auth ended.');
                }
                input.connectionRuntime.setConnectState('connected');
                input.scheduleAuthExpiry(middleware.session);
                input.lifecycle.attach(middleware);
                input.lifecycle.connected();
                return middleware;
            })
            .catch(async (error: any) => {
                input.connectionRuntime.setConnectState('idle');
                await input.handleAuthInvalidError(toConnectionError(error));
                if (input.hasAuthEndInProgress()) {
                    throw new Error('Rallar connection was cancelled because auth ended.');
                }
                throw error;
            })
            .finally(() => {
                if (connectionPromise === pendingConnection) {
                    connectionPromise = undefined;
                }
            });
        connectionPromise = pendingConnection;
        return await waitForRallarOperation(pendingConnection, middlewareOptions);
    };

    return { connect, disconnect };
}

function isDisconnectedWithoutTransport(
    input: CreateRallarSessionConnectionLifecycleInput,
    lifecycleIsDisconnected: boolean
): boolean {
    return input.connectionRuntime.readConnectState() === 'idle' &&
        !input.connectionRuntime.readMiddleware() &&
        !input.transportRuntime.isInitializing() &&
        lifecycleIsDisconnected;
}

function waitForRallarOperation<T>(
    promise: Promise<T>,
    options: RallarOperationOptions
): Promise<T> {
    if (!options.signal && options.timeoutMs === undefined) {
        return promise;
    }
    return new Command<T>(() => promise, toRallarCommandOptions(options)).run();
}

function toConnectionError(error: any): Error {
    return error instanceof Error ? error : new Error('Rallar connection failed.');
}
