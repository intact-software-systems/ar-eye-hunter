import type { AuthSessionStorageKind } from '@shared/api/auth.ts';
import {
    RALLAR_BLACK_BOX_CLIENT_DEFAULTS,
    resolveRallarBlackBoxProviderMode,
    type RallarBlackBoxProviderMode
} from './client-defaults.ts';
import type { RallarBlackBoxGeoLocation } from './distributed-run.ts';

export type RallarBlackBoxBootstrapEnvironment = Readonly<Record<string, string | undefined>>;

export interface RallarBlackBoxBootstrapConfig {
    readonly mode: 'local-workbench' | 'control-agent';
    readonly autoConnect: boolean;
    readonly providerMode: RallarBlackBoxProviderMode;
    readonly controlUrl: string;
    readonly runId: string;
    readonly agentId: string;
    /** Absent when the launch carries no control token, so the control server admits the agent without one. */
    readonly controlToken?: string;
    readonly heartbeatIntervalMs: number;
    /** Zero turns periodic stats off. */
    readonly statsIntervalMs: number;
    /** Absent when the agent sends its final report only over the control WebSocket. */
    readonly finalReportUploadUrl?: string;
    readonly environment: string;
    readonly apiBaseUrl: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly actor: string;
    readonly sessionId: string;
    readonly roomId: string;
    readonly transport: 'realtime' | 'messages.rtc';
    /** Absent when the launch names no Rallar user to sign in as. */
    readonly rallarUsername?: string;
    /** Absent when the launch carries no Rallar password to sign in with. */
    readonly rallarPassword?: string;
    /** Absent when the launch carries no Rallar access token. */
    readonly rallarToken?: string;
    readonly rallarRegister: boolean | 'if-needed';
    readonly rallarAuthStorage: AuthSessionStorageKind;
    /** Absent when the launch fragment carries no one-time agent session ticket. */
    readonly rallarAgentSessionTicket?: string;
    readonly rallarRestoreSession: boolean;
    readonly rallarLogoutOnClose: boolean;
    readonly rallarLeaveRoomOnClose: boolean;
    /** Absent when the launch names no fleet region. */
    readonly fleetRegion?: string;
    /** Absent when the launch names no hosting provider. */
    readonly fleetProvider?: string;
    /** Absent when the launch names no datacenter. */
    readonly fleetDatacenter?: string;
    /** Absent when the launch names no host. */
    readonly fleetHostId?: string;
    /** Absent when the launch names no agent pool. */
    readonly fleetAgentPoolId?: string;
    /** Absent when the launch names no deployment. */
    readonly fleetDeploymentId?: string;
    /** Absent when the launch names no browser. */
    readonly fleetBrowserName?: string;
    /** Absent when the launch names no browser version. */
    readonly fleetBrowserVersion?: string;
    /** Absent when the launch names no operating system. */
    readonly fleetOs?: string;
    /** Absent when the launch lists no fleet tags. */
    readonly fleetTags?: readonly string[];
    /** Absent when the launch names no usable latitude and longitude pair. */
    readonly fleetLocation?: RallarBlackBoxGeoLocation;
    /** Absent when the launch names no agent prefix, so the runner names launched agents after the signed-in user. */
    readonly runnerAgentPrefix?: string;
    readonly runnerAgentCount: number;
    readonly source: 'url' | 'environment' | 'default';
}

interface BootstrapSources {
    readonly params: URLSearchParams;
    readonly env: RallarBlackBoxBootstrapEnvironment;
}

const STRICT_DECIMAL_NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;
const TRUE_TEXTS = ['1', 'true', 'yes', 'on'];

const BOOTSTRAP_URL_KEYS = [
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
    'fleetLocationLabel'
];

const BOOTSTRAP_ENV_KEYS = [
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
    'VITE_RALLAR_AGENT_LOCATION_LABEL'
];

/** Reads the launch URL and the Vite environment of the current page. */
export function readRallarBlackBoxBootstrapConfig(): RallarBlackBoxBootstrapConfig {
    return resolveRallarBlackBoxBootstrapConfig(
        globalThis.window?.location?.search ?? '',
        (import.meta as { env?: RallarBlackBoxBootstrapEnvironment; }).env ?? {},
        globalThis.window?.location?.hash ?? ''
    );
}

