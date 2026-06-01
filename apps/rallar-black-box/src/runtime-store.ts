import { useSyncExternalStore } from 'react';
import { readSession } from '@shared/api/auth.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/browser-adapter.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestError,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState,
} from '@shared-test/rallar-bb-test/types.ts';
import { RALLAR_BLACK_BOX_RECIPE_FIXTURES, } from './recipe-fixtures.ts';
import { RallarBlackBoxControlClient, type RallarBlackBoxControlSnapshot, } from './control-client.ts';
import {
    RALLAR_BLACK_BOX_CLIENT_DEFAULTS,
    parseRallarBlackBoxProviderMode,
    type RallarBlackBoxProviderMode,
} from './client-defaults.ts';
import {
    createBrowserWebSocketFactory,
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge,
} from './browser-rallar-runtime.ts';

type RuntimeStoreSnapshot = Readonly<{
    state: RallarBlackBoxTestState;
    control: RallarBlackBoxControlSnapshot;
    bootstrap: RallarBlackBoxBootstrapConfig;
    bootstrapping: boolean;
    busy: boolean;
    runState: 'waiting' | 'running' | 'passed' | 'failed' | 'cancelled' | 'reset';
    lastAction?: string;
    lastError?: string;
    loadedFixtureId?: string;
}>;

type StoreListener = () => void;

export type RallarBlackBoxBootstrapConfig = Readonly<{
    mode: 'local-workbench' | 'control-agent';
    autoConnect: boolean;
    providerMode: RallarBlackBoxProviderMode;
    controlUrl: string;
    runId: string;
    agentId: string;
    controlToken?: string;
    heartbeatIntervalMs?: number;
    statsIntervalMs?: number;
    finalReportUploadUrl?: string;
    environment: string;
    apiBaseUrl: string;
    applicationId: string;
    workspaceId: string;
    actor: string;
    sessionId: string;
    roomId: string;
    transport: 'realtime' | 'messages.rtc';
    rallarUsername?: string;
    rallarPassword?: string;
    rallarToken?: string;
    rallarRegister: boolean;
    rallarRestoreSession: boolean;
    rallarLogoutOnClose: boolean;
    rallarLeaveRoomOnClose: boolean;
    source: 'url' | 'environment' | 'default';
}>;

