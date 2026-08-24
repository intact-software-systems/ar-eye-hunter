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
    RallarAuthState
} from '@shared-web/browser/rallar-auth-facade.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarCommandOptions, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarAuthRuntimePort, RallarConnectionRuntimePort } from '@shared-web/browser/rallar-runtime-context.ts';
import { notifyListener } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import type { RallarOnChangeOptions, RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { clearSession, readSession, writeSession } from '@shared/api/auth.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';

import type { RallarSessionConnectionLifecycle } from './session-connection-lifecycle.ts';

const MAX_AUTH_EXPIRY_TIMEOUT_MS = 2_147_483_647;

export interface CreateRallarSessionAuthLifecycleInput {
    readonly connectionRuntime: RallarConnectionRuntimePort;
    readonly transportRuntime: BrowserTransportRuntimePort;
    readonly authRuntime: RallarAuthRuntimePort;
    readonly connectionLifecycle: RallarSessionConnectionLifecycle;
    readonly emitState: () => void;
    readonly closeDataScopes: (session: AuthSession) => Promise<void>;
}

export interface RallarAuthSessionEndOptions {
    readonly revoke: boolean;
    readonly operationOptions?: RallarOperationOptions;
    readonly session?: AuthSession;
}

export interface RallarSessionAuthLifecycle {
    connect(options?: RallarScopedOperationOptions): Promise<ApiMiddleware>;
    disconnect(): Promise<void>;
    requireSession(): AuthSession;
    activateLoginSession(session: AuthSession): Promise<void>;
    restoreSession(): AuthSession | undefined;
    endAuthSession(
        reason: Exclude<RallarAuthChangeReason, 'current' | 'login'>,
        options: RallarAuthSessionEndOptions
    ): Promise<void>;
    handleAuthInvalidError(error: Error): Promise<void>;
    runAuthAwareOperation<T>(operation: () => T | Promise<T>): Promise<T>;
    waitForAuthEnd(): Promise<void>;
    onAuthChange(
        listener: RallarAuthChangeListener,
        options?: RallarOnChangeOptions
    ): RallarUnsubscribe;
}

export function createRallarSessionAuthLifecycle(
    input: CreateRallarSessionAuthLifecycleInput
): RallarSessionAuthLifecycle {
    return new BrowserSessionAuthLifecycle(input);
}

class BrowserSessionAuthLifecycle implements RallarSessionAuthLifecycle {
    private readonly authStateListeners = new Set<RallarAuthChangeListener>();
    private readonly input: CreateRallarSessionAuthLifecycleInput;

    public constructor(input: CreateRallarSessionAuthLifecycleInput) {
        this.input = input;
    }

    public async connect(
        scopedOptions: RallarScopedOperationOptions = {}
    ): Promise<ApiMiddleware> {
        await this.waitForAuthEnd();
        const operationOptions = this.input.connectionRuntime.resolveOperationOptions(scopedOptions);
        const scope = this.input.connectionRuntime.resolveOperationScope(operationOptions.scope);
        const session = readSession();
        await this.reconcileActiveMiddleware(session);
        if (!session) {
            throw new Error('Cannot init middleware: no auth session.');
        }
        this.scheduleAuthExpiry(session);

        const middleware = await this.input.connectionLifecycle.connect({
            sessionId: session.sessionId,
            scope,
            operationOptions,
            hasAuthEndInProgress: () => this.input.authRuntime.readAuthEndPromise() !== undefined,
            isSessionCurrent: () => readSession()?.sessionId === session.sessionId,
            onAuthInvalid: async (error) => await this.handleAuthInvalidError(error)
        });
        this.scheduleAuthExpiry(middleware.session);
        return middleware;
    }

    public disconnect(): Promise<void> {
        return this.input.connectionLifecycle.disconnect();
    }

    public requireSession(): AuthSession {
        const session = readSession();
        if (!session) {
            throw new Error('Rallar requires an auth session.');
        }
        return session;
    }

    public async activateLoginSession(session: AuthSession): Promise<void> {
        if (
            this.input.connectionRuntime.readMiddleware() ||
            this.input.transportRuntime.isReady() ||
            this.input.transportRuntime.isInitializing()
        ) {
            await this.disconnect();
        }
        const previousSession = readSession();
        if (previousSession) {
            await this.input.closeDataScopes(previousSession);
        }
        writeSession(session);
        this.input.authRuntime.endedAuthSessionKeys().delete(toAuthSessionKey(session));
        this.scheduleAuthExpiry(session);
        this.emitAuthState('login', session);
    }

    public restoreSession(): AuthSession | undefined {
        const session = readSession();
        this.scheduleAuthExpiry(session);
        return session;
    }

    public async endAuthSession(
        reason: Exclude<RallarAuthChangeReason, 'current' | 'login'>,
        options: RallarAuthSessionEndOptions
    ): Promise<void> {
        const session = this.resolveSession(options.session);
        const sessionKey = session ? toAuthSessionKey(session) : undefined;
        const currentEnd = this.input.authRuntime.readAuthEndPromise();
        if (currentEnd) {
            return await currentEnd;
        }
        if (sessionKey && this.input.authRuntime.endedAuthSessionKeys().has(sessionKey)) {
            return;
        }
        if (sessionKey) {
            this.input.authRuntime.endedAuthSessionKeys().add(sessionKey);
        }

        const authEnd = this.terminateAuthSession(reason, { ...options, session })
            .finally(() => this.input.authRuntime.setAuthEndPromise(undefined));
        this.input.authRuntime.setAuthEndPromise(authEnd);
        return await authEnd;
    }

    public async handleAuthInvalidError(error: Error): Promise<void> {
        if (!(error instanceof ApiHttpError) || error.status !== 401) {
            return;
        }
        const session = this.resolveSession();
        if (session) {
            await this.endAuthSession('unauthorized', { revoke: false, session });
        }
    }

    public async runAuthAwareOperation<T>(
        operation: () => T | Promise<T>
    ): Promise<T> {
        try {
            return await operation();
        }
        catch (error) {
            const operationError = error instanceof Error
                ? error
                : new Error('Rallar session operation failed.');
            await this.handleAuthInvalidError(operationError);
            throw operationError;
        }
    }

    public async waitForAuthEnd(): Promise<void> {
        const authEnd = this.input.authRuntime.readAuthEndPromise();
        if (authEnd) {
            await authEnd;
        }
    }

    public onAuthChange(
        listener: RallarAuthChangeListener,
        options: RallarOnChangeOptions = {}
    ): RallarUnsubscribe {
        this.authStateListeners.add(listener);
        if (options.emitCurrent ?? true) {
            const session = readSession();
            this.scheduleAuthExpiry(session);
            notifyListener(listener, toAuthState('current', session));
        }
        return () => this.authStateListeners.delete(listener);
    }

    private async reconcileActiveMiddleware(session: AuthSession | undefined): Promise<void> {
        const activeMiddleware = this.input.connectionRuntime.readMiddleware();
        if (activeMiddleware && !session) {
            await this.endAuthSession('expired', {
                revoke: false,
                session: activeMiddleware.session
            });
        }
        else if (
            activeMiddleware &&
            session &&
            activeMiddleware.session.sessionId !== session.sessionId
        ) {
            await this.disconnect();
        }
    }

    private scheduleAuthExpiry(session: AuthSession | undefined): void {
        this.input.authRuntime.clearAuthExpiryTimer();
        if (!session) {
            return;
        }
        const delayMs = Math.max(0, session.expiresAtEpochMs - Date.now());
        this.input.authRuntime.setAuthExpiryTimer(
            setTimeout(
                () => void this.expireAuthSessionIfCurrent(session),
                Math.min(delayMs, MAX_AUTH_EXPIRY_TIMEOUT_MS)
            )
        );
    }

    private async expireAuthSessionIfCurrent(expectedSession: AuthSession): Promise<void> {
        const currentSession = readSession();
        if (currentSession && currentSession.sessionId !== expectedSession.sessionId) {
            this.scheduleAuthExpiry(currentSession);
            return;
        }
        if (currentSession && currentSession.expiresAtEpochMs > Date.now()) {
            this.scheduleAuthExpiry(currentSession);
            return;
        }
        await this.endAuthSession('expired', {
            revoke: false,
            session: currentSession ?? expectedSession
        });
    }

    private async terminateAuthSession(
        reason: Exclude<RallarAuthChangeReason, 'current' | 'login'>,
        options: RallarAuthSessionEndOptions
    ): Promise<void> {
        const session = options.session;
        this.input.authRuntime.clearAuthExpiryTimer();
        clearSession();
        const disconnectError = await captureError(() => this.disconnect());
        const revokeError = options.revoke && session
            ? await captureError(() => revokeAuthSession(session, options.operationOptions))
            : undefined;
        const dataCleanupError = session
            ? await this.cleanupEndedSession(session)
            : undefined;
        this.input.emitState();
        this.emitAuthState(reason, undefined);

        const failure = disconnectError ?? revokeError ?? dataCleanupError;
        if (failure) {
            throw failure;
        }
    }

    private async cleanupEndedSession(session: AuthSession): Promise<Error | undefined> {
        const dataCleanupError = await captureError(() => this.input.closeDataScopes(session));
        try {
            await deleteBrowserALRuntimeEntriesForSession(session.sessionId);
        }
        catch {
            // Browser-local AL cleanup is best-effort.
        }
        return dataCleanupError;
    }

    private resolveSession(session?: AuthSession): AuthSession | undefined {
        return session ??
            this.input.connectionRuntime.readMiddleware()?.session ??
            readSession();
    }

    private emitAuthState(
        reason: RallarAuthChangeReason,
        session: AuthSession | undefined
    ): void {
        const state = toAuthState(reason, session);
        for (const listener of this.authStateListeners) {
            notifyListener(listener, state);
        }
    }
}

async function revokeAuthSession(
    session: AuthSession,
    operationOptions: RallarOperationOptions = {}
): Promise<void> {
    const requestId = crypto.randomUUID();
    await new Command(
        (signal) => authApi.logoutFromApi({ requestId, signal, authSession: session }),
        toRallarCommandOptions(operationOptions)
    ).run();
}

async function captureError(operation: () => Promise<void>): Promise<Error | undefined> {
    try {
        await operation();
        return undefined;
    }
    catch (error) {
        return error instanceof Error
            ? error
            : new Error('Rallar session operation failed.');
    }
}

function toAuthState(
    reason: RallarAuthChangeReason,
    session: AuthSession | undefined
): RallarAuthState {
    return { authenticated: session !== undefined, reason, session };
}

function toAuthSessionKey(session: AuthSession): string {
    return `${session.clientId}:${session.sessionId}`;
}