export function resolveRallarBlackBoxBootstrapConfig(
    search: string,
    env: RallarBlackBoxBootstrapEnvironment,
    hash: string
): RallarBlackBoxBootstrapConfig {
    const sources: BootstrapSources = { params: toLaunchParams(search, '?'), env };
    const fragment = toLaunchParams(hash, '#');
    return {
        ...resolveControlTargetBootstrap(sources),
        ...resolveControlReportingBootstrap(sources, fragment),
        ...resolveRallarScopeBootstrap(sources),
        ...resolveRallarAuthBootstrap(sources, fragment),
        ...resolveFleetBootstrap(sources),
        runnerAgentPrefix: resolveLaunchText(sources, 'runnerAgentPrefix', 'VITE_RALLAR_RUNNER_AGENT_PREFIX'),
        runnerAgentCount: toPositiveInteger(
            resolveLaunchText(sources, 'runnerAgentCount', 'VITE_RALLAR_RUNNER_AGENT_COUNT'),
            1
        ),
        source: resolveBootstrapSource(sources)
    };
}

function resolveControlTargetBootstrap(
    sources: BootstrapSources
): Pick<RallarBlackBoxBootstrapConfig, 'mode' | 'autoConnect' | 'providerMode' | 'controlUrl' | 'runId' | 'agentId'> {
    const mode = resolveBootstrapMode(sources);
    const autoConnect = toBoolean(
        resolveLaunchText(sources, 'autoConnect', 'VITE_RALLAR_AUTO_CONNECT'),
        mode === 'control-agent'
    );
    return {
        mode: autoConnect ? 'control-agent' : mode,
        autoConnect,
        providerMode: resolveRallarBlackBoxProviderMode(
            resolveLaunchText(sources, 'provider', 'VITE_RALLAR_PROVIDER') ??
                resolveLaunchText(sources, 'providerMode', 'VITE_RALLAR_PROVIDER_MODE')
        ),
        controlUrl: resolveLaunchText(sources, 'controlUrl', 'VITE_RALLAR_CONTROL_URL') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.controlUrl,
        runId: resolveLaunchText(sources, 'runId', 'VITE_RALLAR_RUN_ID') ??
            (mode === 'control-agent'
                ? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.controlRunId
                : RALLAR_BLACK_BOX_CLIENT_DEFAULTS.localRunId),
        agentId: resolveLaunchText(sources, 'agentId', 'VITE_RALLAR_AGENT_ID') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.agentId
    };
}

function resolveControlReportingBootstrap(
    sources: BootstrapSources,
    fragment: URLSearchParams
): Pick<
    RallarBlackBoxBootstrapConfig,
    'controlToken' | 'heartbeatIntervalMs' | 'statsIntervalMs' | 'finalReportUploadUrl'
> {
    return {
        controlToken: fragment.get('controlToken')?.trim() ||
            resolveLaunchText(sources, 'controlToken', 'VITE_RALLAR_CONTROL_TOKEN'),
        heartbeatIntervalMs: toIntervalMs(
            resolveLaunchText(sources, 'heartbeatIntervalMs', 'VITE_RALLAR_HEARTBEAT_INTERVAL_MS'),
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.heartbeatIntervalMs
        ),
        statsIntervalMs: toIntervalMs(
            resolveLaunchText(sources, 'statsIntervalMs', 'VITE_RALLAR_STATS_INTERVAL_MS'),
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.statsIntervalMs
        ),
        finalReportUploadUrl: resolveLaunchText(sources, 'reportUploadUrl', 'VITE_RALLAR_REPORT_UPLOAD_URL')
    };
}

function resolveRallarScopeBootstrap(
    sources: BootstrapSources
): Pick<
    RallarBlackBoxBootstrapConfig,
    'environment' | 'apiBaseUrl' | 'applicationId' | 'workspaceId' | 'actor' | 'sessionId' | 'roomId' | 'transport'
