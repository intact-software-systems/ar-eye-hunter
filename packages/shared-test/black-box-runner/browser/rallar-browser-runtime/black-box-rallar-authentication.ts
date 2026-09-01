import type { AuthSession, LoginRequest, LoginResponse, RegisterRequest } from '@shared/api/api-config.ts';
import { toError } from '@shared/resilience/to-error.ts';
import {
    toBlackBoxRallarAuthenticationKey,
    toBlackBoxRallarSessionDiagnostic
} from './black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarConnectionState } from './black-box-rallar-connection-state.ts';
import type { BlackBoxRallarRuntimeDiagnostics } from './black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarAuthenticateDiagnostics,
    BlackBoxRallarCloseDiagnostics,
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig
} from './black-box-rallar-operation-contracts.ts';
import {
    blackBoxRallarScopeDiagnosticsOf,
    isSameBlackBoxRallarSession,
    mergeBlackBoxRallarAuthenticationConfig
} from './black-box-rallar-operation-policy.ts';
import { toBlackBoxRallarSerializedError } from './black-box-rallar-serialized-error.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from './browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarLifecycleController } from './lifecycle-controller.ts';
export namespace BlackBoxRallarAuthentication {
    export interface State {
        readonly key: string;
        readonly config: BlackBoxRallarConnectionConfig;
        readonly session: BlackBoxRallarConnectionState.Session;
    }
    export interface Provenance {
        readonly key: string;
        readonly session: BlackBoxRallarConnectionState.Session;
    }
    export interface Dependencies {
        readonly rallar: BlackBoxBrowserRallarRuntimeDependency;
        readonly runtimeDiagnostics: BlackBoxRallarRuntimeDiagnostics;
        readonly lifecycle: BlackBoxRallarLifecycleController<
            BlackBoxRallarConnectionConfig,
            LoginResponse | AuthSession,
            BlackBoxRallarConnectDiagnostics,
            BlackBoxRallarCloseDiagnostics
        >;
        readonly connectionState: BlackBoxRallarConnectionState;
    }
}
export class BlackBoxRallarAuthentication {
    #authenticationState: BlackBoxRallarAuthentication.State | undefined;
    #authenticationProvenance: BlackBoxRallarAuthentication.Provenance | undefined;
    readonly #dependencies: BlackBoxRallarAuthentication.Dependencies;
    constructor(dependencies: BlackBoxRallarAuthentication.Dependencies) {
        this.#dependencies = dependencies;
    }
    getConfig(): BlackBoxRallarConnectionConfig | undefined {
        return this.#authenticationState?.config;
    }
    clear(): void {
        this.#authenticationState = undefined;
    }
    #loginOrRestore = async (
        config: BlackBoxRallarConnectionConfig,
        signal?: AbortSignal
    ): Promise<LoginResponse | AuthSession> => {
        const { username, password, displayName, register } = config.rallar;
        if (!username || !password) {
            return this.#restoreRequiredSession(config);
        }
        if (register === true || register === 'if-needed') {
            const registered = await this.#tryRegistration(config, { username, password, displayName }, signal);
            if (registered) {
                return registered;
            }
        }
        return this.#login(config, { username, password }, signal);
    };
    async #tryRegistration(
        config: BlackBoxRallarConnectionConfig,
        credentials: RegisterRequest,
        signal?: AbortSignal
    ): Promise<LoginResponse | undefined> {
        const { register, timeoutMs } = config.rallar;
        this.#dependencies.runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.auth.register_started', {
            username: credentials.username,
            register
        });
        try {
            const registered = await this.#dependencies.rallar.auth.registerAndLogin(
                credentials,
                signal ? { timeoutMs, signal } : { timeoutMs }
            );
            this.#dependencies.runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.auth.register_completed', {
                session: toBlackBoxRallarSessionDiagnostic(registered)
            });
            return registered;
        }
        catch (caught) {
            const error = toError(caught);
            this.#dependencies.runtimeDiagnostics.emitError({
                config,
                topic: 'rallar.browser.auth.register_failed',
                error,
                data: { phase: 'auth-register', register }
            });
            if (register !== 'if-needed' || signal?.aborted) {
                throw error;
            }
            this.#dependencies.runtimeDiagnostics.emitDiagnostic(
                config,
                'rallar.browser.register_failed_login_fallback',
                { error: toBlackBoxRallarSerializedError(error) }
            );
            return undefined;
        }
    }
    async #login(
        config: BlackBoxRallarConnectionConfig,
        credentials: LoginRequest,
        signal?: AbortSignal
    ): Promise<LoginResponse> {
        const { timeoutMs } = config.rallar;
        this.#dependencies.runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.auth.login_started', {
            username: credentials.username
        });
        try {
            const loggedIn = await this.#dependencies.rallar.auth.login(
                credentials,
                signal ? { timeoutMs, signal } : { timeoutMs }
            );
            this.#dependencies.runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.auth.login_completed', {
                session: toBlackBoxRallarSessionDiagnostic(loggedIn)
            });
            return loggedIn;
        }
        catch (caught) {
            const error = toError(caught);
            this.#dependencies.runtimeDiagnostics.emitError({
                config,
                topic: 'rallar.browser.auth.login_failed',
                error,
                data: { phase: 'auth-login' }
            });
            throw error;
        }
    }
    #restoreRequiredSession(config: BlackBoxRallarConnectionConfig): AuthSession {
        this.#dependencies.runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.auth.restore_started');
        const restored = this.#dependencies.rallar.auth.restore();
        if (!restored) {
            const error = new Error('Rallar credentials are required when no browser session is restored.');
            this.#dependencies.runtimeDiagnostics.emitError({
                config: config,
                topic: 'rallar.browser.auth.restore_failed',
                error: error,
                data: {
                    phase: 'auth-restore'
                }
            });
            throw error;
        }
        this.#dependencies.runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.auth.restore_completed', {
            session: toBlackBoxRallarSessionDiagnostic(restored)
        });
        return restored;
    }
    requireCredentialsForAuthenticationIdentityChange = (config: BlackBoxRallarConnectionConfig): void => {
        const hasCredentials = Boolean(config.rallar.username && config.rallar.password);
        const provenance = this.#authenticationProvenance;
        if (hasCredentials || !provenance) {
            return;
        }

        const restored = this.#dependencies.rallar.auth.restore();
        if (!restored || !isSameBlackBoxRallarSession(restored, provenance.session)) {
            this.#authenticationProvenance = undefined;
            return;
        }

        const requestedKey = toBlackBoxRallarAuthenticationKey(
            config,
            config.rallar.username ?? provenance.session.username
        );
        if (provenance.key === requestedKey) {
            return;
        }

        throw new Error('Rallar credentials are required when the authentication identity changes.');
    };
    #rememberAuthentication = (
        config: BlackBoxRallarConnectionConfig,
        session: LoginResponse | AuthSession
    ): void => {
        const key = toBlackBoxRallarAuthenticationKey(config, session.username);
        const sessionDiagnostic = toBlackBoxRallarSessionDiagnostic(session);
        const current = this.#authenticationState;
        const effectiveConfig =
            current && current.key === key && isSameBlackBoxRallarSession(current.session, sessionDiagnostic)
                ? mergeBlackBoxRallarAuthenticationConfig(current.config, config)
                : config;
        this.#authenticationState = {
            key,
            config: effectiveConfig,
            session: sessionDiagnostic
        };
        this.#authenticationProvenance = {
            key,
            session: sessionDiagnostic
        };
    };
    #adoptAuthenticationContext = (
        config: BlackBoxRallarConnectionConfig,
        session: LoginResponse | AuthSession
    ): void => {
        const current = this.#authenticationState;
        if (
            !current ||
            current.key !== toBlackBoxRallarAuthenticationKey(config, session.username) ||
            !isSameBlackBoxRallarSession(current.session, session)
        ) {
            return;
        }

        this.#authenticationState = {
            ...current,
            config: mergeBlackBoxRallarAuthenticationConfig(current.config, config)
        };
    };
    #restoreBootstrappedSession = (config: BlackBoxRallarConnectionConfig): AuthSession | undefined => {
        const current = this.#authenticationState;
        if (!current) {
            return undefined;
        }
        if (
            current.key !==
                toBlackBoxRallarAuthenticationKey(config, config.rallar.username ?? current.session.username)
        ) {
            this.#authenticationState = undefined;
            return undefined;
        }

        const restored = this.#dependencies.rallar.auth.restore();
        if (
            !restored ||
            restored.clientId !== current.session.clientId ||
            restored.sessionId !== current.session.sessionId ||
            restored.username !== current.session.username
        ) {
            this.#authenticationState = undefined;
            return undefined;
        }

        this.#dependencies.runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.auth.bootstrap_reused', {
            session: toBlackBoxRallarSessionDiagnostic(restored)
        });
        return restored;
    };
    #acquireAuthenticationSession = async (
        config: BlackBoxRallarConnectionConfig,
        signal: AbortSignal
    ): Promise<LoginResponse | AuthSession> => {
        this.requireCredentialsForAuthenticationIdentityChange(config);
        const restored = this.#restoreBootstrappedSession(config);
        if (restored) {
            return restored;
        }
        if (this.#dependencies.connectionState.get()) {
            throw new Error('Fresh Rallar authentication requires closing the connected black-box runtime first.');
        }

        this.#dependencies.rallar.configure({ apiBaseUrl: config.rallar.apiBaseUrl });
        return await this.#loginOrRestore(config, signal);
    };
    sessionForAuthentication = async (
        config: BlackBoxRallarConnectionConfig
    ): Promise<LoginResponse | AuthSession> => {
        const session = await this.#dependencies.lifecycle.runAuthentication(
            config,
            (signal) => this.#acquireAuthenticationSession(config, signal)
        );
        this.#rememberAuthentication(config, session);
        return session;
    };
    authenticate = async (
        config: BlackBoxRallarConnectionConfig
    ): Promise<BlackBoxRallarAuthenticateDiagnostics> => {
        if (!config.rallar.apiBaseUrl) {
            const error = new Error('rallar.apiBaseUrl is required.');
            this.#dependencies.runtimeDiagnostics.emitError({
                config: config,
                topic: 'rallar.browser.authenticate_failed',
                error: error
            });
            throw error;
        }
        this.#dependencies.runtimeDiagnostics.emitDiagnostic(config, 'rallar.browser.authenticate_started');
        try {
            const session = await this.sessionForAuthentication(config);
            this.#adoptAuthenticationContext(config, session);
            const diagnostics: BlackBoxRallarAuthenticateDiagnostics = {
                status: 'authenticated',
                connection: config.connection,
                actor: config.actor,
                ...blackBoxRallarScopeDiagnosticsOf(config),
                clientId: session.clientId,
                sessionId: session.sessionId,
                username: session.username
            };
            this.#dependencies.runtimeDiagnostics.emitDiagnostic(
                config,
                'rallar.browser.authenticate_completed',
                diagnostics
            );
            return diagnostics;
        }
        catch (caught) {
            const error = toError(caught);
            this.#dependencies.runtimeDiagnostics.emitError({
                config: config,
                topic: 'rallar.browser.authenticate_failed',
                error: error
            });
            throw error;
        }
    };
}
