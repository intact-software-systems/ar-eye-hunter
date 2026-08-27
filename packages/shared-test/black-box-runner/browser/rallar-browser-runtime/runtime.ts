import type { RallarRealtimeLaneHealth } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcDiagnostics } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { AuthSession, LoginResponse } from '@shared/api/api-config.ts';
import { throwRallarValidation } from '@shared/api/rallar-validation.ts';
import type { RallarCrdtTransportStrategy } from '@shared/crdt/mod.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';
import type { BlackBoxRallarRoomRefreshOptions, BlackBoxRallarRuntime } from './black-box-rallar-runtime-contract.ts';
import {
    createBlackBoxBrowserRallarRuntimeDependency,
    type BlackBoxBrowserRallarRuntimeDependency
} from './browser-rallar-runtime-composition.ts';
import { createBlackBoxRallarCrdtController } from './crdt-controller.ts';
import { createBlackBoxRallarConsoleDiagnostics, createBlackBoxRallarRuntimeDiagnostics } from './diagnostics.ts';
import { createBlackBoxRallarDirectorController } from './director-controller.ts';
import {
    createBlackBoxRallarLifecycleController,
    type BlackBoxRallarLifecycleOperationContext
} from './lifecycle-controller.ts';
import { createBlackBoxRallarMessagingController } from './messaging-controller.ts';
import {
    blackBoxRallarAuthenticationIdentityOf,
    blackBoxRallarConnectionOperationKeyOf,
    blackBoxRallarConnectionTargetOf,
    blackBoxRallarRoomRefOf,
    blackBoxRallarScopeDiagnosticsOf,
    blackBoxRallarScopeOf,
    decideBlackBoxRallarLifecycleRequest,
    isSameBlackBoxRallarSession,
    mergeBlackBoxRallarAuthenticationConfig
} from './policy.ts';

import type {
    BlackBoxRallarAuthenticateDiagnostics,
    BlackBoxRallarCloseDiagnostics,
    BlackBoxRallarConfig,
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarEvent,
    BlackBoxRallarHealthDiagnostics,
    BlackBoxRallarHealthInput,
    BlackBoxRallarRoomRef,
    BlackBoxRallarScope,
    BlackBoxRallarSendInput,
    BlackBoxRallarTransport
} from './contracts.ts';

export type {
    BlackBoxRallarAuthenticateDiagnostics,
    BlackBoxRallarCloseDiagnostics,
    BlackBoxRallarConfig,
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarCrdtApplyInput,
    BlackBoxRallarCrdtCommandDiagnostics,
    BlackBoxRallarCrdtHandleInput,
    BlackBoxRallarCrdtOpenInput,
    BlackBoxRallarCrdtRuntime,
    BlackBoxRallarCrdtRuntimeSummary,
    BlackBoxRallarCrdtSyncInput,
    BlackBoxRallarCrdtUndoRedoInput,
    BlackBoxRallarCrdtWaitCondition,
    BlackBoxRallarCrdtWaitInput,
    BlackBoxRallarCrdtWaitOperator,
    BlackBoxRallarDirectorAppointInput,
    BlackBoxRallarDirectorCommandDiagnostics,
    BlackBoxRallarDirectorHandleInput,
    BlackBoxRallarDirectorIntentInput,
    BlackBoxRallarDirectorOutputRecord,
    BlackBoxRallarDirectorRelayStartInput,
    BlackBoxRallarDirectorRelaySummary,
    BlackBoxRallarDirectorRoomInput,
    BlackBoxRallarDirectorRuntime,
    BlackBoxRallarDirectorStatusInput,
    BlackBoxRallarDirectorSyncRequestInput,
    BlackBoxRallarEvent,
    BlackBoxRallarHealthDiagnostics,
    BlackBoxRallarHealthInput,
    BlackBoxRallarSendDiagnostics,
    BlackBoxRallarSendInput,
    BlackBoxRallarTransport,
    BlackBoxRallarWsSendDiagnostics
} from './contracts.ts';

export type {
    BlackBoxRallarRoomRefreshOptions,
    BlackBoxRallarRuntime
} from './black-box-rallar-runtime-contract.ts';

type RuntimeSessionDiagnostic = Pick<AuthSession, 'clientId' | 'sessionId' | 'username'>;

type RuntimeState = {
    config: BlackBoxRallarConnectionConfig;
    session: RuntimeSessionDiagnostic;
    unsubscribeRealtime?: () => void;
    unsubscribeMessagesRtc?: () => void;
    unsubscribeWsLifecycle?: () => void;
    unsubscribeRtcLifecycle?: () => void;
    unsubscribeConsoleDiagnostics?: () => void;
};

type RuntimeAuthenticationState = Readonly<{
    key: string;
    config: BlackBoxRallarConnectionConfig;
    session: RuntimeSessionDiagnostic;
}>;

type RuntimeAuthenticationProvenance = Readonly<{
    key: string;
    session: RuntimeSessionDiagnostic;
}>;

type RuntimeClosePreparation = Readonly<{
    runtimeState?: RuntimeState;
    config?: BlackBoxRallarConnectionConfig;
}>;

declare global {
    interface Window {
        __blackBoxRallar?: BlackBoxRallarRuntime;
        __blackBoxRallarEmit?: (event: BlackBoxRallarEvent) => void | Promise<void>;
    }
}

const DEFAULT_LANE_ID = 'realtime';

type BlackBoxRallarRuntimeInstallation = Readonly<{
    runtime: BlackBoxRallarRuntime;
    emitRuntimeLoaded(): void;
}>;

type CreateBlackBoxRallarRuntimeOptions = Readonly<{
    facade: BlackBoxBrowserRallarRuntimeDependency;
    targetWindow: Window;
    clock?: Readonly<{
        now(): number;
    }>;
    delay?: (ms: number) => Promise<void>;
}>;