function initialControlSnapshot(): RallarBlackBoxControlSnapshot {
    const bootstrap = resolveRallarBlackBoxBootstrapConfig();
    return {
        state: 'idle',
        url: bootstrap.controlUrl,
        reconnectAttempt: 0,
        sentCount: 0,
        receivedCount: 0,
    };
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function searchParams(search: string): URLSearchParams {
    return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

function paramValue(
    params: URLSearchParams,
    env: Readonly<Record<string, string | undefined>>,
    paramName: string,
    envName: string,
): string | undefined {
    const fromUrl = params.get(paramName)?.trim();
    return fromUrl && fromUrl.length > 0 ? fromUrl : env[envName]?.trim() || undefined;
}

function booleanParamValue(
    value: string | undefined,
    fallback = false,
): boolean {
    if (!value) {
        return fallback;
    }

    const normalized = value.toLowerCase();
    return normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on';
}

function numberParamValue(
    value: string | undefined,
): number | undefined {
    if (!value) {
        return undefined;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function controlModeFrom(
    params: URLSearchParams,
    env: Readonly<Record<string, string | undefined>>,
): RallarBlackBoxBootstrapConfig['mode'] {
    const mode = params.get('mode') ?? env.VITE_RALLAR_BOOTSTRAP_MODE;
    return mode === 'control' || mode === 'control-agent'
        ? 'control-agent'
        : 'local-workbench';
}

function bootstrapSource(
    params: URLSearchParams,
    env: Readonly<Record<string, string | undefined>>,
): RallarBlackBoxBootstrapConfig['source'] {
    const urlKeys = [
        'mode',
        'controlUrl',
        'autoConnect',
        'provider',
        'providerMode',
        'runId',
        'agentId',
        'controlToken',
        'statsIntervalMs',
        'reportUploadUrl',
        'environment',
        'apiBaseUrl',
        'actor',
        'sessionId',
        'roomId',
        'transport',
        'rallarUsername',
        'rallarPassword',
        'rallarToken',
        'rallarRegister',
        'rallarRestoreSession',
        'rallarLogoutOnClose',
        'rallarLeaveRoomOnClose',
    ];
    if (urlKeys.some(key => params.has(key))) {
        return 'url';
    }

    const envKeys = [
        'VITE_RALLAR_BOOTSTRAP_MODE',
        'VITE_RALLAR_CONTROL_URL',
        'VITE_RALLAR_AUTO_CONNECT',
        'VITE_RALLAR_PROVIDER',
        'VITE_RALLAR_PROVIDER_MODE',
        'VITE_RALLAR_RUN_ID',
        'VITE_RALLAR_AGENT_ID',
        'VITE_RALLAR_CONTROL_TOKEN',
        'VITE_RALLAR_STATS_INTERVAL_MS',
        'VITE_RALLAR_REPORT_UPLOAD_URL',
        'VITE_RALLAR_ENVIRONMENT',
        'VITE_RALLAR_API_BASE_URL',
        'VITE_RALLAR_ACTOR',
        'VITE_RALLAR_SESSION_ID',
        'VITE_RALLAR_ROOM_ID',
        'VITE_RALLAR_TRANSPORT',
        'VITE_RALLAR_USERNAME',
        'VITE_RALLAR_PASSWORD',
        'VITE_RALLAR_TOKEN',
        'VITE_RALLAR_REGISTER',
        'VITE_RALLAR_RESTORE_SESSION',
        'VITE_RALLAR_LOGOUT_ON_CLOSE',
        'VITE_RALLAR_LEAVE_ROOM_ON_CLOSE',
    ];
    return envKeys.some(key => env[key]) ? 'environment' : 'default';
}

export function rallarBlackBoxProviderModeFromConfig(
    config: RallarBlackBoxTestConfig | undefined,
): RallarBlackBoxProviderMode {
    const control = asRecord(config?.control);
    const defaults = asRecord(config?.defaults);
    return parseRallarBlackBoxProviderMode(
        stringValue(control.providerMode) ??
        stringValue(control.provider) ??
        stringValue(defaults.providerMode) ??
        stringValue(defaults.provider),
    );
}

export function validateRallarBlackBoxProviderConfig(
    config: RallarBlackBoxTestConfig,
): RallarBlackBoxTestError | undefined {
    const providerMode = rallarBlackBoxProviderModeFromConfig(config);
    if (providerMode === 'simulated') {
        return undefined;
    }

    if (
        !config.apiBaseUrl ||
        config.apiBaseUrl === RALLAR_BLACK_BOX_CLIENT_DEFAULTS.apiBaseUrl
    ) {
        return {
            code: 'RALLAR_BLACK_BOX_PROVIDER_CONFIG_INVALID',
            message: 'browser-rallar provider requires a real Rallar API base URL.',
            details: {
                providerMode,
                apiBaseUrl: config.apiBaseUrl,
            },
        };
    }

    const rallar = asRecord(config.rallar);
    const hasLogin = Boolean(stringValue(rallar.username) && stringValue(rallar.password));
    const canRestoreSession = rallar.restoreSession === true;
    if (!hasLogin && !canRestoreSession) {
        return {
            code: 'RALLAR_BLACK_BOX_PROVIDER_CONFIG_INVALID',
            message: 'browser-rallar provider requires rallar username/password or restoreSession=true.',
            details: {
                providerMode,
                hasApiBaseUrl: true,
                hasUsernamePassword: hasLogin,
                restoreSession: canRestoreSession,
            },
        };
    }

    return undefined;
}

export function resolveRallarBlackBoxBootstrapConfig(
    search = globalThis.window?.location?.search ?? '',
    env: Readonly<Record<string, string | undefined>> =
        (import.meta as { env?: Record<string, string | undefined> }).env ?? {},
): RallarBlackBoxBootstrapConfig {
    const params = searchParams(search);
    const mode = controlModeFrom(params, env);
    const providerMode = parseRallarBlackBoxProviderMode(
        paramValue(params, env, 'provider', 'VITE_RALLAR_PROVIDER') ??
        paramValue(params, env, 'providerMode', 'VITE_RALLAR_PROVIDER_MODE'),
    );
    const controlUrl = paramValue(
        params,
        env,
        'controlUrl',
        'VITE_RALLAR_CONTROL_URL',
    ) ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.controlUrl;
    const autoConnect = booleanParamValue(
        paramValue(params, env, 'autoConnect', 'VITE_RALLAR_AUTO_CONNECT'),
        mode === 'control-agent',
    );
    const agentId = paramValue(params, env, 'agentId', 'VITE_RALLAR_AGENT_ID') ??
        RALLAR_BLACK_BOX_CLIENT_DEFAULTS.agentId;
    const transport = paramValue(params, env, 'transport', 'VITE_RALLAR_TRANSPORT');
    const runId = paramValue(params, env, 'runId', 'VITE_RALLAR_RUN_ID') ??
        (mode === 'control-agent'
            ? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.controlRunId
            : RALLAR_BLACK_BOX_CLIENT_DEFAULTS.localRunId);

    return {
        mode: autoConnect ? 'control-agent' : mode,
        autoConnect,
        providerMode,
        controlUrl,
        runId,
        agentId,
        controlToken: paramValue(params, env, 'controlToken', 'VITE_RALLAR_CONTROL_TOKEN'),
        heartbeatIntervalMs: numberParamValue(paramValue(
            params,
            env,
            'heartbeatIntervalMs',
            'VITE_RALLAR_HEARTBEAT_INTERVAL_MS',
        )),
        statsIntervalMs: numberParamValue(paramValue(
            params,
            env,
            'statsIntervalMs',
            'VITE_RALLAR_STATS_INTERVAL_MS',
        )),
        finalReportUploadUrl: paramValue(
            params,
            env,
            'reportUploadUrl',
            'VITE_RALLAR_REPORT_UPLOAD_URL',
        ),
        environment: paramValue(params, env, 'environment', 'VITE_RALLAR_ENVIRONMENT') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.environment,
        apiBaseUrl: paramValue(params, env, 'apiBaseUrl', 'VITE_RALLAR_API_BASE_URL') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.apiBaseUrl,
        applicationId: paramValue(params, env, 'applicationId', 'VITE_RALLAR_APPLICATION_ID') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.applicationId,
        workspaceId: paramValue(params, env, 'workspaceId', 'VITE_RALLAR_WORKSPACE_ID') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.workspaceId,
        actor: paramValue(params, env, 'actor', 'VITE_RALLAR_ACTOR') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.actor,
        sessionId: paramValue(params, env, 'sessionId', 'VITE_RALLAR_SESSION_ID') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.sessionId,
        roomId: paramValue(params, env, 'roomId', 'VITE_RALLAR_ROOM_ID') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.roomId,
        transport: transport === 'messages.rtc' ? 'messages.rtc' : 'realtime',
        rallarUsername: paramValue(params, env, 'rallarUsername', 'VITE_RALLAR_USERNAME'),
        rallarPassword: paramValue(params, env, 'rallarPassword', 'VITE_RALLAR_PASSWORD'),
        rallarToken: paramValue(params, env, 'rallarToken', 'VITE_RALLAR_TOKEN'),
        rallarRegister: booleanParamValue(
            paramValue(params, env, 'rallarRegister', 'VITE_RALLAR_REGISTER'),
        ),
        rallarRestoreSession: booleanParamValue(
            paramValue(params, env, 'rallarRestoreSession', 'VITE_RALLAR_RESTORE_SESSION'),
        ),
        rallarLogoutOnClose: booleanParamValue(
            paramValue(params, env, 'rallarLogoutOnClose', 'VITE_RALLAR_LOGOUT_ON_CLOSE'),
        ),
        rallarLeaveRoomOnClose: booleanParamValue(
            paramValue(params, env, 'rallarLeaveRoomOnClose', 'VITE_RALLAR_LEAVE_ROOM_ON_CLOSE'),
            true,
        ),
        source: bootstrapSource(params, env),
    };
}

function rallarConfigFromBootstrap(
    bootstrap: RallarBlackBoxBootstrapConfig,
): RallarBlackBoxTestConfig['rallar'] {
    if (bootstrap.providerMode === 'simulated') {
        return {
            username: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.demoUsername,
            password: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.demoPassword,
            token: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.demoToken,
        };
    }

    const rallar: Record<string, unknown> = {
        ...(bootstrap.rallarUsername ? { username: bootstrap.rallarUsername } : {}),
        ...(bootstrap.rallarPassword ? { password: bootstrap.rallarPassword } : {}),
        ...(bootstrap.rallarRegister ? { register: true } : {}),
        ...(bootstrap.rallarRestoreSession || browserAuthSessionExists()
            ? { restoreSession: true }
            : {}),
        ...(bootstrap.rallarLogoutOnClose ? { logoutOnClose: true } : {}),
        leaveRoomOnClose: bootstrap.rallarLeaveRoomOnClose,
    };
    return Object.keys(rallar).length > 0 ? rallar : undefined;
}

function browserAuthSessionExists(): boolean {
    if (typeof localStorage === 'undefined') {
        return false;
    }

    try {
        return Boolean(readSession());
    } catch {
        return false;
    }
}

function recordAndThrowProviderConfigError(
    runtime: RallarBlackBoxTestRuntime,
    config: RallarBlackBoxTestConfig,
): void {
    const configError = validateRallarBlackBoxProviderConfig(config);
    if (!configError) {
        return;
    }

    runtime.recordEvent({
        kind: 'diagnostic',
        topic: 'rallar.bb.provider.browser_rallar.config_invalid',
        severity: 'error',
        payload: configError,
    });
    throw new Error(configError.message);
}

function remoteControlConfig(
    bootstrap: RallarBlackBoxBootstrapConfig,
    runNumber: number,
): RallarBlackBoxTestConfig {
    const runId = bootstrap.runId || `${RALLAR_BLACK_BOX_CLIENT_DEFAULTS.controlRunId}-${runNumber}`;
    const rallar = rallarConfigFromBootstrap(bootstrap);
    return {
        runId,
        agentId: bootstrap.agentId,
        environment: bootstrap.environment,
        apiBaseUrl: bootstrap.apiBaseUrl,
        actor: bootstrap.actor,
        sessionId: bootstrap.sessionId,
        roomId: bootstrap.roomId,
        transport: bootstrap.transport,
        ...(rallar ? { rallar } : {}),
        control: {
            mode: 'remote-control',
            providerMode: bootstrap.providerMode,
            protocolVersion: 1,
            connected: bootstrap.autoConnect,
            autoConnect: bootstrap.autoConnect,
            url: bootstrap.controlUrl,
            source: bootstrap.source,
        },
        defaults: {
            timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
            connection: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.remoteConnection,
            providerMode: bootstrap.providerMode,
            applicationId: bootstrap.applicationId,
            workspaceId: bootstrap.workspaceId,
            groupId: bootstrap.roomId,
        },
    };
}

function runtimeDelayFor(command: RallarBlackBoxTestCommand): number {
    const configuredDelay = command.metadata?.localDelayMs;
    if (typeof configuredDelay === 'number' && Number.isFinite(configuredDelay)) {
        return Math.max(0, configuredDelay);
    }

    switch (command.kind) {
        case 'rtc.connect':
            return 450;
        case 'rtc.send':
            return 260;
        case 'ws.open':
        case 'http.request':
            return 340;
        case 'wait':
        case 'assert':
            return 0;
        default:
            return 160;
    }
}

function commandString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function browserRallarProviderNotReadyOutcome(
    command: RallarBlackBoxTestCommand & Readonly<{ commandId: string }>,
    context: RallarBlackBoxTestCommandContext,
): RallarBlackBoxTestCommandOutcome {
    const config = context.config();
    if (config) {
        const configError = validateRallarBlackBoxProviderConfig(config);
        if (configError) {
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.provider.browser_rallar.config_invalid',
                commandId: command.commandId,
                severity: 'error',
                payload: configError,
            });
            return {
                status: 'failed',
                error: configError,
                nextStatus: 'failed',
            };
        }
    }

    const error: RallarBlackBoxTestError = {
        code: 'RALLAR_BLACK_BOX_PROVIDER_NOT_IMPLEMENTED',
        message: 'browser-rallar provider is selected, but the real browser Rallar SPA adapter is planned for Iteration 15B.',
        details: {
            providerMode: 'browser-rallar',
            commandKind: command.kind,
        },
    };
    context.recordEvent({
        kind: 'diagnostic',
        topic: 'rallar.bb.provider.browser_rallar.not_ready',
        commandId: command.commandId,
        severity: 'error',
        payload: error,
    });
    return {
        status: 'failed',
        error,
        nextStatus: 'failed',
    };
}

function canInstallSpaBrowserRallarRuntime(): boolean {
    return typeof window !== 'undefined';
}

async function providerCommandExecutor(
    command: RallarBlackBoxTestCommand & Readonly<{ commandId: string }>,
    context: RallarBlackBoxTestCommandContext,
): Promise<RallarBlackBoxTestCommandOutcome | undefined> {
    const providerMode = rallarBlackBoxProviderModeFromConfig(context.config());
    if (providerMode === 'browser-rallar' && command.kind !== 'reset') {
        return browserRallarProviderNotReadyOutcome(command, context);
    }

    await delay(runtimeDelayFor(command));

    switch (command.kind) {
        case 'rtc.connect': {
            const config = context.config();
            const sessionId = commandString(
                command.rallar?.sessionId ?? config?.sessionId,
                'visible-session-alice',
            );
            const manualMetadata = command.metadata?.manual as Record<string, unknown> | undefined;
            const manualExpectedClients = Array.isArray(manualMetadata?.expectedClients)
                ? manualMetadata.expectedClients.map(String)
                : [];
            const expectedClients = manualExpectedClients.length > 0
                ? manualExpectedClients
                : [sessionId];
            const stageBase = {
                commandId: command.commandId,
                connection: command.connection,
                actor: command.actor,
                transport: command.transport,
                severity: 'info' as const,
            };
            const stages = [
                ['auth', 'rallar.bb.fake.connect.authenticated'],
                ['runtime-bootstrap', 'rallar.bb.fake.connect.runtime_bootstrapped'],
                ['group-join', 'rallar.bb.fake.connect.group_joined'],
                ['signaling', 'rallar.bb.fake.connect.signaling_ready'],
                ['peer-discovery', 'rallar.bb.fake.connect.peer_discovered'],
                ['data-channel', 'rallar.bb.fake.connect.data_channel_ready'],
            ] as const;
            for (const [phase, topic] of stages) {
                context.recordEvent({
                    ...stageBase,
                    kind: 'diagnostic',
                    topic,
                    payload: {
                        phase,
                        roomId: command.roomId,
                        applicationId: command.applicationId,
                        workspaceId: command.workspaceId,
                        scope: command.scope,
                        roomRef: command.roomRef,
                        minSnapshotVersion: command.minSnapshotVersion,
                        sessionId,
                        expectedClients,
                        observedClients: phase === 'peer-discovery' || phase === 'data-channel'
                            ? expectedClients
                            : [sessionId],
                        readyPeerIds: phase === 'data-channel' ? expectedClients : [],
                        activePeerIds: phase === 'data-channel' ? expectedClients : [sessionId],
                        peerCount: phase === 'peer-discovery' || phase === 'data-channel'
                            ? expectedClients.length
                            : 1,
                        laneHealth: phase === 'data-channel' ? 'open' : 'opening',
                    },
                });
            }
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.fake.rtc.connected',
                commandId: command.commandId,
                connection: command.connection,
                actor: command.actor,
                transport: command.transport,
                severity: 'info',
                payload: {
                    roomId: command.roomId,
                    applicationId: command.applicationId,
                    workspaceId: command.workspaceId,
                    scope: command.scope,
                    roomRef: command.roomRef,
                    minSnapshotVersion: command.minSnapshotVersion,
                    sessionId,
                    expectedClients,
                    observedClients: expectedClients,
                    readyPeerIds: expectedClients,
                    activePeerIds: expectedClients,
                    peerCount: expectedClients.length,
                    laneHealth: 'open',
                },
            });
            return {
                status: 'ok',
                value: {
                    providerMode,
                    connected: true,
                    connection: command.connection,
                    actor: command.actor,
                    roomId: command.roomId,
                    applicationId: command.applicationId,
                    workspaceId: command.workspaceId,
                    scope: command.scope,
                    roomRef: command.roomRef,
                    minSnapshotVersion: command.minSnapshotVersion,
                    transport: command.transport,
                    sessionId,
                    expectedClients,
                    observedClients: expectedClients,
                },
                nextStatus: context.state().status,
            };
        }
        case 'rtc.send': {
            const manualMetadata = command.metadata?.manual as Record<string, unknown> | undefined;
            const targets = Array.isArray(manualMetadata?.targets)
                ? manualMetadata.targets.map(String)
                : [];
            const deliveryMode = commandString(manualMetadata?.deliveryMode, 'direct');
            const negativeCase = typeof command.metadata?.negativeCase === 'string'
                ? command.metadata.negativeCase
                : undefined;
            if (negativeCase) {
                context.recordEvent({
                    kind: 'diagnostic',
                    topic: `rallar.bb.fake.rtc.${negativeCase}`,
                    commandId: command.commandId,
                    connection: command.connection,
                    transport: command.transport,
                    severity: negativeCase === 'not-yet-in-sync' ? 'warning' : 'error',
                    payload: {
                        negativeCase,
                        deliveryMode,
                        targets,
                        applicationId: command.applicationId,
                        workspaceId: command.workspaceId,
                        scope: command.scope,
                        roomRef: command.roomRef,
                        minSnapshotVersion: command.minSnapshotVersion,
                        nack: negativeCase === 'not-yet-in-sync'
                            ? {
                                code: 'not-yet-in-sync',
                                message: 'Snapshot is behind the minimum requested version.',
                            }
                            : undefined,
                    },
                });
            }
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.fake.rtc.send_completed',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                severity: 'info',
                payload: {
                    deliveryMode,
                    targets,
                    applicationId: command.applicationId,
                    workspaceId: command.workspaceId,
                    scope: command.scope,
                    roomRef: command.roomRef,
                    minSnapshotVersion: command.minSnapshotVersion,
                    expectedClients: targets,
                    observedClients: deliveryMode === 'broadcast' ? targets : targets,
                    readyPeerIds: targets,
                    activePeerIds: targets,
                    peerCount: targets.length,
                    laneHealth: negativeCase ? 'degraded' : 'open',
                    firstPayloadMs: runtimeDelayFor(command),
                },
            });
            context.recordEvent({
                kind: 'message',
                topic: 'rallar.bb.fake.rtc.message',
                commandId: command.commandId,
                connection: command.connection,
                transport: command.transport,
                severity: 'info',
                payload: {
                    direction: 'loopback',
                    data: command.send,
                    receivedAtEpochMs: Date.now(),
                    deliveryMode,
                    targets,
                },
            });
            return {
                status: 'ok',
                value: {
                    providerMode,
                    sent: true,
                    connection: command.connection,
                    transport: command.transport,
                    deliveryMode,
                    targets,
                    applicationId: command.applicationId,
                    workspaceId: command.workspaceId,
                    scope: command.scope,
                    roomRef: command.roomRef,
                    minSnapshotVersion: command.minSnapshotVersion,
                    payloadBytes: JSON.stringify(command.send ?? {}).length,
                },
                nextStatus: context.state().status,
            };
        }
        case 'ws.open':
            context.recordEvent({
                kind: 'diagnostic',
                topic: 'rallar.bb.fake.ws.open_skipped',
                commandId: command.commandId,
                connection: command.connection,
                transport: 'ws',
                severity: 'warning',
                payload: {
                    url: command.url,
                    reason: 'local scaffold does not open remote sockets',
                },
            });
            return {
                status: 'ok',
                value: {
                    providerMode,
                    opened: false,
                    simulated: true,
                    connection: command.connection,
                    url: command.url,
                },
                nextStatus: context.state().status,
            };
        case 'ws.send':
            context.recordEvent({
                kind: 'message',
                topic: 'rallar.bb.fake.ws.message',
                commandId: command.commandId,
                connection: command.connection,
                transport: 'ws',
                severity: 'info',
                payload: {
                    direction: 'loopback',
                    data: command.data,
                },
            });
            return {
                status: 'ok',
                value: {
                    providerMode,
                    sent: true,
                    simulated: true,
                    connection: command.connection,
                    data: command.data,
                },
                nextStatus: context.state().status,
            };
        case 'ws.close':
            context.recordEvent({
                kind: 'event',
                topic: 'rallar.bb.fake.ws.closed',
                commandId: command.commandId,
                connection: command.connection,
                transport: 'ws',
                severity: 'info',
                payload: {
                    code: command.code,
                    reason: command.reason,
                },
            });
            return {
                status: 'ok',
                value: {
                    providerMode,
                    closed: true,
                    simulated: true,
                    connection: command.connection,
                },
                nextStatus: context.state().status,
            };
        case 'http.request':
            if (!command.request.url && !command.request.path) {
                throw new Error('Local HTTP command requires request.url or request.path.');
            }
            context.recordEvent({
                kind: 'event',
                topic: 'rallar.bb.fake.http.response',
                commandId: command.commandId,
                transport: 'http',
                severity: 'info',
                payload: {
                    status: 200,
                    ok: true,
                    request: command.request,
                    body: {
                        status: 'ok',
                    },
                },
            });
            return {
                status: 'ok',
                value: {
                    providerMode,
                    status: 200,
                    ok: true,
                    simulated: true,
                    request: command.request,
                    body: {
                        status: 'ok',
                    },
                },
                nextStatus: context.state().status,
            };
        default:
            return undefined;
    }
}

