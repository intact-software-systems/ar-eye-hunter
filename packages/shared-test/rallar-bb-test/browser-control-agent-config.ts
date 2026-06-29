import { readSession, type AuthSessionStorageKind } from '@shared/api/auth.ts';
import {
    RALLAR_BLACK_BOX_CLIENT_DEFAULTS,
    parseRallarBlackBoxProviderMode,
    type RallarBlackBoxProviderMode,
} from './client-defaults.ts';
import type {
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestError,
} from './types.ts';
import type { RallarBlackBoxGeoLocation } from './distributed-run.ts';

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
    rallarRegister: boolean | 'if-needed';
    rallarAuthStorage: AuthSessionStorageKind;
    rallarAgentSessionTicket?: string;
    rallarRestoreSession: boolean;
    rallarLogoutOnClose: boolean;
    rallarLeaveRoomOnClose: boolean;
    fleetRegion?: string;
    fleetProvider?: string;
    fleetDatacenter?: string;
    fleetHostId?: string;
    fleetAgentPoolId?: string;
    fleetDeploymentId?: string;
    fleetBrowserName?: string;
    fleetBrowserVersion?: string;
    fleetOs?: string;
    fleetTags?: readonly string[];
    fleetLatitude?: number;
    fleetLongitude?: number;
    fleetLocationLabel?: string;
    runnerAgentPrefix?: string;
    runnerAgentCount?: number;
    source: 'url' | 'environment' | 'default';
}>;