function createBlackBoxRallarRuntimeInstallation(
    options: CreateBlackBoxRallarRuntimeOptions
): BlackBoxRallarRuntimeInstallation {
    const rallar = options.facade;
    const targetWindow = options.targetWindow;
    const now = options.clock?.now ?? Date.now;
    const wait = options.delay ??
        ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))));
    let state: RuntimeState | undefined;
    let authenticationState: RuntimeAuthenticationState | undefined;
    let authenticationProvenance: RuntimeAuthenticationProvenance | undefined;
    let closeRetryConfig: BlackBoxRallarConnectionConfig | undefined;
    const runtimeDiagnostics = createBlackBoxRallarRuntimeDiagnostics({
        now,
        publish: (event) => targetWindow.__blackBoxRallarEmit?.(event),
        onPublishError: (error) => {
            console.error('black-box Rallar event sink failed', error);
        },
        transportOf,
        laneIdOf,
        scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf
    });
    const emit = runtimeDiagnostics.emit;
    const emitDiagnostic = runtimeDiagnostics.emitDiagnostic;
    const emitError = runtimeDiagnostics.emitError;
    const emitConnectPhaseStarted = runtimeDiagnostics.emitConnectPhaseStarted;
    const emitConnectPhaseCompleted = runtimeDiagnostics.emitConnectPhaseCompleted;
    const serializeError = runtimeDiagnostics.serializeError;
    const lifecycle = createBlackBoxRallarLifecycleController<
        BlackBoxRallarConnectionConfig,
        LoginResponse | AuthSession,
        BlackBoxRallarConnectDiagnostics,
        BlackBoxRallarCloseDiagnostics
    >({
        authenticationKey,
        mergeAuthenticationConfig: mergeBlackBoxRallarAuthenticationConfig,
        authenticationClosedError,
        connectionClosedError
    });
    const crdtController = createBlackBoxRallarCrdtController({
        generation: lifecycle.generation,
        operationSignal: lifecycle.operationSignal,
        isCurrent: lifecycle.isCurrent,
        facade: rallar,
        now,
        delay: wait,
        currentConnectionConfig: () => state?.config,
        ensureLiveConnection: ensureCrdtLiveConnection,
        scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf,
        emit,
        emitError
    });
    const directorController = createBlackBoxRallarDirectorController({
        generation: lifecycle.generation,
        isCurrent: lifecycle.isCurrent,
        facade: rallar,
        now,
        requireConfig: () => requireState().config,
        transportOf,
        roomRefOf: blackBoxRallarRoomRefOf,
        scopeOf: blackBoxRallarScopeOf,
        scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf,
        emit,
        emitError
    });
    const messagingController = createBlackBoxRallarMessagingController({
        generation: lifecycle.generation,
        isCurrent: lifecycle.isCurrent,
        facade: rallar,
        requireConfig: () => requireState().config,
        transportOf,
        laneIdOf,
        typeIdOf,
        topicIdOf,
        roomRefOf: blackBoxRallarRoomRefOf,
        scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf,
        toOptionalNumber,
        readHealth,
        wsStatus: wsStatusFor,
        rtcStatus: rtcStatusFor,
        emit,
        emitDiagnostic,
        emitError
    });
    const consoleDiagnostics = createBlackBoxRallarConsoleDiagnostics<BlackBoxRallarConnectionConfig>({
        console,
        activeConfig: () => state?.config,
        onWarning: runtimeDiagnostics.emitConsoleWarning,
        restoreExisting: restoreExistingConsoleWarnPatch,
        publishRestore: (restore) => {
            consoleWarnGlobalState().__blackBoxRallarRestoreConsoleWarn = restore;
        }
    });

    function transportOf(config: BlackBoxRallarConnectionConfig): BlackBoxRallarTransport {
        return config.rallar.transport ?? 'realtime';
    }

    function laneIdOf(config: BlackBoxRallarConnectionConfig): string {
        return config.rallar.laneId ?? DEFAULT_LANE_ID;
    }

    function typeIdOf(config: BlackBoxRallarConnectionConfig): string {
        const typeId = config.rallar.typeId;
        if (!typeId) {
            throw new Error('rallar.typeId is required for messages.rtc transport.');
        }

        return typeId;
    }

    function topicIdOf(config: BlackBoxRallarConnectionConfig): string | undefined {
        return config.rallar.topicId ?? config.rallar.typeId;
    }

    function toRallarDefaults(config: BlackBoxRallarConnectionConfig): Record<string, unknown> | undefined {
        const scope = blackBoxRallarScopeOf(config);
        const roomRef = blackBoxRallarRoomRefOf(config);
        const roomId = config.roomId ?? roomRef?.groupId;
        if (!scope?.applicationId) {
            return undefined;
        }

        const room = roomId || roomRef
            ? {
                ...(roomId ? { roomId } : {}),
                ...(roomRef ? { roomRef } : {})
            }
            : undefined;

        return {
            applicationId: scope.applicationId,
            ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
            ...(room ? { room } : {}),
            realtime: {
                laneId: laneIdOf(config),
                ...(config.rallar.openTimeoutMs !== undefined ? { openTimeoutMs: config.rallar.openTimeoutMs } : {})
            },
            rtc: {
                ...(config.rallar.dataChannelLanes !== undefined
                    ? { dataChannelLanes: config.rallar.dataChannelLanes }
                    : {})
            }
        };
    }

    function configureRallarApi(config: BlackBoxRallarConnectionConfig): void {
        rallar.configure({ apiBaseUrl: config.rallar.apiBaseUrl });
    }

    function configureRallarConnection(config: BlackBoxRallarConnectionConfig): Record<string, unknown> | undefined {
        configureRallarApi(config);
        const defaults = toRallarDefaults(config);
        rallar.setDefaults(defaults as any);
        return defaults;
    }

    function messageSelectorOf(config: BlackBoxRallarConnectionConfig):
        | string
        | {
            topicId?: string;
            typeId?: string;
        } {
        if (config.rallar.messageSelector) {
            return config.rallar.messageSelector;
        }

        return {
            typeId: typeIdOf(config),
            topicId: config.rallar.topicId
        };
    }

    function installConsoleDiagnostics(config: BlackBoxRallarConnectionConfig): () => void {
        return consoleDiagnostics.install(config);
    }

    function restoreExistingConsoleWarnPatch(): void {
        consoleWarnGlobalState().__blackBoxRallarRestoreConsoleWarn?.();
    }

    function consoleWarnGlobalState(): typeof globalThis & {
        __blackBoxRallarRestoreConsoleWarn?: () => void;
    } {
        return globalThis as typeof globalThis & {
            __blackBoxRallarRestoreConsoleWarn?: () => void;
        };
    }

    function toSessionDiagnostic(session: RuntimeSessionDiagnostic): RuntimeSessionDiagnostic {
        return {
            clientId: session.clientId,
            sessionId: session.sessionId,
            username: session.username
        };
    }

    function cleanupRuntimeSubscriptions(
        runtimeState: RuntimeState | undefined,
        topicConfig: BlackBoxRallarConnectionConfig | undefined
    ): number {
        let unsubscribed = 0;
        if (runtimeState?.unsubscribeMessagesRtc) {
            runtimeState.unsubscribeMessagesRtc();
            unsubscribed += 1;
        }
        if (runtimeState?.unsubscribeRealtime) {
            runtimeState.unsubscribeRealtime();
            unsubscribed += 1;
        }
        if (runtimeState?.unsubscribeRtcLifecycle) {
            runtimeState.unsubscribeRtcLifecycle();
            unsubscribed += 1;
        }
        if (runtimeState?.unsubscribeWsLifecycle) {
            runtimeState.unsubscribeWsLifecycle();
            unsubscribed += 1;
        }
        if (runtimeState?.unsubscribeConsoleDiagnostics) {
            runtimeState.unsubscribeConsoleDiagnostics();
        }
        unsubscribed += messagingController.cleanupWsSubscriptions();
        if (unsubscribed > 0 && topicConfig) {
            emitDiagnostic(topicConfig, 'rallar.browser.cleanup.unsubscribe_completed', {
                unsubscribed
            });
        }
        return unsubscribed;
    }

    function emitSessionDiagnostics(
        config: BlackBoxRallarConnectionConfig,
        session: RuntimeSessionDiagnostic,
        previousState: RuntimeState | undefined
    ): void {
        const expectedSessionId = config.rallar.expectedSessionId;
        if (expectedSessionId && expectedSessionId !== session.sessionId) {
            emitDiagnostic(config, 'rallar.browser.session.expected_mismatch', {
                expectedSessionId,
                actualSessionId: session.sessionId,
                username: session.username
            });
        }

        if (!previousState) {
            return;
        }

        if (previousState.session.sessionId === session.sessionId) {
            emitDiagnostic(config, 'rallar.browser.session.duplicate_detected', {
                session: toSessionDiagnostic(session),
                previousConnection: previousState.config.connection,
                previousRoomId: previousState.config.roomId
            });
            return;
        }

        emitDiagnostic(config, 'rallar.browser.session.active_replaced', {
            previousSession: toSessionDiagnostic(previousState.session),
            nextSession: toSessionDiagnostic(session),
            previousConnection: previousState.config.connection,
            previousRoomId: previousState.config.roomId
        });
    }

    function toOptionalNumber(value: unknown): number | undefined {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }

        const parsed = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    function requireState(): RuntimeState {
        if (!state) {
            throw new Error('Black-box Rallar runtime is not connected.');
        }
        return state;
    }

    function readHealth(config: BlackBoxRallarConnectionConfig): readonly RallarRealtimeLaneHealth[] {
        if (transportOf(config) !== 'realtime') {
            return [];
        }

        return rallar.realtime.health({
            laneIds: [laneIdOf(config)],
            peerIds: config.rallar.peerIds
        });
    }

    function wsStatusFor(): ReturnType<typeof rallar.ws.status> {
        const ws = (
            rallar as unknown as {
                ws?: { status?: () => ReturnType<typeof rallar.ws.status>; };
            }
        ).ws;
        if (ws?.status) {
            return ws.status();
        }

        const connected = rallar.isConnected();
        return {
            sessionId: rallar.session()?.sessionId,
            connectState: rallar.status(),
            readyState: connected ? 'open' : 'missing',
            isOpen: connected,
            reconnecting: false,
            reconnectEnabled: false,
            reconnectAttempts: 0,
            maxReconnectAttempts: 0,
            reconnectExhausted: false
        } as ReturnType<typeof rallar.ws.status>;
    }

    function rtcStatusFor(config: BlackBoxRallarConnectionConfig): ReturnType<typeof rallar.rtc.status> {
        const rtc = (
            rallar as unknown as {
                rtc?: {
                    status?: (options?: unknown) => ReturnType<typeof rallar.rtc.status>;
                };
            }
        ).rtc;
        if (!rtc?.status) {
            return {
                sessionId: rallar.session()?.sessionId,
                laneId: transportOf(config) === 'realtime' ? laneIdOf(config) : DEFAULT_LANE_ID,
                knownPeerIds: [],
                activePeerIds: [],
                peerIdsWithNoReconnectableLanes: [],
                readyPeerIds: [],
                peers: []
            } as ReturnType<typeof rallar.rtc.status>;
        }

        return rtc.status({
            laneId: transportOf(config) === 'realtime' ? laneIdOf(config) : undefined
        });
    }

    async function rtcDiagnosticsFor(
        config: BlackBoxRallarConnectionConfig | undefined
    ): Promise<RallarRtcDiagnostics | undefined> {
        const rtc = (
            rallar as unknown as {
                rtc?: {
                    diagnostics?: (options?: unknown) => Promise<RallarRtcDiagnostics>;
                };
            }
        ).rtc;
        if (!rtc?.diagnostics) {
            return undefined;
        }

        const laneId = config && transportOf(config) === 'realtime' ? laneIdOf(config) : undefined;
        return await rtc.diagnostics(laneId ? { laneIds: [laneId] } : undefined);
    }

    function includeRtcDiagnostics(input: BlackBoxRallarHealthInput | unknown): boolean {
        return (
            !!input && typeof input === 'object' && (input as BlackBoxRallarHealthInput).includeRtcDiagnostics === true
        );
    }

    function statusDiagnostics(config: BlackBoxRallarConnectionConfig): Record<string, unknown> {
        return {
            rallarStatus: rallar.status(),
            rallarConnected: rallar.isConnected(),
            wsStatus: wsStatusFor(),
            rtcStatus: rtcStatusFor(config)
        };
    }

    function installRallarLifecycleDiagnostics(
        config: BlackBoxRallarConnectionConfig
    ): Pick<RuntimeState, 'unsubscribeWsLifecycle' | 'unsubscribeRtcLifecycle'> {
        const ws = (
            rallar as unknown as {
                ws?: {
                    onLifecycle?: (listener: (event: unknown) => void, options?: unknown) => () => void;
                };
            }
        ).ws;
        const rtc = (
            rallar as unknown as {
                rtc?: {
                    onLifecycle?: (listener: (event: unknown) => void, options?: unknown) => () => void;
                };
            }
        ).rtc;

        return {
            unsubscribeWsLifecycle: ws?.onLifecycle
                ? ws.onLifecycle(
                    (event) => {
                        emitDiagnostic(config, 'rallar.browser.ws.lifecycle', event);
                    },
                    { emitCurrent: true }
                )
                : undefined,
            unsubscribeRtcLifecycle: rtc?.onLifecycle
                ? rtc.onLifecycle(
                    (event) => {
                        emitDiagnostic(config, 'rallar.browser.rtc.lifecycle', event);
                    },
                    { emitCurrent: true }
                )
                : undefined
        };
    }

    async function loginOrRestore(
        config: BlackBoxRallarConnectionConfig,
        signal?: AbortSignal
    ): Promise<LoginResponse | AuthSession> {
        const { username, password, displayName, register, timeoutMs } = config.rallar;
        const operationOptions = signal ? { timeoutMs, signal } : { timeoutMs };
        if (!username || !password) {
            emitDiagnostic(config, 'rallar.browser.auth.restore_started');
            const restored = rallar.auth.restore();
            if (!restored) {
                const error = new Error('Rallar credentials are required when no browser session is restored.');
                emitError(config, 'rallar.browser.auth.restore_failed', error, {
                    phase: 'auth-restore'
                });
                throw error;
            }
            emitDiagnostic(config, 'rallar.browser.auth.restore_completed', {
                session: toSessionDiagnostic(restored)
            });
            return restored;
        }

        if (register === true || register === 'if-needed') {
            emitDiagnostic(config, 'rallar.browser.auth.register_started', {
                username,
                register
            });
            try {
                const registered = await rallar.auth.registerAndLogin(
                    { username, password, displayName },
                    operationOptions
                );
                emitDiagnostic(config, 'rallar.browser.auth.register_completed', {
                    session: toSessionDiagnostic(registered)
                });
                return registered;
            }
            catch (error) {
                emitError(config, 'rallar.browser.auth.register_failed', error, {
                    phase: 'auth-register',
                    register
                });
                if (register !== 'if-needed' || signal?.aborted) {
                    throw error;
                }
                emitDiagnostic(config, 'rallar.browser.register_failed_login_fallback', {
                    error: serializeError(error)
                });
            }
        }

        emitDiagnostic(config, 'rallar.browser.auth.login_started', {
            username
        });
        try {
            const loggedIn = await rallar.auth.login({ username, password }, operationOptions);
            emitDiagnostic(config, 'rallar.browser.auth.login_completed', {
                session: toSessionDiagnostic(loggedIn)
            });
            return loggedIn;
        }
        catch (error) {
            emitError(config, 'rallar.browser.auth.login_failed', error, {
                phase: 'auth-login'
            });
            throw error;
        }
    }

    function authenticationKey(
        config: BlackBoxRallarConnectionConfig,
        username = config.rallar.username ?? ''
    ): string {
        return JSON.stringify(
            blackBoxRallarAuthenticationIdentityOf({
                apiBaseUrl: config.rallar.apiBaseUrl,
                username
            })
        );
    }

    function requireCredentialsForAuthenticationIdentityChange(config: BlackBoxRallarConnectionConfig): void {
        const hasCredentials = Boolean(config.rallar.username && config.rallar.password);
        const provenance = authenticationProvenance;
        if (hasCredentials || !provenance) {
            return;
        }

        const restored = rallar.auth.restore();
        if (!restored || !isSameAuthenticationSession(restored, provenance.session)) {
            authenticationProvenance = undefined;
            return;
        }

        const requestedKey = authenticationKey(config, config.rallar.username ?? provenance.session.username);
        if (provenance.key === requestedKey) {
            return;
        }

        throw new Error('Rallar credentials are required when the authentication identity changes.');
    }

    function isSameAuthenticationSession(left: RuntimeSessionDiagnostic, right: RuntimeSessionDiagnostic): boolean {
        return isSameBlackBoxRallarSession(left, right);
    }

    function rememberAuthentication(
        config: BlackBoxRallarConnectionConfig,
        session: LoginResponse | AuthSession
    ): void {
        const key = authenticationKey(config, session.username);
        const sessionDiagnostic = toSessionDiagnostic(session);
        const current = authenticationState;
        const effectiveConfig =
            current && current.key === key && isSameAuthenticationSession(current.session, sessionDiagnostic)
                ? mergeBlackBoxRallarAuthenticationConfig(current.config, config)
                : config;
        authenticationState = {
            key,
            config: effectiveConfig,
            session: sessionDiagnostic
        };
        authenticationProvenance = {
            key,
            session: sessionDiagnostic
        };
    }

    function adoptAuthenticationContext(
        config: BlackBoxRallarConnectionConfig,
        session: LoginResponse | AuthSession
    ): void {
        const current = authenticationState;
        if (
            !current ||
            current.key !== authenticationKey(config, session.username) ||
            !isSameAuthenticationSession(current.session, session)
        ) {
            return;
        }

        authenticationState = {
            ...current,
            config: mergeBlackBoxRallarAuthenticationConfig(current.config, config)
        };
    }

    function authenticationClosedError(): Error {
        return new Error('Authentication was cancelled because the Rallar runtime closed.');
    }

    function restoreBootstrappedSession(config: BlackBoxRallarConnectionConfig): AuthSession | undefined {
        const current = authenticationState;
        if (!current) {
            return undefined;
        }
        if (current.key !== authenticationKey(config, config.rallar.username ?? current.session.username)) {
            authenticationState = undefined;
            return undefined;
        }

        const restored = rallar.auth.restore();
        if (
            !restored ||
            restored.clientId !== current.session.clientId ||
            restored.sessionId !== current.session.sessionId ||
            restored.username !== current.session.username
        ) {
            authenticationState = undefined;
            return undefined;
        }

        emitDiagnostic(config, 'rallar.browser.auth.bootstrap_reused', {
            session: toSessionDiagnostic(restored)
        });
        return restored;
    }

    async function acquireAuthenticationSession(
        config: BlackBoxRallarConnectionConfig,
        signal: AbortSignal
    ): Promise<LoginResponse | AuthSession> {
        requireCredentialsForAuthenticationIdentityChange(config);
        const restored = restoreBootstrappedSession(config);
        if (restored) {
            return restored;
        }
        if (state) {
            throw new Error('Fresh Rallar authentication requires closing the connected black-box runtime first.');
        }

        configureRallarApi(config);
        return await loginOrRestore(config, signal);
    }

    async function sessionForAuthentication(
        config: BlackBoxRallarConnectionConfig
    ): Promise<LoginResponse | AuthSession> {
        const session = await lifecycle.runAuthentication(
            config,
            (signal) => acquireAuthenticationSession(config, signal)
        );
        rememberAuthentication(config, session);
        return session;
    }

    async function authenticate(
        config: BlackBoxRallarConnectionConfig
    ): Promise<BlackBoxRallarAuthenticateDiagnostics> {
        if (!config.rallar.apiBaseUrl) {
            const error = new Error('rallar.apiBaseUrl is required.');
            emitError(config, 'rallar.browser.authenticate_failed', error);
            throw error;
        }
        emitDiagnostic(config, 'rallar.browser.authenticate_started');
        try {
            const session = await sessionForAuthentication(config);
            adoptAuthenticationContext(config, session);
            const diagnostics: BlackBoxRallarAuthenticateDiagnostics = {
                status: 'authenticated',
                connection: config.connection,
                actor: config.actor,
                ...blackBoxRallarScopeDiagnosticsOf(config),
                clientId: session.clientId,
                sessionId: session.sessionId,
                username: session.username
            };
            emitDiagnostic(config, 'rallar.browser.authenticate_completed', diagnostics);
            return diagnostics;
        }
        catch (error) {
            emitError(config, 'rallar.browser.authenticate_failed', error);
            throw error;
        }
    }

    function connectionClosedError(): Error {
        return new Error('Connection was cancelled because the Rallar runtime closed.');
    }

    async function connectEffect(
        config: BlackBoxRallarConnectionConfig,
        context: BlackBoxRallarLifecycleOperationContext
    ): Promise<BlackBoxRallarConnectDiagnostics> {
        let phase = 'validate-config';
        let lifecycleSubscriptions:
            | Pick<RuntimeState, 'unsubscribeWsLifecycle' | 'unsubscribeRtcLifecycle'>
            | undefined;
        let unsubscribeConsoleDiagnostics: (() => void) | undefined;

        try {
            if (!config.rallar.apiBaseUrl) {
                throw new Error('rallar.apiBaseUrl is required.');
            }

            const transport = transportOf(config);

            emitDiagnostic(config, 'rallar.browser.connect_started');
            unsubscribeConsoleDiagnostics = installConsoleDiagnostics(config);

            phase = 'transport-config';
            emitConnectPhaseStarted(config, phase, { transport });
            const laneId = transport === 'realtime' ? laneIdOf(config) : undefined;
            const typeId = transport === 'messages.rtc' ? typeIdOf(config) : undefined;
            const topicId = transport === 'messages.rtc' ? topicIdOf(config) : undefined;
            emitConnectPhaseCompleted(config, phase, {
                transport,
                laneId,
                typeId,
                topicId
            });

            phase = 'configure';
            emitConnectPhaseStarted(config, phase, {
                apiBaseUrl: config.rallar.apiBaseUrl,
                ...blackBoxRallarScopeDiagnosticsOf(config)
            });
            requireCredentialsForAuthenticationIdentityChange(config);
            const defaults = configureRallarConnection(config);
            emitConnectPhaseCompleted(config, phase, {
                defaults
            });

            phase = 'auth';
            const session = state?.session ?? (await sessionForAuthentication(config));
            context.assertCurrent();
            emitDiagnostic(config, 'rallar.browser.authenticated', {
                clientId: session.clientId,
                sessionId: session.sessionId,
                username: session.username
            });
            const previousState = state;
            emitSessionDiagnostics(config, session, previousState);
            lifecycleSubscriptions = installRallarLifecycleDiagnostics(config);

            phase = 'rallar-connect';
            emitConnectPhaseStarted(config, phase, {
                timeoutMs: config.rallar.timeoutMs,
                dataChannelLanes: config.rallar.dataChannelLanes,
                ...statusDiagnostics(config)
            });
            await rallar.connect({
                timeoutMs: config.rallar.timeoutMs,
                dataChannelLanes: config.rallar.dataChannelLanes
            });
            context.assertCurrent();
            emitConnectPhaseCompleted(config, phase, {
                ...statusDiagnostics(config)
            });

            if (config.roomId) {
                const roomRef = blackBoxRallarRoomRefOf(config);
                const scope = blackBoxRallarScopeOf(config);
                phase = 'room-join';
                emitConnectPhaseStarted(config, phase, {
                    roomId: config.roomId,
                    roomRef,
                    scope
                });
                await rallar.rooms.join(config.roomId, {
                    timeoutMs: config.rallar.timeoutMs,
                    scope
                });
                context.assertCurrent();
                emitConnectPhaseCompleted(config, phase, {
                    roomId: config.roomId,
                    roomRef,
                    scope,
                    ...statusDiagnostics(config)
                });
            }

            phase = transport === 'realtime' ? 'subscribe-realtime' : 'subscribe-messages.rtc';
            emitConnectPhaseStarted(config, phase, {
                laneId,
                typeId,
                topicId,
                selector: transport === 'messages.rtc' ? messageSelectorOf(config) : undefined
            });
            const unsubscribeRealtime = transport === 'realtime'
                ? rallar.realtime.onJson(laneId ?? DEFAULT_LANE_ID, (message) => {
                    emit({
                        kind: 'message',
                        topic: 'rallar.browser.realtime.message',
                        connection: config.connection,
                        actor: config.actor,
                        transport,
                        roomId: config.roomId,
                        ...blackBoxRallarScopeDiagnosticsOf(config),
                        laneId: message.laneId,
                        peerId: session.sessionId,
                        remotePeerId: message.peerId,
                        data: message.data
                    });
                })
                : undefined;
            const unsubscribeMessagesRtc = transport === 'messages.rtc'
                ? rallar.messages.rtc.onMessage(messageSelectorOf(config), (message) => {
                    emit({
                        kind: 'message',
                        topic: 'rallar.browser.messages.rtc.message',
                        connection: config.connection,
                        actor: config.actor,
                        transport,
                        roomId: message.roomId ?? config.roomId,
                        ...blackBoxRallarScopeDiagnosticsOf(config),
                        peerId: session.sessionId,
                        remotePeerId: message.senderId,
                        senderId: message.senderId,
                        typeId: message.typeId,
                        topicId: message.topicId,
                        contextId: message.contextId,
                        resourceId: message.resourceId,
                        data: message.payload
                    });
                })
                : undefined;
            emitConnectPhaseCompleted(config, phase, {
                laneId,
                typeId,
                topicId,
                ...statusDiagnostics(config)
            });

            cleanupRuntimeSubscriptions(previousState, config);
            state = {
                config,
                session,
                unsubscribeRealtime,
                unsubscribeMessagesRtc,
                unsubscribeConsoleDiagnostics,
                ...lifecycleSubscriptions
            };

            const diagnostics: BlackBoxRallarConnectDiagnostics = {
                status: 'connected',
                connection: config.connection,
                actor: config.actor,
                transport,
                roomId: config.roomId,
                ...blackBoxRallarScopeDiagnosticsOf(config),
                clientId: session.clientId,
                sessionId: session.sessionId,
                username: session.username,
                laneId,
                typeId,
                topicId,
                wsStatus: wsStatusFor(),
                rtcStatus: rtcStatusFor(config),
                health: readHealth(config)
            };
            emitDiagnostic(config, 'rallar.browser.connect_completed', diagnostics);
            return diagnostics;
        }
        catch (error) {
            lifecycleSubscriptions?.unsubscribeRtcLifecycle?.();
            lifecycleSubscriptions?.unsubscribeWsLifecycle?.();
            unsubscribeConsoleDiagnostics?.();
            emitError(config, 'rallar.browser.connect.phase_failed', error, {
                phase
            });
            emitError(config, 'rallar.browser.connect_failed', error, {
                phase
            });
            throw error;
        }
    }

    function connectionKey(config: BlackBoxRallarConnectionConfig): string {
        return blackBoxRallarConnectionOperationKeyOf(config);
    }

    function connectedTargetRejection(config: BlackBoxRallarConnectionConfig): Error | undefined {
        if (!state) {
            return undefined;
        }
        const decision = decideBlackBoxRallarLifecycleRequest(
            {
                status: 'connected',
                activeTarget: blackBoxRallarConnectionTargetOf(state.config, state.session)
            },
            {
                kind: 'connect',
                target: blackBoxRallarConnectionTargetOf(config, state.session)
            }
        );
        return decision.kind === 'reject'
            ? new Error(decision.reason)
            : undefined;
    }

    async function ensureCrdtLiveConnection(
        config: BlackBoxRallarConnectionConfig,
        transportStrategy: RallarCrdtTransportStrategy
    ): Promise<void> {
        if (lifecycle.authenticationConfig()) {
            await lifecycle.waitForAuthentication();
            return await ensureCrdtLiveConnection(config, transportStrategy);
        }
        if (state) {
            const decision = decideBlackBoxRallarLifecycleRequest(
                {
                    status: 'connected',
                    activeTarget: blackBoxRallarConnectionTargetOf(state.config, state.session)
                },
                {
                    kind: 'connect',
                    target: blackBoxRallarConnectionTargetOf(config, state.session)
                }
            );
            if (decision.kind === 'reject') {
                throw new Error(decision.reason);
            }
        }
        await lifecycle.runExclusive('crdt-live:' + connectionKey(config), async (context) => {
            const queuedRejection = connectedTargetRejection(config);
            if (queuedRejection) {
                throw queuedRejection;
            }
            emitDiagnostic(config, 'rallar.browser.crdt.configure_started', {
                transportStrategy
            });
            const defaults = configureRallarConnection(config);
            emitDiagnostic(config, 'rallar.browser.crdt.configure_completed', {
                defaults
            });

            if (!rallar.isConnected()) {
                const session = await sessionForAuthentication(config);
                context.assertCurrent();
                await rallar.connect({
                    timeoutMs: config.rallar.timeoutMs
                });
                context.assertCurrent();
                if (config.roomId) {
                    await rallar.rooms.join(config.roomId, {
                        timeoutMs: config.rallar.timeoutMs,
                        scope: blackBoxRallarScopeOf(config)
                    });
                    context.assertCurrent();
                }
                emitDiagnostic(config, 'rallar.browser.crdt.connected', {
                    session: toSessionDiagnostic(session),
                    transportStrategy
                });
            }
        });
    }

    function connect(config: BlackBoxRallarConnectionConfig): Promise<BlackBoxRallarConnectDiagnostics> {
        const key = connectionKey(config);
        const activeAuthentication = lifecycle.authenticationConfig();
        if (activeAuthentication && authenticationKey(activeAuthentication) !== authenticationKey(config)) {
            return lifecycle.waitForAuthentication().then(
                () => connect(config),
                () => connect(config)
            );
        }

        const immediateRejection = connectedTargetRejection(config);
        if (immediateRejection) {
            return Promise.reject(immediateRejection);
        }

        return lifecycle.runConnect(key, (context) => {
            const queuedRejection = connectedTargetRejection(config);
            if (queuedRejection) {
                return Promise.reject(queuedRejection);
            }
            return connectEffect(config, context);
        });
    }

    async function closeEffect(preparation: RuntimeClosePreparation): Promise<BlackBoxRallarCloseDiagnostics> {
        const runtimeState = preparation.runtimeState;
        const config = preparation.config;
        const cleanupErrors: unknown[] = [];
        let unsubscribed = 0;
        let leftRoom = false;
        let logout = false;
        let disconnected = false;
        try {
            if (config) {
                emitDiagnostic(config, 'rallar.browser.cleanup.started', {
                    roomId: config.roomId,
                    ...blackBoxRallarScopeDiagnosticsOf(config),
                    logoutOnClose: config.rallar.logoutOnClose === true,
                    leaveRoomOnClose: config.rallar.leaveRoomOnClose !== false
                });
            }

            try {
                unsubscribed = cleanupRuntimeSubscriptions(runtimeState, config);
            }
            catch (error) {
                cleanupErrors.push(serializeError(error));
                emitError(config, 'rallar.browser.cleanup.unsubscribe_failed', error);
            }

            for (const error of directorController.closeAll(config)) {
                cleanupErrors.push(serializeError(error));
            }

            for (const error of await crdtController.closeAll(config)) {
                cleanupErrors.push(serializeError(error));
            }

            if (config?.roomId && config.rallar.leaveRoomOnClose !== false) {
                const roomRef = blackBoxRallarRoomRefOf(config);
                const scope = blackBoxRallarScopeOf(config);
                emitDiagnostic(config, 'rallar.browser.cleanup.room_leave_started', {
                    roomId: config.roomId,
                    roomRef,
                    scope
                });
                try {
                    await rallar.rooms.leave({
                        roomId: config.roomId,
                        roomRef,
                        scope,
                        clearCurrent: true,
                        timeoutMs: config.rallar.timeoutMs
                    });
                    leftRoom = true;
                    emitDiagnostic(config, 'rallar.browser.cleanup.room_leave_completed', {
                        roomId: config.roomId,
                        roomRef,
                        scope
                    });
                }
                catch (error) {
                    cleanupErrors.push(serializeError(error));
                    emitError(config, 'rallar.browser.cleanup.room_leave_failed', error, {
                        roomId: config.roomId,
                        roomRef,
                        scope
                    });
                }
            }
            else if (config) {
                emitDiagnostic(config, 'rallar.browser.cleanup.room_leave_skipped', {
                    roomId: config.roomId,
                    leaveRoomOnClose: config.rallar.leaveRoomOnClose
                });
            }

            if (config?.rallar.logoutOnClose) {
                emitDiagnostic(config, 'rallar.browser.cleanup.logout_started');
                await rallar.auth.logout({
                    timeoutMs: config.rallar.timeoutMs
                });
                logout = true;
                emitDiagnostic(config, 'rallar.browser.cleanup.logout_completed');
            }
            else {
                if (config) {
                    emitDiagnostic(config, 'rallar.browser.cleanup.disconnect_started');
                }
                await rallar.disconnect();
                disconnected = true;
                if (config) {
                    emitDiagnostic(config, 'rallar.browser.cleanup.disconnect_completed');
                }
            }
            state = undefined;
            consoleDiagnostics.close();
            const diagnostics: BlackBoxRallarCloseDiagnostics = {
                status: 'closed',
                connection: config?.connection,
                actor: config?.actor,
                transport: config ? transportOf(config) : undefined,
                roomId: config?.roomId,
                ...(config ? blackBoxRallarScopeDiagnosticsOf(config) : {}),
                unsubscribed,
                leftRoom,
                logout,
                disconnected,
                cleanupErrors
            };
            emit({
                kind: 'close',
                topic: 'rallar.browser.closed',
                connection: config?.connection,
                actor: config?.actor,
                transport: config ? transportOf(config) : undefined,
                roomId: config?.roomId,
                ...(config ? blackBoxRallarScopeDiagnosticsOf(config) : {}),
                data: diagnostics
            });
            return diagnostics;
        }
        catch (error) {
            emitError(config, 'rallar.browser.close_failed', error);
            throw error;
        }
    }

    function close(): Promise<BlackBoxRallarCloseDiagnostics> {
        const runtimeState = state;
        const activeCrdtOpens = crdtController.pending();
        const authenticatedConfig = authenticationState?.config;
        return lifecycle.close(async (context) => {
            const configs = [
                runtimeState?.config,
                authenticatedConfig,
                context.authenticationConfig,
                closeRetryConfig
            ];
            const baseConfig = configs.find(
                (config): config is BlackBoxRallarConnectionConfig => config !== undefined
            );
            const config = baseConfig
                ? configs.reduce<BlackBoxRallarConnectionConfig>(
                    (merged, candidate) =>
                        candidate
                            ? mergeBlackBoxRallarAuthenticationConfig(candidate, merged)
                            : merged,
                    baseConfig
                )
                : undefined;
            closeRetryConfig = config;
            try {
                const diagnostics = await closeEffect({ runtimeState, config });
                authenticationState = undefined;
                closeRetryConfig = undefined;
                return diagnostics;
            }
            catch (error) {
                // Cleanup already dropped this runtime's subscriptions, so it
                // must stop naming the target it tried to leave. closeRetryConfig
                // survives so a later close can still reach that target.
                state = undefined;
                authenticationState = undefined;
                throw error;
            }
        }, activeCrdtOpens);
    }

    async function health(input: BlackBoxRallarHealthInput | unknown = {}): Promise<BlackBoxRallarHealthDiagnostics> {
        const config = state?.config;
        const transport = config ? transportOf(config) : undefined;
        const rtcLaneId = transport === 'realtime' && config ? laneIdOf(config) : undefined;
        const rtcStatus = config
            ? rtcStatusFor(config)
            : ((
                rallar as unknown as {
                    rtc?: {
                        status?: (options?: unknown) => ReturnType<typeof rallar.rtc.status>;
                    };
                }
            ).rtc?.status?.({ laneId: rtcLaneId }) ??
                ({
                    sessionId: rallar.session()?.sessionId,
                    laneId: rtcLaneId ?? DEFAULT_LANE_ID,
                    knownPeerIds: [],
                    activePeerIds: [],
                    peerIdsWithNoReconnectableLanes: [],
                    readyPeerIds: [],
                    peers: []
                } as ReturnType<typeof rallar.rtc.status>));
        let rtcDiagnostics: RallarRtcDiagnostics | undefined;
        let rtcDiagnosticsError: unknown;
        if (includeRtcDiagnostics(input)) {
            try {
                rtcDiagnostics = await rtcDiagnosticsFor(config);
            }
            catch (error) {
                rtcDiagnosticsError = serializeError(error);
                emitError(config, 'rallar.browser.rtc.diagnostics_failed', error);
            }
        }
        return {
            connected: rallar.isConnected(),
            status: rallar.status(),
            wsStatus: wsStatusFor(),
            rtcStatus,
            connection: config?.connection,
            actor: config?.actor,
            transport,
            roomId: config?.roomId,
            ...(config ? blackBoxRallarScopeDiagnosticsOf(config) : {}),
            session: rallar.session(),
            health: config ? readHealth(config) : [],
            ...(rtcDiagnostics !== undefined ? { rtcDiagnostics } : {}),
            ...(rtcDiagnosticsError !== undefined ? { rtcDiagnosticsError } : {}),
            crdt: crdtController.summary(),
            director: directorController.summary()
        };
    }

    async function refreshRoom(options: BlackBoxRallarRoomRefreshOptions): Promise<void> {
        const roomRef = blackBoxRallarRoomRefOf(requireState().config);
        if (!roomRef) {
            throwRallarValidation([
                {
                    path: '$.roomRef',
                    code: 'room-ref-required',
                    message: 'Room refresh requires an exact room reference.'
                }
            ]);
        }

        await rallar.rooms.session(roomRef).refresh(options);
    }

    const runtime: BlackBoxRallarRuntime = {
        authenticate,
        connect,
        send: messagingController.send,
        sendWs: messagingController.sendWs,
        refreshRoom,
        crdt: crdtController,
        director: directorController,
        close,
        health
    };

    return {
        runtime,
        emitRuntimeLoaded: () =>
            emit({
                kind: 'diagnostic',
                topic: 'rallar.browser.runtime_loaded'
            })
    };
}

export function createBlackBoxRallarRuntime(options: CreateBlackBoxRallarRuntimeOptions): BlackBoxRallarRuntime {
    return createBlackBoxRallarRuntimeInstallation(options).runtime;
}

export function installBlackBoxRallarRuntime(targetWindow: Window): BlackBoxRallarRuntime {
    const installation = createBlackBoxRallarRuntimeInstallation({
        facade: createBlackBoxBrowserRallarRuntimeDependency(),
        targetWindow
    });
    targetWindow.__blackBoxRallar = installation.runtime;
    installation.emitRuntimeLoaded();
    return installation.runtime;
}
