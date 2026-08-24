import {
    configureApiClient,
    normalizeApiBaseUrl,
    readApiBaseUrl,
    type RallarApiClientConfig
} from '@shared-web/browser/api-client-config.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import * as authApi from '@shared-web/browser/auth/session-http-api.ts';
import { deleteBrowserALRuntimeEntriesForSession } from '@shared-web/browser/browser-al-runtime-stores.ts';
import type {
    ApiMiddleware,
    BrowserTransportRuntimePort
} from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type {
    RallarAuthChangeListener,
    RallarAuthChangeReason,
    RallarAuthFacade,
    RallarAuthState,
    RallarRegisterOptions
} from '@shared-web/browser/rallar-auth-facade.ts';
import type {
    RallarConnectionOperations,
    RallarDefaults,
    RallarScopedOperationOptions
} from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarCommandOptions, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type {
    RallarAuthRuntimePort,
    RallarBrowserFacadeRuntimeContext,
    RallarConnectionRuntimePort
} from '@shared-web/browser/rallar-runtime-context.ts';
import type { RallarLifecycleCoordinator } from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import { createRallarSubscriptionScope, notifyListener } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import type { RallarOnChangeOptions, RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import { createRallarSessionConnectionLifecycle } from '@shared-web/browser/session/session-connection-lifecycle.ts';
import type {
    AuthSession,
    LoginRequest,
    LoginResponse,
    RegisterRequest,
    RegisterResponse
} from '@shared/api/api-config.ts';
import { clearSession, isLoggedIn, readSession, writeSession } from '@shared/api/auth.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { CommandsOrchestrator } from '@shared/cache/CommandsOrchestrator.ts';

const MAX_AUTH_EXPIRY_TIMEOUT_MS = 2_147_483_647;

export type CreateRallarSessionControllerOptions = Readonly<{
    connectionRuntime: RallarConnectionRuntimePort;
    transportRuntime: BrowserTransportRuntimePort;
    authRuntime: RallarAuthRuntimePort;
    stateRuntime: Pick<RallarBrowserFacadeRuntimeContext, 'clearCurrentRoom'>;
    lifecycle: RallarLifecycleCoordinator;
    emitState(): void;
    closeDataScopes(session: AuthSession): Promise<void>;
}>;

export type RallarSessionController = Readonly<{
    connectionOperations: RallarConnectionOperations;
    authOperations: RallarAuthFacade;
    connect(options?: RallarScopedOperationOptions): Promise<ApiMiddleware>;
    disconnect(): Promise<void>;
    readMiddleware(): ApiMiddleware | undefined;
    requireMiddleware(): ApiMiddleware;
    requireSession(): AuthSession;
    readDefaults(): RallarDefaults | undefined;
    readDefaultScope(): StateScope | undefined;
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T
    ): T & RallarOperationOptions;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    runAuthAwareOperation<T>(operation: () => T | Promise<T>): Promise<T>;
    waitForAuthEnd(): Promise<void>;
}>;

