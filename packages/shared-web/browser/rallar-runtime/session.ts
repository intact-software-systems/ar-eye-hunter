import {
    configureApiClient,
    normalizeApiBaseUrl,
    type RallarApiClientConfig,
    readApiBaseUrl,
} from '@shared-web/browser/api-client-config.ts';
import * as authApi from '@shared-web/browser/auth/session-http-api.ts';
import {
    type ApiMiddleware,
    initMiddleware,
    isMiddlewareReady,
} from '@shared-web/browser/app-context.ts';
import { deleteBrowserALRuntimeEntriesForSession } from '@shared-web/browser/browser-al-runtime-stores.ts';
import type {
    CreateRallarAuthFacadeOptions,
    RallarAuthChangeListener,
    RallarAuthChangeReason,
    RallarAuthState,
    RallarRegisterOptions,
} from '@shared-web/browser/rallar-auth-facade.ts';
import type {
    CreateRallarConnectionFacadeOptions,
    RallarDefaults,
    RallarFlowPolicies,
    RallarScopedOperationOptions,
    RallarStartOptions,
    RallarStartResult,
} from '@shared-web/browser/rallar-connection-facade.ts';
import {
    type RallarOperationOptions,
    toRallarCommandOptions,
    toRallarOperationOptions,
} from '@shared-web/browser/rallar-operation-options.ts';
import type {
    RallarAuthRuntimePort,
    RallarConnectionRuntimePort,
    RallarLifecycleCoordinator,
    RallarStateRuntimePort,
} from '@shared-web/browser/rallar-runtime/contracts.ts';
import {
    createRallarSubscriptionScope,
    notifyListener,
} from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import type {
    RallarOnChangeOptions,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type {
    AuthSession,
    LoginRequest,
    LoginResponse,
    RegisterRequest,
    RegisterResponse,
} from '@shared/api/api-config.ts';
import { clearSession, isLoggedIn, readSession, writeSession } from '@shared/api/auth.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { CommandsOrchestrator } from '@shared/cache/CommandsOrchestrator.ts';

const MAX_AUTH_EXPIRY_TIMEOUT_MS = 2_147_483_647;

export type CreateRallarSessionControllerOptions = Readonly<{
    connectionRuntime: RallarConnectionRuntimePort;
    authRuntime: RallarAuthRuntimePort;
    stateRuntime: Pick<RallarStateRuntimePort, 'clearCurrentRoom'>;
    lifecycle: RallarLifecycleCoordinator;
    start(options?: RallarStartOptions): Promise<RallarStartResult>;
    emitState(): void;
    closeDataScopes(session: AuthSession): Promise<void>;
}>;

export type RallarSessionController = Readonly<{
    connectionOperations: CreateRallarConnectionFacadeOptions;
    authOperations: CreateRallarAuthFacadeOptions;
    connect(options?: RallarScopedOperationOptions): Promise<ApiMiddleware>;
    disconnect(): Promise<void>;
    readMiddleware(): ApiMiddleware | undefined;
    requireMiddleware(): ApiMiddleware;
    requireSession(): AuthSession;
    readDefaults(): RallarDefaults | undefined;
    readDefaultScope(): StateScope | undefined;
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T,
    ): T & RallarOperationOptions;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    runAuthAwareOperation<T>(operation: () => T | Promise<T>): Promise<T>;
    waitForAuthEnd(): Promise<void>;
    resolveDataScopeKey(scope: string): string;
}>;