function searchParams(search: string): URLSearchParams {
    return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

function hashParams(hash: string): URLSearchParams {
    return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
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

function registerParamValue(
    value: string | undefined,
): boolean | 'if-needed' {
    if (value?.toLowerCase() === 'if-needed') {
        return 'if-needed';
    }
    return booleanParamValue(value);
}

function authStorageParamValue(
    value: string | undefined,
): AuthSessionStorageKind {
    return value?.toLowerCase() === 'session' ? 'session' : 'local';
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

function positiveIntegerParamValue(
    value: string | undefined,
    fallback: number,
): number | undefined {
    if (!value) {
        return undefined;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function coordinateParamValue(
    value: string | undefined,
    min: number,
    max: number,
): number | undefined {
    const trimmed = value?.trim();
    if (!trimmed || !isStrictDecimalNumber(trimmed)) {
        return undefined;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max
        ? parsed
        : undefined;
}

function isStrictDecimalNumber(value: string): boolean {
    return /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(value);
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
        'rallarAuthStorage',
        'rallarRestoreSession',
        'rallarLogoutOnClose',
        'rallarLeaveRoomOnClose',
        'fleetRegion',
        'fleetProvider',
        'fleetDatacenter',
        'fleetHostId',
        'fleetAgentPoolId',
        'fleetDeploymentId',
        'fleetBrowserName',
        'fleetBrowserVersion',
        'fleetOs',
        'fleetTags',
        'runnerAgentPrefix',
        'runnerAgentCount',
        'fleetLatitude',
        'fleetLongitude',
        'fleetLocationLabel',
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
        'VITE_RALLAR_AUTH_STORAGE',
        'VITE_RALLAR_RESTORE_SESSION',
        'VITE_RALLAR_LOGOUT_ON_CLOSE',
        'VITE_RALLAR_LEAVE_ROOM_ON_CLOSE',
        'VITE_RALLAR_AGENT_REGION',
        'VITE_RALLAR_AGENT_PROVIDER',
        'VITE_RALLAR_AGENT_DATACENTER',
        'VITE_RALLAR_AGENT_HOST_ID',
        'VITE_RALLAR_AGENT_POOL_ID',
        'VITE_RALLAR_AGENT_DEPLOYMENT_ID',
        'VITE_RALLAR_AGENT_BROWSER_NAME',
        'VITE_RALLAR_AGENT_BROWSER_VERSION',
        'VITE_RALLAR_AGENT_OS',
        'VITE_RALLAR_AGENT_TAGS',
        'VITE_RALLAR_RUNNER_AGENT_PREFIX',
        'VITE_RALLAR_RUNNER_AGENT_COUNT',
        'VITE_RALLAR_AGENT_LATITUDE',
        'VITE_RALLAR_AGENT_LONGITUDE',
        'VITE_RALLAR_AGENT_LOCATION_LABEL',
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
    hash = globalThis.window?.location?.hash ?? '',
): RallarBlackBoxBootstrapConfig {
    const params = searchParams(search);
    const fragmentParams = hashParams(hash);
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
    const runnerAgentCountValue = paramValue(
        params,
        env,
        'runnerAgentCount',
        'VITE_RALLAR_RUNNER_AGENT_COUNT',
    );
    const rawFleetLatitude = paramValue(
        params,
        env,
        'fleetLatitude',
        'VITE_RALLAR_AGENT_LATITUDE',
    );
    const rawFleetLongitude = paramValue(
        params,
        env,
        'fleetLongitude',
        'VITE_RALLAR_AGENT_LONGITUDE',
    );
    const fleetLatitude = coordinateParamValue(rawFleetLatitude, -90, 90);
    const fleetLongitude = coordinateParamValue(rawFleetLongitude, -180, 180);
    const hasFleetCoordinatePair =
        fleetLatitude !== undefined && fleetLongitude !== undefined;
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
        rallarRegister: registerParamValue(
            paramValue(params, env, 'rallarRegister', 'VITE_RALLAR_REGISTER'),
        ),
        rallarAuthStorage: authStorageParamValue(
            paramValue(params, env, 'rallarAuthStorage', 'VITE_RALLAR_AUTH_STORAGE'),
        ),
        rallarAgentSessionTicket: fragmentParams.get('agentSessionTicket')?.trim() ||
            undefined,
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
        fleetRegion: paramValue(params, env, 'fleetRegion', 'VITE_RALLAR_AGENT_REGION'),
        fleetProvider: paramValue(params, env, 'fleetProvider', 'VITE_RALLAR_AGENT_PROVIDER'),
        fleetDatacenter: paramValue(params, env, 'fleetDatacenter', 'VITE_RALLAR_AGENT_DATACENTER'),
        fleetHostId: paramValue(params, env, 'fleetHostId', 'VITE_RALLAR_AGENT_HOST_ID'),
        fleetAgentPoolId: paramValue(params, env, 'fleetAgentPoolId', 'VITE_RALLAR_AGENT_POOL_ID'),
        fleetDeploymentId: paramValue(params, env, 'fleetDeploymentId', 'VITE_RALLAR_AGENT_DEPLOYMENT_ID'),
        fleetBrowserName: paramValue(params, env, 'fleetBrowserName', 'VITE_RALLAR_AGENT_BROWSER_NAME'),
        fleetBrowserVersion: paramValue(params, env, 'fleetBrowserVersion', 'VITE_RALLAR_AGENT_BROWSER_VERSION'),
        fleetOs: paramValue(params, env, 'fleetOs', 'VITE_RALLAR_AGENT_OS'),
        fleetTags: splitBootstrapCsv(paramValue(params, env, 'fleetTags', 'VITE_RALLAR_AGENT_TAGS')),
        fleetLatitude: hasFleetCoordinatePair ? fleetLatitude : undefined,
        fleetLongitude: hasFleetCoordinatePair ? fleetLongitude : undefined,
        fleetLocationLabel: hasFleetCoordinatePair
            ? paramValue(params, env, 'fleetLocationLabel', 'VITE_RALLAR_AGENT_LOCATION_LABEL')
            : undefined,
        runnerAgentPrefix: paramValue(params, env, 'runnerAgentPrefix', 'VITE_RALLAR_RUNNER_AGENT_PREFIX'),
        runnerAgentCount: positiveIntegerParamValue(runnerAgentCountValue, 1),
        source: bootstrapSource(params, env),
    };
}

function splitBootstrapCsv(value: string | undefined): readonly string[] | undefined {
    if (!value) {
        return undefined;
    }
    const entries = value.split(',')
        .map(entry => entry.trim())
        .filter(Boolean);
    return entries.length > 0 ? entries : undefined;
}

export function rallarConfigFromBootstrap(
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
        ...(bootstrap.rallarRegister ? { register: bootstrap.rallarRegister } : {}),
        ...(bootstrap.rallarRestoreSession || browserAuthSessionExists()
            ? { restoreSession: true }
            : {}),
        ...(bootstrap.rallarLogoutOnClose ? { logoutOnClose: true } : {}),
        leaveRoomOnClose: bootstrap.rallarLeaveRoomOnClose,
    };
    return Object.keys(rallar).length > 0 ? rallar : undefined;
}

function browserAuthSessionExists(): boolean {
    if (typeof localStorage === 'undefined' && typeof sessionStorage === 'undefined') {
        return false;
    }

    try {
        return Boolean(readSession());
    } catch {
        return false;
    }
}

export function remoteControlConfig(
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
        fleet: bootstrapFleetMetadata(bootstrap),
    };
}

export function bootstrapFleetMetadata(
    bootstrap: RallarBlackBoxBootstrapConfig,
): Readonly<Record<string, unknown>> | undefined {
    const location = bootstrapFleetLocation(bootstrap);
    const fleet = {
        region: bootstrap.fleetRegion,
        provider: bootstrap.fleetProvider,
        datacenter: bootstrap.fleetDatacenter,
        hostId: bootstrap.fleetHostId,
        agentPoolId: bootstrap.fleetAgentPoolId,
        deploymentId: bootstrap.fleetDeploymentId,
        browserName: bootstrap.fleetBrowserName,
        browserVersion: bootstrap.fleetBrowserVersion,
        os: bootstrap.fleetOs,
        tags: bootstrap.fleetTags,
        location,
    };
    return Object.values(fleet).some(value => value !== undefined)
        ? fleet
        : undefined;
}

function bootstrapFleetLocation(
    bootstrap: RallarBlackBoxBootstrapConfig,
): RallarBlackBoxGeoLocation | undefined {
    if (bootstrap.fleetLatitude === undefined || bootstrap.fleetLongitude === undefined) {
        return undefined;
    }

    return {
        latitude: bootstrap.fleetLatitude,
        longitude: bootstrap.fleetLongitude,
        label: bootstrap.fleetLocationLabel,
        precision: 'exact',
    };
}