export function createRallarSessionController(
    options: CreateRallarSessionControllerOptions
): RallarSessionController {
    const authStateListeners = new Set<RallarAuthChangeListener>();

    const resolveOperationOptions = <T extends RallarOperationOptions>(
        operationOptions: T
    ): T & RallarOperationOptions => options.connectionRuntime.resolveOperationOptions(operationOptions);

    const resolveOperationScope = (
        scope?: StateScope
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
        expectedSession: AuthSession
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
            session: current ?? expectedSession
        });
    };

    const toAuthState = (
        reason: RallarAuthChangeReason,
        session: AuthSession | undefined
    ): RallarAuthState => ({
        authenticated: session !== undefined,
        reason,
        session
    });

    const emitAuthState = (
        reason: RallarAuthChangeReason,
        session: AuthSession | undefined
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

    const handleAuthInvalidError = async (error: Error): Promise<void> => {
        if (!isUnauthorizedApiError(error)) {
            return;
        }
        const session = options.connectionRuntime.readMiddleware()?.session ?? readSession();
        if (!session) {
            return;
        }
        await endAuthSession('unauthorized', {
            revoke: false,
            session
        });
    };

    const connectionLifecycle = createRallarSessionConnectionLifecycle({
        connectionRuntime: options.connectionRuntime,
        transportRuntime: options.transportRuntime,
        lifecycle: options.lifecycle,
        clearCurrentRoom: options.stateRuntime.clearCurrentRoom,
        waitForAuthEnd,
        hasAuthEndInProgress: () => options.authRuntime.readAuthEndPromise() !== undefined,
        scheduleAuthExpiry: (session) => scheduleAuthExpiry(session),
        endExpiredSession: async (session) => {
            await endAuthSession('expired', { revoke: false, session });
        },
        handleAuthInvalidError
    });
    const { connect, disconnect } = connectionLifecycle;

    const runAuthAwareOperation = async <T>(
        operation: () => T | Promise<T>
    ): Promise<T> => {
        try {
            return await operation();
        }
        catch (error) {
            const operationError = toSessionError(error);
            await handleAuthInvalidError(operationError);
            throw operationError;
        }
    };

    const doEndAuthSession = async (
        reason: Exclude<RallarAuthChangeReason, 'current' | 'login'>,
        endOptions: Readonly<{
            revoke: boolean;
            operationOptions?: RallarOperationOptions;
            session?: AuthSession;
        }>
    ): Promise<void> => {
        const session = endOptions.session ??
            options.connectionRuntime.readMiddleware()?.session ?? readSession();
        let disconnectError: Error | undefined;
        let revokeError: Error | undefined;
        let dataCleanupError: Error | undefined;
        clearAuthExpiryTimer();
        clearSession();
        try {
            try {
                await disconnect();
            }
            catch (error) {
                disconnectError = toSessionError(error);
            }
            if (endOptions.revoke && session) {
                try {
                    const requestId = crypto.randomUUID();
                    await runRallarCommand(
                        (signal) =>
                            authApi.logoutFromApi({
                                requestId,
                                signal,
                                authSession: session
                            }),
                        endOptions.operationOptions ?? {}
                    );
                }
                catch (error) {
                    revokeError = toSessionError(error);
                }
            }
        }
        finally {
            if (session) {
                try {
                    await options.closeDataScopes(session);
                }
                catch (error) {
                    dataCleanupError = toSessionError(error);
                }
                try {
                    await deleteBrowserALRuntimeEntriesForSession(
                        session.sessionId
                    );
                }
                catch {
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

    async function endAuthSession(
        reason: Exclude<RallarAuthChangeReason, 'current' | 'login'>,
        endOptions: Readonly<{
            revoke: boolean;
            operationOptions?: RallarOperationOptions;
            session?: AuthSession;
        }>
    ): Promise<void> {
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
            session
        }).finally(() => {
            options.authRuntime.setAuthEndPromise(undefined);
        });
        options.authRuntime.setAuthEndPromise(promise);
        return await promise;
    }

    const authOperations: RallarAuthFacade = {
        login: async (
            request: LoginRequest,
            authOptions: RallarOperationOptions = {}
        ): Promise<LoginResponse> => {
            const operationOptions = resolveOperationOptions(authOptions);
            const requestId = crypto.randomUUID();
            const response = await runRallarCommand(
                (signal) => authApi.loginToApi(request, { requestId, signal }),
                operationOptions
            );
            if (options.connectionRuntime.readMiddleware() || options.transportRuntime.isReady()) {
                await disconnect();
            }
            const previous = readSession();
            if (previous) {
                await options.closeDataScopes(previous);
            }
            writeSession(response);
            options.authRuntime.endedAuthSessionKeys().delete(
                toAuthSessionKey(response)
            );
            scheduleAuthExpiry(response);
            emitAuthState('login', response);
            return response;
        },
        register: async (
            request: RegisterRequest,
            registerOptions: RallarRegisterOptions = {}
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
                            : undefined
                    }),
                operationOptions
            );
        },
        registerAndLogin: async (
            request: RegisterRequest,
            registerOptions: RallarRegisterOptions = {}
        ): Promise<LoginResponse> => {
            await authOperations.register(request, registerOptions);
            return await authOperations.login({
                username: request.username,
                password: request.password
            }, registerOptions);
        },
        logout: async (authOptions: RallarOperationOptions = {}) => {
            await endAuthSession('logout', {
                revoke: true,
                operationOptions: resolveOperationOptions(authOptions)
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
            changeOptions: RallarOnChangeOptions = {}
        ): RallarUnsubscribe => {
            authStateListeners.add(listener);
            if (changeOptions.emitCurrent ?? true) {
                const session = readSession();
                scheduleAuthExpiry(session);
                notifyListener(listener, toAuthState('current', session));
            }
            return () => authStateListeners.delete(listener);
        }
    };

    const connectionOperations: RallarConnectionOperations = {
        configure: (config: RallarApiClientConfig) => {
            const nextApiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl ?? '');
            const isChanging = nextApiBaseUrl !== readApiBaseUrl();
            if (
                isChanging &&
                (options.connectionRuntime.readMiddleware() ||
                    options.transportRuntime.isReady() ||
                    options.transportRuntime.isInitializing())
            ) {
                throw new Error('Rallar must be configured before connecting.');
            }
            configureApiClient({ apiBaseUrl: nextApiBaseUrl });
        },
        setDefaults: (defaults?: RallarDefaults) => options.connectionRuntime.setDefaults(defaults),
        defaults: () => options.connectionRuntime.defaults(),
        connect,
        disconnect,
        status: () => options.connectionRuntime.readConnectState(),
        isConnected: () =>
            options.connectionRuntime.readConnectState() === 'connected' &&
            options.connectionRuntime.readMiddleware() !== undefined,
        session: () => readSession(),
        subscriptions: () => createRallarSubscriptionScope(),
        flow: <K, V>(policies = {}) => CommandsOrchestrator.withPolicies<K, V>(policies)
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
        waitForAuthEnd
    };
}

function runRallarCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: RallarOperationOptions
): Promise<T> {
    return new Command<T>(supplier, toRallarCommandOptions(options)).run();
}

function isUnauthorizedApiError(error: Error): boolean {
    return error instanceof ApiHttpError && error.status === 401;
}

function toSessionError(error: unknown): Error {
    return error instanceof Error ? error : new Error('Rallar session operation failed.');
}

function toAuthSessionKey(session: AuthSession): string {
    return `${session.clientId}:${session.sessionId}`;
}

function hasOwn<T extends object, K extends PropertyKey>(
    value: T,
    key: K
): value is T & Record<K, unknown> {
    return Object.prototype.hasOwnProperty.call(value, key);
}