export function createRallarSessionController(
    options: CreateRallarSessionControllerOptions,
): RallarSessionController {
    const authStateListeners = new Set<RallarAuthChangeListener>();
    let connectionGeneration = 0;

    const resolveOperationOptions = <T extends RallarOperationOptions>(
        operationOptions: T,
    ): T & RallarOperationOptions =>
        options.connectionRuntime.resolveOperationOptions(operationOptions);

    const resolveOperationScope = (
        scope?: StateScope,
    ): StateScope | undefined => options.connectionRuntime.resolveOperationScope(scope);

    const requireSession = (): AuthSession => {
        const session = readSession();
        if (!session) {
            throw new Error('Rallar requires an auth session.');
        }
        return session;
    };

    const clearAuthExpiryTimer = (): void => {
        options.authRuntime.clearAuthExpiryTimer();
    };

    let endAuthSession!: (
        reason: Exclude<RallarAuthChangeReason, 'current' | 'login'>,
        endOptions: Readonly<{
            revoke: boolean;
            operationOptions?: RallarOperationOptions;
            session?: AuthSession;
        }>,
    ) => Promise<void>;

    const scheduleAuthExpiry = (session: AuthSession | undefined): void => {
        clearAuthExpiryTimer();
        if (!session) {
            return;
        }
        const delayMs = Math.max(0, session.expiresAtEpochMs - Date.now());
        options.authRuntime.setAuthExpiryTimer(setTimeout(() => {
            void expireAuthSessionIfCurrent(session);
        }, Math.min(delayMs, MAX_AUTH_EXPIRY_TIMEOUT_MS)));
    };

    const expireAuthSessionIfCurrent = async (
        expectedSession: AuthSession,
    ): Promise<void> => {
        const current = readSession();
        if (current && current.sessionId !== expectedSession.sessionId) {
            scheduleAuthExpiry(current);
            return;
        }
        if (current && current.expiresAtEpochMs > Date.now()) {
            scheduleAuthExpiry(current);
            return;
        }
        await endAuthSession('expired', {
            revoke: false,
            session: current ?? expectedSession,
        });
    };

    const toAuthState = (
        reason: RallarAuthChangeReason,
        session: AuthSession | undefined,
    ): RallarAuthState => ({
        authenticated: session !== undefined,
        reason,
        session,
    });

    const emitAuthState = (
        reason: RallarAuthChangeReason,
        session: AuthSession | undefined,
    ): void => {
        const state = toAuthState(reason, session);
        for (const listener of authStateListeners) {
            notifyListener(listener, state);
        }
    };

    const waitForAuthEnd = async (): Promise<void> => {
        const promise = options.authRuntime.readAuthEndPromise();
        if (promise) {
            await promise;
        }
    };

    const disconnect = async (): Promise<void> => {
        connectionGeneration += 1;
        const ctx = options.connectionRuntime.readMiddleware();
        options.lifecycle.detach(ctx);
        if (ctx) {
            shutdownApiMiddleware(ctx);
        }
        options.stateRuntime.clearCurrentRoom();
        options.connectionRuntime.setConnectState('idle');
        options.connectionRuntime.clearMiddleware();
        options.lifecycle.disconnected();
    };

    const handleAuthInvalidError = async (error: unknown): Promise<void> => {
        if (!isUnauthorizedApiError(error)) {
            return;
        }
        const session = options.connectionRuntime.readMiddleware()?.session ?? readSession();
        if (!session) {
            return;
        }
        await endAuthSession('unauthorized', {
            revoke: false,
            session,
        });
    };

    const runAuthAwareOperation = async <T>(
        operation: () => T | Promise<T>,
    ): Promise<T> => {
        try {
            return await operation();
        } catch (error) {
            await handleAuthInvalidError(error);
            throw error;
        }
    };

    const connect = async (
        scopedOptions: RallarScopedOperationOptions = {},
    ): Promise<ApiMiddleware> => {
        await waitForAuthEnd();
        const operationOptions = resolveOperationOptions(scopedOptions);
        const middlewareScope = resolveOperationScope(operationOptions.scope);
        const session = readSession();
        const connectOptions = {
            ...toRallarOperationOptions(operationOptions),
            ...(middlewareScope ? { scope: middlewareScope } : {}),
            onAuthInvalid: (_error: unknown) =>
                endAuthSession('unauthorized', {
                    revoke: false,
                    session: options.connectionRuntime.readMiddleware()?.session ??
                        session ?? undefined,
                }),
        };

        const currentMiddleware = options.connectionRuntime.readMiddleware();
        if (currentMiddleware && !session) {
            await endAuthSession('expired', {
                revoke: false,
                session: currentMiddleware.session,
            });
        } else if (
            currentMiddleware && session &&
            currentMiddleware.session.sessionId !== session.sessionId
        ) {
            await disconnect();
        }
        if (session) {
            scheduleAuthExpiry(session);
        }

        const cached = options.connectionRuntime.readMiddleware();
        if (cached) {
            return cached;
        }
        const existingPromise = options.connectionRuntime.readConnectPromise();
        if (existingPromise) {
            return await waitForRallarOperation(existingPromise, connectOptions);
        }

        const generation = connectionGeneration;
        options.connectionRuntime.setConnectState('connecting');
        const promise = initMiddleware(connectOptions)
            .then((ctx) => {
                if (
                    generation !== connectionGeneration ||
                    options.authRuntime.readAuthEndPromise() ||
                    readSession()?.sessionId !== ctx.session.sessionId
                ) {
                    shutdownApiMiddleware(ctx);
                    options.connectionRuntime.clearMiddleware();
                    options.connectionRuntime.setConnectState('idle');
                    throw new Error(
                        'Rallar connection was cancelled because auth ended.',
                    );
                }
                options.connectionRuntime.setMiddleware(ctx);
                options.connectionRuntime.setConnectState('connected');
                scheduleAuthExpiry(ctx.session);
                options.lifecycle.attach(ctx);
                options.lifecycle.connected();
                return ctx;
            })
            .catch(async (error) => {
                options.connectionRuntime.setConnectState('idle');
                await handleAuthInvalidError(error);
                throw error;
            })
            .finally(() => {
                options.connectionRuntime.setConnectPromise(undefined);
            });
        options.connectionRuntime.setConnectPromise(promise);
        return await waitForRallarOperation(promise, connectOptions);
    };

    const doEndAuthSession = async (
        reason: Exclude<RallarAuthChangeReason, 'current' | 'login'>,
        endOptions: Readonly<{
            revoke: boolean;
            operationOptions?: RallarOperationOptions;
            session?: AuthSession;
        }>,
    ): Promise<void> => {
        const session = endOptions.session ??
            options.connectionRuntime.readMiddleware()?.session ?? readSession();
        let disconnectError: unknown;
        let revokeError: unknown;
        let dataCleanupError: unknown;
        clearAuthExpiryTimer();
        clearSession();
        try {
            try {
                await disconnect();
            } catch (error) {
                disconnectError = error;
            }
            if (endOptions.revoke && session) {
                try {
                    const requestId = crypto.randomUUID();
                    await runRallarCommand(
                        (signal) =>
                            authApi.logoutFromApi({
                                requestId,
                                signal,
                                authSession: session,
                            }),
                        endOptions.operationOptions ?? {},
                    );
                } catch (error) {
                    revokeError = error;
                }
            }
        } finally {
            if (session) {
                try {
                    await options.closeDataScopes(session);
                } catch (error) {
                    dataCleanupError = error;
                }
                try {
                    await deleteBrowserALRuntimeEntriesForSession(
                        session.sessionId,
                    );
                } catch {
                    // Browser-local AL cleanup is best-effort.
                }
            }
            options.emitState();
            emitAuthState(reason, undefined);
        }
        if (disconnectError) {
            throw disconnectError;
        }
        if (revokeError) {
            throw revokeError;
        }
        if (dataCleanupError) {
            throw dataCleanupError;
        }
    };

    endAuthSession = async (reason, endOptions): Promise<void> => {
        const session = endOptions.session ??
            options.connectionRuntime.readMiddleware()?.session ?? readSession();
        const sessionKey = session ? toAuthSessionKey(session) : undefined;
        const currentPromise = options.authRuntime.readAuthEndPromise();
        if (currentPromise) {
            return await currentPromise;
        }
        if (
            sessionKey &&
            options.authRuntime.endedAuthSessionKeys().has(sessionKey)
        ) {
            return;
        }
        if (sessionKey) {
            options.authRuntime.endedAuthSessionKeys().add(sessionKey);
        }
        const promise = doEndAuthSession(reason, {
            ...endOptions,
            session,
        }).finally(() => {
            options.authRuntime.setAuthEndPromise(undefined);
        });
        options.authRuntime.setAuthEndPromise(promise);
        return await promise;
    };

    const authOperations: CreateRallarAuthFacadeOptions = {
        login: async (
            request: LoginRequest,
            authOptions: RallarOperationOptions = {},
        ): Promise<LoginResponse> => {
            const operationOptions = resolveOperationOptions(authOptions);
            const requestId = crypto.randomUUID();
            const response = await runRallarCommand(
                (signal) => authApi.loginToApi(request, { requestId, signal }),
                operationOptions,
            );
            if (options.connectionRuntime.readMiddleware() || isMiddlewareReady()) {
                await disconnect();
            }
            const previous = readSession();
            if (previous) {
                await options.closeDataScopes(previous);
            }
            writeSession(response);
            options.authRuntime.endedAuthSessionKeys().delete(
                toAuthSessionKey(response),
            );
            scheduleAuthExpiry(response);
            emitAuthState('login', response);
            return response;
        },
        register: async (
            request: RegisterRequest,
            registerOptions: RallarRegisterOptions = {},
        ): Promise<RegisterResponse> => {
            const operationOptions = resolveOperationOptions(registerOptions);
            const requestId = crypto.randomUUID();
            return await runRallarCommand(
                (signal) =>
                    authApi.registerWithApi(request, {
                        requestId,
                        signal,
                        authSession: hasOwn(operationOptions, 'adminSession')
                            ? operationOptions.adminSession
                            : undefined,
                    }),
                operationOptions,
            );
        },
        registerAndLogin: async (
            request: RegisterRequest,
            registerOptions: RallarRegisterOptions = {},
        ): Promise<LoginResponse> => {
            await authOperations.register(request, registerOptions);
            return await authOperations.login({
                username: request.username,
                password: request.password,
            }, registerOptions);
        },
        logout: async (authOptions: RallarOperationOptions = {}) => {
            await endAuthSession('logout', {
                revoke: true,
                operationOptions: resolveOperationOptions(authOptions),
            });
        },
        restore: () => {
            const session = readSession();
            scheduleAuthExpiry(session);
            return session;
        },
        isLoggedIn: () => isLoggedIn(),
        onChange: (
            listener: RallarAuthChangeListener,
            changeOptions: RallarOnChangeOptions = {},
        ): RallarUnsubscribe => {
            authStateListeners.add(listener);
            if (changeOptions.emitCurrent ?? true) {
                const session = readSession();
                scheduleAuthExpiry(session);
                notifyListener(listener, toAuthState('current', session));
            }
            return () => authStateListeners.delete(listener);
        },
    };

    const connectionOperations: CreateRallarConnectionFacadeOptions = {
        configure: (config: RallarApiClientConfig) => {
            const nextApiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl ?? '');
            const isChanging = nextApiBaseUrl !== readApiBaseUrl();
            if (
                isChanging &&
                (options.connectionRuntime.readMiddleware() ||
                    options.connectionRuntime.readConnectPromise() || isMiddlewareReady())
            ) {
                throw new Error('Rallar must be configured before connecting.');
            }
            configureApiClient({ apiBaseUrl: nextApiBaseUrl });
        },
        setDefaults: (defaults?: RallarDefaults) => options.connectionRuntime.setDefaults(defaults),
        defaults: () => options.connectionRuntime.defaults(),
        connect,
        start: async (startOptions: RallarStartOptions = {}) => await options.start(startOptions),
        disconnect,
        status: () => options.connectionRuntime.readConnectState(),
        isConnected: () =>
            options.connectionRuntime.readConnectState() === 'connected' &&
            options.connectionRuntime.readMiddleware() !== undefined,
        session: () => readSession(),
        subscriptions: () => createRallarSubscriptionScope(),
        flow: <K, V>(policies: RallarFlowPolicies<V> = {}) =>
            CommandsOrchestrator.withPolicies<K, V>(policies),
    };

    return {
        connectionOperations,
        authOperations,
        connect,
        disconnect,
        readMiddleware: () => options.connectionRuntime.readMiddleware(),
        requireMiddleware: () => options.connectionRuntime.requireMiddleware(),
        requireSession,
        readDefaults: () => options.connectionRuntime.readDefaults(),
        readDefaultScope: () => options.connectionRuntime.readDefaultScope(),
        resolveOperationOptions,
        resolveOperationScope,
        runAuthAwareOperation,
        waitForAuthEnd,
        resolveDataScopeKey: (scope) => {
            if (scope === 'app') {
                return 'app';
            }
            if (scope === 'principal') {
                return `principal:${requireSession().clientId}`;
            }
            if (scope === 'session') {
                return `session:${requireSession().sessionId}`;
            }
            return String(scope);
        },
    };
}

function runRallarCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: RallarOperationOptions,
): Promise<T> {
    return new Command<T>(supplier, toRallarCommandOptions(options)).run();
}

function waitForRallarOperation<T>(
    promise: Promise<T>,
    options: RallarOperationOptions,
): Promise<T> {
    if (!options.signal && options.timeoutMs === undefined) {
        return promise;
    }
    return runRallarCommand(() => promise, options);
}

function isUnauthorizedApiError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'status' in error &&
        (error as { status?: unknown }).status === 401;
}

function shutdownApiMiddleware(
    ctx: ApiMiddleware | undefined,
    reason = 'rallar-disconnect',
): void {
    if (!ctx) {
        return;
    }
    runShutdownStep(() => ctx.middleware.heartbeat?.stop());
    runShutdownStep(() => ctx.middleware.rtcRxStreamer.stopAllHeartbeats());
    runShutdownStep(() => {
        for (const peerId of ctx.middleware.webRtcConnectionService.knownPeerIds()) {
            ctx.middleware.webRtcConnectionService.disconnectPeer(peerId);
        }
    });
    runShutdownStep(() => ctx.middleware.rtcRxStreamer.stopLocalMedia('all'));
    runShutdownStep(() => ctx.middleware.webRtcOverlayMulticastManager?.dispose?.());
    runShutdownStep(() => ctx.middleware.qboxEngine.stop());
    runShutdownStep(() => ctx.middleware.webSocketQueueBox.close(1000, reason));
}

function runShutdownStep(step: () => void): void {
    try {
        step();
    } catch {
        // Auth teardown is best-effort and continues through stale transports.
    }
}

function toAuthSessionKey(session: AuthSession): string {
    return `${session.clientId}:${session.sessionId}`;
}

function hasOwn<T extends object, K extends PropertyKey>(
    value: T,
    key: K,
): value is T & Record<K, unknown> {
    return Object.prototype.hasOwnProperty.call(value, key);
}
