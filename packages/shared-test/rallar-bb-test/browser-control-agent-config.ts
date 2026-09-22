import type { AuthSessionStorageKind } from '@shared/api/auth.ts';
import {
    computeRallarBlackBoxBootstrapLaunch,
    type RallarBlackBoxBootstrapIssue,
    type RallarBlackBoxBootstrapLaunchSettings,
    type RallarBlackBoxBootstrapRegister,
    type RallarBlackBoxBootstrapTransport
} from './browser-control-agent/compute-rallar-black-box-bootstrap-launch.ts';
import {
    LAUNCH_ENVIRONMENT_KEYS,
    resolveLaunchText,
    toLaunchParams,
    type BootstrapLaunchSources,
    type LaunchSetting,
    type RallarBlackBoxBootstrapEnvironment
} from './browser-control-agent/resolve-launch-value.ts';
import {
    RALLAR_BLACK_BOX_CLIENT_DEFAULTS,
    type RallarBlackBoxProviderMode
} from './client-defaults.ts';
import type { RallarBlackBoxGeoLocation } from './distributed-run.ts';

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
    readonly transport: RallarBlackBoxBootstrapTransport;
    /** Absent when the launch names no Rallar user to sign in as. */
    readonly rallarUsername?: string;
    /** Absent when the launch carries no Rallar password to sign in with. */
    readonly rallarPassword?: string;
    readonly rallarRegister: RallarBlackBoxBootstrapRegister;
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
    /**
     * Empty when every launch value reads as the setting it names. The value beside an issue is the setting's
     * default, which no agent runs with: an agent refuses to start while any issue is present.
     */
    readonly issues: readonly RallarBlackBoxBootstrapIssue[];
}

interface ViteImportMeta {
    /** Absent outside a Vite build. */
    readonly env?: RallarBlackBoxBootstrapEnvironment;
}

/** Reads the launch URL and the Vite environment of the current page. */
export function readRallarBlackBoxBootstrapConfig(): RallarBlackBoxBootstrapConfig {
    return resolveRallarBlackBoxBootstrapConfig(
        globalThis.window?.location?.search ?? '',
        (import.meta as ViteImportMeta).env ?? {},
        globalThis.window?.location?.hash ?? ''
    );
}

export function resolveRallarBlackBoxBootstrapConfig(
    search: string,
    env: RallarBlackBoxBootstrapEnvironment,
    hash: string
): RallarBlackBoxBootstrapConfig {
    const sources: BootstrapLaunchSources = { params: toLaunchParams(search, '?'), env };
    const fragment = toLaunchParams(hash, '#');
    const launch = computeRallarBlackBoxBootstrapLaunch(sources);
    return {
        ...resolveControlTargetBootstrap(sources, launch.settings),
        ...resolveControlReportingBootstrap(sources, launch.settings, fragment),
        ...resolveRallarScopeBootstrap(sources, launch.settings),
        ...resolveRallarAuthBootstrap(sources, launch.settings, fragment),
        ...resolveFleetBootstrap(sources, launch.settings),
        runnerAgentPrefix: resolveLaunchText(sources, 'runnerAgentPrefix'),
        runnerAgentCount: launch.settings.runnerAgentCount ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.runnerAgentCount,
        source: resolveBootstrapSource(sources),
        issues: launch.issues
    };
}

/** Absent when the launch reads as its settings; otherwise the failure an agent reports when it refuses to start. */
export function toRallarBlackBoxBootstrapRefusal(bootstrap: RallarBlackBoxBootstrapConfig): string | undefined {
    return bootstrap.issues.length === 0
        ? undefined
        : `The agent launch cannot be read: ${bootstrap.issues.map((issue) => issue.message).join(' ')}`;
}

function resolveControlTargetBootstrap(
    sources: BootstrapLaunchSources,
    settings: RallarBlackBoxBootstrapLaunchSettings
): Pick<RallarBlackBoxBootstrapConfig, 'mode' | 'autoConnect' | 'providerMode' | 'controlUrl' | 'runId' | 'agentId'> {
    const mode = resolveLaunchText(sources, 'mode') === 'control'
        ? 'control-agent'
        : RALLAR_BLACK_BOX_CLIENT_DEFAULTS.mode;
    const autoConnect = settings.autoConnect ?? mode === 'control-agent';
    return {
        mode: autoConnect ? 'control-agent' : mode,
        autoConnect,
        providerMode: settings.providerMode ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.providerMode,
        controlUrl: resolveLaunchText(sources, 'controlUrl') ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.controlUrl,
        runId: resolveLaunchText(sources, 'runId') ??
            (mode === 'control-agent'
                ? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.controlRunId
                : RALLAR_BLACK_BOX_CLIENT_DEFAULTS.localRunId),
        agentId: resolveLaunchText(sources, 'agentId') ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.agentId
    };
}