> {
    return {
        environment: resolveLaunchText(sources, 'environment', 'VITE_RALLAR_ENVIRONMENT') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.environment,
        apiBaseUrl: resolveLaunchText(sources, 'apiBaseUrl', 'VITE_RALLAR_API_BASE_URL') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.apiBaseUrl,
        applicationId: resolveLaunchText(sources, 'applicationId', 'VITE_RALLAR_APPLICATION_ID') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.applicationId,
        workspaceId: resolveLaunchText(sources, 'workspaceId', 'VITE_RALLAR_WORKSPACE_ID') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.workspaceId,
        actor: resolveLaunchText(sources, 'actor', 'VITE_RALLAR_ACTOR') ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.actor,
        sessionId: resolveLaunchText(sources, 'sessionId', 'VITE_RALLAR_SESSION_ID') ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.sessionId,
        roomId: resolveLaunchText(sources, 'roomId', 'VITE_RALLAR_ROOM_ID') ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.roomId,
        transport: resolveLaunchText(sources, 'transport', 'VITE_RALLAR_TRANSPORT') === 'messages.rtc'
            ? 'messages.rtc'
            : 'realtime'
    };
}

function resolveRallarAuthBootstrap(
    sources: BootstrapSources,
    fragment: URLSearchParams
): Pick<
    RallarBlackBoxBootstrapConfig,
    | 'rallarUsername'
    | 'rallarPassword'
    | 'rallarToken'
    | 'rallarRegister'
    | 'rallarAuthStorage'
    | 'rallarAgentSessionTicket'
    | 'rallarRestoreSession'
    | 'rallarLogoutOnClose'
    | 'rallarLeaveRoomOnClose'
> {
    const register = resolveLaunchText(sources, 'rallarRegister', 'VITE_RALLAR_REGISTER');
    const authStorage = resolveLaunchText(sources, 'rallarAuthStorage', 'VITE_RALLAR_AUTH_STORAGE');
    return {
        rallarUsername: resolveLaunchText(sources, 'rallarUsername', 'VITE_RALLAR_USERNAME'),
        rallarPassword: resolveLaunchText(sources, 'rallarPassword', 'VITE_RALLAR_PASSWORD'),
        rallarToken: resolveLaunchText(sources, 'rallarToken', 'VITE_RALLAR_TOKEN'),
        rallarRegister: register?.toLowerCase() === 'if-needed' ? 'if-needed' : toBoolean(register, false),
        rallarAuthStorage: authStorage?.toLowerCase() === 'session' ? 'session' : 'local',
        rallarAgentSessionTicket: fragment.get('agentSessionTicket')?.trim() || undefined,
        rallarRestoreSession: toBoolean(
            resolveLaunchText(sources, 'rallarRestoreSession', 'VITE_RALLAR_RESTORE_SESSION'),
            false
        ),
        rallarLogoutOnClose: toBoolean(
            resolveLaunchText(sources, 'rallarLogoutOnClose', 'VITE_RALLAR_LOGOUT_ON_CLOSE'),
            false
        ),
        rallarLeaveRoomOnClose: toBoolean(
            resolveLaunchText(sources, 'rallarLeaveRoomOnClose', 'VITE_RALLAR_LEAVE_ROOM_ON_CLOSE'),
            true
        )
    };
}

function resolveFleetBootstrap(
    sources: BootstrapSources
): Pick<
    RallarBlackBoxBootstrapConfig,
    | 'fleetRegion'
    | 'fleetProvider'
    | 'fleetDatacenter'
    | 'fleetHostId'
    | 'fleetAgentPoolId'
    | 'fleetDeploymentId'
    | 'fleetBrowserName'
    | 'fleetBrowserVersion'
    | 'fleetOs'
    | 'fleetTags'
    | 'fleetLocation'