class RallarBlackBoxRuntimeStore {
    private readonly runtime: RallarBlackBoxTestRuntime;
    private readonly controlClient: RallarBlackBoxControlClient;
    private readonly listeners = new Set<StoreListener>();
    private snapshot: RuntimeStoreSnapshot;
    private bootstrapStarted = false;
    private runSequence = 1;
    private bootstrapConfig = resolveRallarBlackBoxBootstrapConfig();

    constructor() {
        if (
            this.bootstrapConfig.providerMode === 'browser-rallar' &&
            canInstallSpaBrowserRallarRuntime()
        ) {
            const browserRuntime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: createSpaBrowserRallarRuntime(),
                fetch: globalThis.fetch?.bind(globalThis) as typeof fetch | undefined,
                webSocketFactory: createBrowserWebSocketFactory(),
            });
            this.runtime = browserRuntime;
            installSpaBrowserRallarEventBridge(browserRuntime);
        } else {
            this.runtime = createRallarBlackBoxTestRuntime({
                commandExecutor: providerCommandExecutor,
            });
        }
        this.snapshot = {
            state: this.runtime.state(),
            control: initialControlSnapshot(),
            bootstrap: this.bootstrapConfig,
            bootstrapping: false,
            busy: false,
            runState: 'waiting',
        };
        this.controlClient = new RallarBlackBoxControlClient({
            runtime: this.runtime,
            token: this.bootstrapConfig.controlToken,
            heartbeatIntervalMs: this.bootstrapConfig.heartbeatIntervalMs,
            statsIntervalMs: this.bootstrapConfig.statsIntervalMs,
            finalReportUploadUrl: this.bootstrapConfig.finalReportUploadUrl,
            onSnapshot: control => {
                this.snapshot = {
                    ...this.snapshot,
                    control,
                };
                this.emit();
            },
        });
        this.runtime.subscribe(state => {
            this.snapshot = {
                ...this.snapshot,
                state,
            };
            this.emit();
        });
    }

    getSnapshot = (): RuntimeStoreSnapshot => this.snapshot;

    subscribe = (listener: StoreListener): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    updateBootstrapConfig(
        patch: Partial<RallarBlackBoxBootstrapConfig>,
    ): void {
        this.bootstrapConfig = {
            ...this.bootstrapConfig,
            ...patch,
        };
        this.snapshot = {
            ...this.snapshot,
            bootstrap: this.bootstrapConfig,
        };
        this.emit();
    }

    ensureBootstrapped(): void {
        if (this.bootstrapStarted) {
            return;
        }

        this.bootstrapStarted = true;
        if (this.bootstrapConfig.mode === 'control-agent') {
            void this.bootstrapControlAgent();
            return;
        }

        if (this.bootstrapConfig.providerMode === 'browser-rallar') {
            void this.configureLocalWorkbenchOnly();
            return;
        }

        void this.runSample();
    }

    connectControl(url: string, runId?: string, agentId?: string): void {
        const config = this.runtime.state().currentConfig;
        const effectiveRunId = runId || config?.runId || `local-control-run-${this.runSequence++}`;
        const effectiveAgentId = agentId || config?.agentId || 'visible-agent-local';
        this.snapshot = {
            ...this.snapshot,
            lastAction: 'Connecting control WebSocket',
            lastError: undefined,
        };
        this.emit();
        this.controlClient.connect({
            url,
            runId: effectiveRunId,
            agentId: effectiveAgentId,
            token: this.bootstrapConfig.controlToken,
        });
    }

    disconnectControl(): void {
        this.controlClient.disconnect();
        this.snapshot = {
            ...this.snapshot,
            lastAction: 'Control WebSocket disconnected',
        };
        this.emit();
    }

    recordRuntimeEvent(
        event: RallarBlackBoxTestRuntimeEventInput,
        lastAction?: string,
    ): void {
        this.runtime.recordEvent(event);
        if (lastAction) {
            this.snapshot = {
                ...this.snapshot,
                lastAction,
            };
            this.emit();
        }
    }

    async runSample(): Promise<void> {
        try {
            await this.resetForRun('Loading local scaffold recipe');
            await this.loadRecipe(
                RALLAR_BLACK_BOX_RECIPE_FIXTURES[0].recipe,
                RALLAR_BLACK_BOX_RECIPE_FIXTURES[0].fixtureId,
            );
            await this.runLoadedRecipe();
        } catch (error) {
            this.snapshot = {
                ...this.snapshot,
                bootstrapping: false,
                busy: false,
                runState: 'failed',
                lastAction: 'Local sample failed',
                lastError: toMessage(error),
            };
            this.emit();
        }
    }

    async configureLocalWorkbenchOnly(): Promise<void> {
        try {
            const runNumber = this.runSequence++;
            this.snapshot = {
                ...this.snapshot,
                bootstrapping: true,
                busy: true,
                runState: 'waiting',
                lastAction: 'Configuring local browser-rallar workbench',
                lastError: undefined,
            };
            this.emit();

            await this.configureRuntime(runNumber);
            this.snapshot = {
                ...this.snapshot,
                bootstrapping: false,
                busy: false,
                runState: 'waiting',
                loadedFixtureId: undefined,
                lastAction: 'Local browser-rallar workbench configured',
                lastError: undefined,
            };
        } catch (error) {
            this.snapshot = {
                ...this.snapshot,
                bootstrapping: false,
                busy: false,
                runState: 'failed',
                loadedFixtureId: undefined,
                lastAction: 'Local browser-rallar workbench configuration failed',
                lastError: toMessage(error),
            };
        }

        this.emit();
    }

    async bootstrapControlAgent(): Promise<void> {
        const runNumber = this.runSequence++;
        const config = remoteControlConfig(this.bootstrapConfig, runNumber);
        this.snapshot = {
            ...this.snapshot,
            bootstrapping: true,
            busy: true,
            runState: 'waiting',
            lastAction: 'Bootstrapping remote control agent',
            lastError: undefined,
        };
        this.emit();

        try {
            await this.runtime.execute({
                kind: 'reset',
                commandId: `reset-control-${runNumber}`,
            });
            await this.runtime.execute({
                kind: 'configure',
                commandId: `configure-control-${runNumber}`,
                config,
            });
            recordAndThrowProviderConfigError(this.runtime, config);

            this.snapshot = {
                ...this.snapshot,
                bootstrapping: false,
                busy: false,
                runState: 'waiting',
                lastAction: this.bootstrapConfig.autoConnect
                    ? 'Remote control agent configured; connecting'
                    : 'Remote control agent configured',
                lastError: undefined,
            };
            this.emit();

            if (this.bootstrapConfig.autoConnect) {
                this.connectControl(
                    this.bootstrapConfig.controlUrl,
                    config.runId,
                    this.bootstrapConfig.agentId,
                );
            }
        } catch (error) {
            this.snapshot = {
                ...this.snapshot,
                bootstrapping: false,
                busy: false,
                runState: 'failed',
                lastAction: 'Remote control bootstrap failed',
                lastError: toMessage(error),
            };
            this.emit();
        }
    }

    async loadRecipeFromJson(recipeJson: string, fixtureId?: string): Promise<void> {
        const parsed = this.parseJson<RallarBlackBoxTestRecipe>(
            recipeJson,
            'Recipe JSON is invalid',
        );
        await this.loadRecipe(parsed, fixtureId);
    }

    async runLoadedRecipe(): Promise<void> {
        const runNumber = this.runSequence++;
        this.snapshot = {
            ...this.snapshot,
            busy: true,
            runState: 'running',
            lastAction: 'Running loaded local recipe',
            lastError: undefined,
        };
        this.emit();

        try {
            const result = await this.runtime.execute({
                kind: 'recipe.run',
                commandId: `recipe-run-local-${runNumber}`,
            });
            this.snapshot = {
                ...this.snapshot,
                busy: false,
                bootstrapping: false,
                runState: result.status === 'cancelled'
                    ? 'cancelled'
                    : result.ok
                        ? 'passed'
                        : 'failed',
                lastAction: result.ok
                    ? 'Local recipe completed'
                    : 'Local recipe finished with failures',
                lastError: result.error?.message,
            };
        } catch (error) {
            this.snapshot = {
                ...this.snapshot,
                busy: false,
                bootstrapping: false,
                runState: 'failed',
                lastAction: 'Local recipe failed',
                lastError: toMessage(error),
            };
        }

        this.emit();
    }

    async executeCommandFromJson(commandJson: string): Promise<void> {
        const command = this.parseJson<RallarBlackBoxTestCommand>(
            commandJson,
            'Command JSON is invalid',
        );
        await this.executeManualCommand(command, `Executing ${command.kind}`);
    }

    async executeManualCommand(
        command: RallarBlackBoxTestCommand,
        actionLabel = `Executing ${command.kind}`,
    ): Promise<void> {
        await this.executeManualCommands([command], actionLabel);
    }

    async executeManualCommands(
        commands: readonly RallarBlackBoxTestCommand[],
        actionLabel: string,
    ): Promise<void> {
        if (commands.length === 0) {
            return;
        }

        this.snapshot = {
            ...this.snapshot,
            busy: true,
            runState: 'running',
            lastAction: actionLabel,
            lastError: undefined,
        };
        this.emit();

        try {
            let failed: RallarBlackBoxTestResult | undefined;
            for (const command of commands) {
                const result = await this.runtime.execute(command);
                if (!result.ok && !failed) {
                    failed = result;
                }
            }

            this.snapshot = {
                ...this.snapshot,
                busy: false,
                runState: failed
                    ? failed.status === 'cancelled' ? 'cancelled' : 'failed'
                    : 'passed',
                lastAction: failed ? `${actionLabel} failed` : actionLabel,
                lastError: failed?.error?.message,
            };
        } catch (error) {
            this.snapshot = {
                ...this.snapshot,
                busy: false,
                runState: 'failed',
                lastAction: `${actionLabel} failed`,
                lastError: toMessage(error),
            };
        }

        this.emit();
    }

    async cancelRecipe(): Promise<void> {
        const wasBusy = this.snapshot.busy;
        this.snapshot = {
            ...this.snapshot,
            lastAction: 'Requesting recipe cancellation',
        };
        this.emit();

        const result = await this.runtime.execute({
            kind: 'recipe.cancel',
            commandId: `recipe-cancel-local-${this.runSequence++}`,
            reason: 'cancelled from local workbench',
        });
        this.snapshot = {
            ...this.snapshot,
            busy: wasBusy,
            bootstrapping: false,
            runState: result.ok ? 'cancelled' : 'failed',
            lastAction: result.ok
                ? 'Recipe cancellation requested'
                : 'Recipe cancellation failed',
            lastError: result.error?.message,
        };
        this.emit();
    }

    async resetWorkbench(): Promise<void> {
        await this.resetForRun('Workbench reset');
        this.snapshot = {
            ...this.snapshot,
            busy: false,
            bootstrapping: false,
            runState: 'reset',
            loadedFixtureId: undefined,
        };
        this.emit();
    }

    private async resetForRun(lastAction: string): Promise<void> {
        const runNumber = this.runSequence++;
        this.snapshot = {
            ...this.snapshot,
            bootstrapping: true,
            busy: true,
            runState: 'reset',
            lastAction,
            lastError: undefined,
        };
        this.emit();

        await this.runtime.execute({
            kind: 'reset',
            commandId: `reset-local-${runNumber}`,
        });
        await this.configureRuntime(runNumber);
    }

    private async configureRuntime(runNumber: number): Promise<void> {
        const rallar = rallarConfigFromBootstrap(this.bootstrapConfig);
        const config: RallarBlackBoxTestConfig = {
            runId: this.bootstrapConfig.runId,
            agentId: this.bootstrapConfig.agentId,
            environment: this.bootstrapConfig.environment,
            apiBaseUrl: this.bootstrapConfig.apiBaseUrl,
            actor: this.bootstrapConfig.actor,
            sessionId: this.bootstrapConfig.sessionId,
            roomId: this.bootstrapConfig.roomId,
            transport: this.bootstrapConfig.transport,
            ...(rallar ? { rallar } : {}),
            control: {
                mode: 'local-workbench',
                providerMode: this.bootstrapConfig.providerMode,
                protocolVersion: 1,
                connected: false,
            },
            defaults: {
                timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
                connection: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.connection,
                providerMode: this.bootstrapConfig.providerMode,
            },
        };
        await this.runtime.execute({
            kind: 'configure',
            commandId: `configure-local-${runNumber}`,
            config,
        });
        recordAndThrowProviderConfigError(this.runtime, config);
    }

    private async loadRecipe(
        recipe: RallarBlackBoxTestRecipe,
        fixtureId?: string,
    ): Promise<void> {
        const loadNumber = this.runSequence++;
        this.snapshot = {
            ...this.snapshot,
            busy: true,
            runState: 'waiting',
            lastAction: `Loading recipe ${recipe.recipeId ?? ''}`.trim(),
            lastError: undefined,
        };
        this.emit();

        const result = await this.runtime.execute({
            kind: 'recipe.load',
            commandId: `recipe-load-local-${loadNumber}`,
            recipe,
        });
        if (!result.ok) {
            this.snapshot = {
                ...this.snapshot,
                busy: false,
                bootstrapping: false,
                runState: 'failed',
                lastAction: `Recipe ${recipe.recipeId ?? ''} is invalid`.trim(),
                lastError: result.error?.message,
            };
            this.emit();
            return;
        }

        this.snapshot = {
            ...this.snapshot,
            busy: false,
            bootstrapping: false,
            runState: 'waiting',
            lastAction: `Loaded recipe ${recipe.recipeId}`,
            loadedFixtureId: fixtureId,
        };
        this.emit();
    }

    private parseJson<T>(input: string, message: string): T {
        try {
            return JSON.parse(input) as T;
        } catch (error) {
            this.snapshot = {
                ...this.snapshot,
                runState: 'failed',
                lastAction: message,
                lastError: toMessage(error),
            };
            this.emit();
            throw error;
        }
    }

    private emit(): void {
        this.listeners.forEach(listener => listener());
    }
}

export const rallarBlackBoxRuntimeStore = new RallarBlackBoxRuntimeStore();

export function useRallarBlackBoxRuntimeStore(): RuntimeStoreSnapshot {
    return useSyncExternalStore(
        rallarBlackBoxRuntimeStore.subscribe,
        rallarBlackBoxRuntimeStore.getSnapshot,
        rallarBlackBoxRuntimeStore.getSnapshot,
    );
}

function toMessage(error: unknown): string {
    return (error as RallarBlackBoxTestError | Error | undefined)?.message ??
        String(error);
}