function resolveControlReportingBootstrap(
    sources: BootstrapLaunchSources,
    settings: RallarBlackBoxBootstrapLaunchSettings,
    fragment: URLSearchParams
): Pick<
    RallarBlackBoxBootstrapConfig,
    'controlToken' | 'heartbeatIntervalMs' | 'statsIntervalMs' | 'finalReportUploadUrl'
> {
    return {
        controlToken: fragment.get('controlToken')?.trim() || resolveLaunchText(sources, 'controlToken'),
        heartbeatIntervalMs: settings.heartbeatIntervalMs ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.heartbeatIntervalMs,
        statsIntervalMs: settings.statsIntervalMs ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.statsIntervalMs,
        finalReportUploadUrl: resolveLaunchText(sources, 'reportUploadUrl')
    };
}

function resolveRallarScopeBootstrap(
    sources: BootstrapLaunchSources,
    settings: RallarBlackBoxBootstrapLaunchSettings
): Pick<
    RallarBlackBoxBootstrapConfig,
    'environment' | 'apiBaseUrl' | 'applicationId' | 'workspaceId' | 'actor' | 'sessionId' | 'roomId' | 'transport'
> {
    return {
        environment: resolveLaunchText(sources, 'environment') ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.environment,
        apiBaseUrl: resolveLaunchText(sources, 'apiBaseUrl') ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.apiBaseUrl,
        applicationId: resolveLaunchText(sources, 'applicationId') ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.applicationId,
        workspaceId: resolveLaunchText(sources, 'workspaceId') ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.workspaceId,
        actor: resolveLaunchText(sources, 'actor') ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.actor,
        sessionId: resolveLaunchText(sources, 'sessionId') ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.sessionId,
        roomId: resolveLaunchText(sources, 'roomId') ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.roomId,
        transport: settings.transport ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.transport
    };
}

function resolveRallarAuthBootstrap(
    sources: BootstrapLaunchSources,
    settings: RallarBlackBoxBootstrapLaunchSettings,
    fragment: URLSearchParams
): Pick<
    RallarBlackBoxBootstrapConfig,
    | 'rallarUsername'
    | 'rallarPassword'
    | 'rallarRegister'
    | 'rallarAuthStorage'
    | 'rallarAgentSessionTicket'
    | 'rallarRestoreSession'
    | 'rallarLogoutOnClose'
    | 'rallarLeaveRoomOnClose'
> {
    return {
        rallarUsername: resolveLaunchText(sources, 'rallarUsername'),
        rallarPassword: resolveLaunchText(sources, 'rallarPassword'),
        rallarRegister: settings.rallarRegister ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.rallarRegister,
        rallarAuthStorage: settings.rallarAuthStorage ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.rallarAuthStorage,
        rallarAgentSessionTicket: fragment.get('agentSessionTicket')?.trim() || undefined,
        rallarRestoreSession: settings.rallarRestoreSession ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.rallarRestoreSession,
        rallarLogoutOnClose: settings.rallarLogoutOnClose ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.rallarLogoutOnClose,
        rallarLeaveRoomOnClose: settings.rallarLeaveRoomOnClose ??
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.rallarLeaveRoomOnClose
    };
}

function resolveFleetBootstrap(
    sources: BootstrapLaunchSources,
    settings: RallarBlackBoxBootstrapLaunchSettings
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
        fleetRegion: resolveLaunchText(sources, 'fleetRegion'),
        fleetProvider: resolveLaunchText(sources, 'fleetProvider'),
        fleetDatacenter: resolveLaunchText(sources, 'fleetDatacenter'),
        fleetHostId: resolveLaunchText(sources, 'fleetHostId'),
        fleetAgentPoolId: resolveLaunchText(sources, 'fleetAgentPoolId'),
        fleetDeploymentId: resolveLaunchText(sources, 'fleetDeploymentId'),
        fleetBrowserName: resolveLaunchText(sources, 'fleetBrowserName'),
        fleetBrowserVersion: resolveLaunchText(sources, 'fleetBrowserVersion'),
        fleetOs: resolveLaunchText(sources, 'fleetOs'),
        fleetTags: toTags(resolveLaunchText(sources, 'fleetTags')),
        fleetLocation: settings.fleetLocation
    };
}

function resolveBootstrapSource(sources: BootstrapLaunchSources): RallarBlackBoxBootstrapConfig['source'] {
    const settings = Object.keys(LAUNCH_ENVIRONMENT_KEYS) as LaunchSetting[];
    if (settings.some((setting) => sources.params.has(setting))) {
        return 'url';
    }
    return settings.some((setting) => sources.env[LAUNCH_ENVIRONMENT_KEYS[setting]]) ? 'environment' : 'default';
}

function toTags(text: string | undefined): readonly string[] | undefined {
    const tags = (text ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
    return tags.length > 0 ? tags : undefined;
}
