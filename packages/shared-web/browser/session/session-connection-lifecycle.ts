import type {
    ApiMiddleware,
    BrowserTransportRuntimePort
} from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { MiddlewareInitOptions } from '@shared-web/browser/middleware.ts';
import {
    toRallarCommandOptions,
    toRallarOperationOptions,
    type RallarOperationOptions
} from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarConnectionRuntimePort } from '@shared-web/browser/rallar-runtime-context.ts';
import type { RallarLifecycleCoordinator } from '@shared-web/browser/session/rallar-lifecycle-coordinator.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';

export interface RallarSessionConnectionInput {
    readonly sessionId: string;
    readonly scope: StateScope | undefined;
    readonly operationOptions: RallarOperationOptions;
    readonly hasAuthEndInProgress: () => boolean;
    readonly isSessionCurrent: () => boolean;
    readonly onAuthInvalid: (error: Error) => Promise<void>;
}

export interface RallarSessionConnectionLifecycle {
    connect(input: RallarSessionConnectionInput): Promise<ApiMiddleware>;
    disconnect(): Promise<void>;
}

export namespace BrowserSessionConnectionLifecycle {
    export interface Input {
        readonly connectionRuntime: RallarConnectionRuntimePort;
        readonly transportRuntime: BrowserTransportRuntimePort;
        readonly lifecycle: RallarLifecycleCoordinator;
        readonly clearCurrentRoom: () => void;
    }
}

export class BrowserSessionConnectionLifecycle implements RallarSessionConnectionLifecycle {
    private connectionGeneration = 0;
    private connectionPromise: Promise<ApiMiddleware> | undefined;
    private disconnectPromise: Promise<void> | undefined;
    private lifecycleIsDisconnected = false;
    private readonly input: BrowserSessionConnectionLifecycle.Input;

    public constructor(input: BrowserSessionConnectionLifecycle.Input) {
        this.input = input;
    }

    public disconnect(): Promise<void> {
        if (this.disconnectPromise) {
            return this.disconnectPromise;
        }
        if (this.isDisconnectedWithoutTransport()) {
            return Promise.resolve();
        }

        const middleware = this.input.connectionRuntime.readMiddleware();
        this.disconnectPromise = Promise.resolve().then(() => {
            this.connectionGeneration += 1;
            this.connectionPromise = undefined;
            this.cleanupConnection(middleware);
        }).finally(() => {
            this.disconnectPromise = undefined;
        });
        return this.disconnectPromise;
    }

    public async connect(input: RallarSessionConnectionInput): Promise<ApiMiddleware> {
        const cachedMiddleware = this.input.connectionRuntime.readMiddleware();
        if (cachedMiddleware) {
            return cachedMiddleware;
        }
        const middlewareOptions = toMiddlewareOptions(input);
        if (this.connectionPromise) {
            return await waitForRallarOperation(this.connectionPromise, input.operationOptions);
        }

        const generation = this.connectionGeneration;
        this.lifecycleIsDisconnected = false;
        this.input.connectionRuntime.setConnectState('connecting');
        const pendingConnection = this.startConnection(input, middlewareOptions, generation);
        this.connectionPromise = pendingConnection;
        return await waitForRallarOperation(pendingConnection, input.operationOptions);
    }

    private startConnection(
        input: RallarSessionConnectionInput,
        middlewareOptions: ReturnType<typeof toMiddlewareOptions>,
        generation: number
    ): Promise<ApiMiddleware> {
        const pendingConnection = this.input.transportRuntime.init(middlewareOptions)
            .then((middleware) => this.acceptConnectedMiddleware(input, middleware, generation))
            .catch(async (error) => {
                const connectionError = error instanceof Error
                    ? error
                    : new Error('Rallar connection failed.');
                if (generation !== this.connectionGeneration) {
                    throw new Error('Rallar connection was cancelled because auth ended.');
                }
                this.input.connectionRuntime.setConnectState('idle');
                await input.onAuthInvalid(connectionError);
                if (input.hasAuthEndInProgress()) {
                    throw new Error('Rallar connection was cancelled because auth ended.');
                }
                throw connectionError;
            })
            .finally(() => {
                if (this.connectionPromise === pendingConnection) {
                    this.connectionPromise = undefined;
                }
            });
        return pendingConnection;
    }

    private acceptConnectedMiddleware(
        input: RallarSessionConnectionInput,
        middleware: ApiMiddleware,
        generation: number
    ): ApiMiddleware {
        if (
            generation !== this.connectionGeneration ||
            input.hasAuthEndInProgress() ||
            !input.isSessionCurrent() ||
            middleware.session.sessionId !== input.sessionId
        ) {
            this.input.transportRuntime.shutdown();
            this.input.connectionRuntime.setConnectState('idle');
            throw new Error('Rallar connection was cancelled because auth ended.');
        }
        this.input.connectionRuntime.setConnectState('connected');
        try {
            this.input.lifecycle.attach(middleware);
            this.input.lifecycle.connected();
            return middleware;
        }
        catch (error) {
            this.connectionPromise = undefined;
            try {
                this.cleanupConnection(middleware);
            }
            catch {
                // Preserve the lifecycle failure that caused this rollback.
            }
            throw error;
        }
    }

    private cleanupConnection(middleware: ApiMiddleware | undefined): void {
        let failure: Error | undefined;
        const attempt = (cleanup: () => void): void => {
            try {
                cleanup();
            }
            catch (error) {
                failure ??= error instanceof Error
                    ? error
                    : new Error('Rallar connection cleanup failed.');
            }
        };
        attempt(() => this.input.lifecycle.detach(middleware));
        attempt(() => this.input.transportRuntime.shutdown());
        attempt(() => this.input.clearCurrentRoom());
        attempt(() => this.input.connectionRuntime.setConnectState('idle'));
        attempt(() => this.input.lifecycle.disconnected());
        this.lifecycleIsDisconnected = true;
        if (failure !== undefined) {
            throw failure;
        }
    }

    private isDisconnectedWithoutTransport(): boolean {
        return this.input.connectionRuntime.readConnectState() === 'idle' &&
            !this.input.connectionRuntime.readMiddleware() &&
            !this.input.transportRuntime.isInitializing() &&
            this.lifecycleIsDisconnected;
    }
}

function toMiddlewareOptions(
    input: RallarSessionConnectionInput
): MiddlewareInitOptions {
    return {
        ...toRallarOperationOptions(input.operationOptions),
        ...(input.scope ? { scope: input.scope } : {}),
        onAuthInvalid: async (error) => {
            const connectionError = error instanceof Error
                ? error
                : new Error('Rallar connection failed.');
            await input.onAuthInvalid(connectionError);
        }
    };
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