> {
    return {
        fleetRegion: resolveLaunchText(sources, 'fleetRegion', 'VITE_RALLAR_AGENT_REGION'),
        fleetProvider: resolveLaunchText(sources, 'fleetProvider', 'VITE_RALLAR_AGENT_PROVIDER'),
        fleetDatacenter: resolveLaunchText(sources, 'fleetDatacenter', 'VITE_RALLAR_AGENT_DATACENTER'),
        fleetHostId: resolveLaunchText(sources, 'fleetHostId', 'VITE_RALLAR_AGENT_HOST_ID'),
        fleetAgentPoolId: resolveLaunchText(sources, 'fleetAgentPoolId', 'VITE_RALLAR_AGENT_POOL_ID'),
        fleetDeploymentId: resolveLaunchText(sources, 'fleetDeploymentId', 'VITE_RALLAR_AGENT_DEPLOYMENT_ID'),
        fleetBrowserName: resolveLaunchText(sources, 'fleetBrowserName', 'VITE_RALLAR_AGENT_BROWSER_NAME'),
        fleetBrowserVersion: resolveLaunchText(sources, 'fleetBrowserVersion', 'VITE_RALLAR_AGENT_BROWSER_VERSION'),
        fleetOs: resolveLaunchText(sources, 'fleetOs', 'VITE_RALLAR_AGENT_OS'),
        fleetTags: toTags(resolveLaunchText(sources, 'fleetTags', 'VITE_RALLAR_AGENT_TAGS')),
        fleetLocation: resolveFleetLocation(sources)
    };
}

/** Launch coordinates are the operator's explicit placement, so the agent reports them as exact. */
function resolveFleetLocation(sources: BootstrapSources): RallarBlackBoxGeoLocation | undefined {
    const latitude = toCoordinate(resolveLaunchText(sources, 'fleetLatitude', 'VITE_RALLAR_AGENT_LATITUDE'), 90);
    const longitude = toCoordinate(resolveLaunchText(sources, 'fleetLongitude', 'VITE_RALLAR_AGENT_LONGITUDE'), 180);
    if (latitude === undefined || longitude === undefined) {
        return undefined;
    }

    const label = resolveLaunchText(sources, 'fleetLocationLabel', 'VITE_RALLAR_AGENT_LOCATION_LABEL');
    return { latitude, longitude, ...(label === undefined ? {} : { label }), precision: 'exact' };
}

function resolveBootstrapMode(sources: BootstrapSources): RallarBlackBoxBootstrapConfig['mode'] {
    const mode = sources.params.get('mode') ?? sources.env.VITE_RALLAR_BOOTSTRAP_MODE;
    return mode === 'control' || mode === 'control-agent' ? 'control-agent' : 'local-workbench';
}

function resolveBootstrapSource(sources: BootstrapSources): RallarBlackBoxBootstrapConfig['source'] {
    if (BOOTSTRAP_URL_KEYS.some((key) => sources.params.has(key))) {
        return 'url';
    }
    return BOOTSTRAP_ENV_KEYS.some((key) => sources.env[key]) ? 'environment' : 'default';
}

/** A URL parameter wins over its Vite environment variable, and a blank value names nothing. */
function resolveLaunchText(sources: BootstrapSources, paramName: string, envName: string): string | undefined {
    const fromUrl = sources.params.get(paramName)?.trim();
    return fromUrl && fromUrl.length > 0 ? fromUrl : sources.env[envName]?.trim() || undefined;
}

function toLaunchParams(text: string, prefix: '?' | '#'): URLSearchParams {
    return new URLSearchParams(text.startsWith(prefix) ? text.slice(1) : text);
}

function toBoolean(text: string | undefined, fallback: boolean): boolean {
    return text ? TRUE_TEXTS.includes(text.toLowerCase()) : fallback;
}

function toIntervalMs(text: string | undefined, fallback: number): number {
    const parsed = text ? Number.parseInt(text, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toPositiveInteger(text: string | undefined, fallback: number): number {
    const parsed = text ? Number.parseInt(text, 10) : Number.NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toCoordinate(text: string | undefined, limit: number): number | undefined {
    const trimmed = text?.trim();
    if (!trimmed || !STRICT_DECIMAL_NUMBER.test(trimmed)) {
        return undefined;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= -limit && parsed <= limit ? parsed : undefined;
}

function toTags(text: string | undefined): readonly string[] | undefined {
    const tags = (text ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
    return tags.length > 0 ? tags : undefined;
}
