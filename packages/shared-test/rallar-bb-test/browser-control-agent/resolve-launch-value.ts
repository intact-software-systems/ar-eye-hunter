export type RallarBlackBoxBootstrapEnvironment = Readonly<Record<string, string | undefined>>;

/** The launch URL parameters and the Vite environment of the agent page. */
export interface BootstrapLaunchSources {
    readonly params: URLSearchParams;
    readonly env: RallarBlackBoxBootstrapEnvironment;
}

export type LaunchSetting = keyof typeof LAUNCH_ENVIRONMENT_KEYS;

export interface LaunchValue {
    /** The URL parameter or Vite environment variable that carried the text. */
    readonly launchKey: string;
    readonly text: string;
}

/** Every URL parameter the bootstrap reads, with the Vite environment variable that stands in for it. */
export const LAUNCH_ENVIRONMENT_KEYS = {
    mode: 'VITE_RALLAR_BOOTSTRAP_MODE',
    controlUrl: 'VITE_RALLAR_CONTROL_URL',
    autoConnect: 'VITE_RALLAR_AUTO_CONNECT',
    provider: 'VITE_RALLAR_PROVIDER',
    runId: 'VITE_RALLAR_RUN_ID',
    agentId: 'VITE_RALLAR_AGENT_ID',
    controlToken: 'VITE_RALLAR_CONTROL_TOKEN',
    heartbeatIntervalMs: 'VITE_RALLAR_HEARTBEAT_INTERVAL_MS',
    statsIntervalMs: 'VITE_RALLAR_STATS_INTERVAL_MS',
    reportUploadUrl: 'VITE_RALLAR_REPORT_UPLOAD_URL',
    environment: 'VITE_RALLAR_ENVIRONMENT',
    apiBaseUrl: 'VITE_RALLAR_API_BASE_URL',
    applicationId: 'VITE_RALLAR_APPLICATION_ID',
    workspaceId: 'VITE_RALLAR_WORKSPACE_ID',
    actor: 'VITE_RALLAR_ACTOR',
    sessionId: 'VITE_RALLAR_SESSION_ID',
    roomId: 'VITE_RALLAR_ROOM_ID',
    transport: 'VITE_RALLAR_TRANSPORT',
    rallarUsername: 'VITE_RALLAR_USERNAME',
    rallarPassword: 'VITE_RALLAR_PASSWORD',
    rallarRegister: 'VITE_RALLAR_REGISTER',
    rallarAuthStorage: 'VITE_RALLAR_AUTH_STORAGE',
    rallarRestoreSession: 'VITE_RALLAR_RESTORE_SESSION',
    rallarLogoutOnClose: 'VITE_RALLAR_LOGOUT_ON_CLOSE',
    rallarLeaveRoomOnClose: 'VITE_RALLAR_LEAVE_ROOM_ON_CLOSE',
    fleetRegion: 'VITE_RALLAR_AGENT_REGION',
    fleetProvider: 'VITE_RALLAR_AGENT_PROVIDER',
    fleetDatacenter: 'VITE_RALLAR_AGENT_DATACENTER',
    fleetHostId: 'VITE_RALLAR_AGENT_HOST_ID',
    fleetAgentPoolId: 'VITE_RALLAR_AGENT_POOL_ID',
    fleetDeploymentId: 'VITE_RALLAR_AGENT_DEPLOYMENT_ID',
    fleetBrowserName: 'VITE_RALLAR_AGENT_BROWSER_NAME',
    fleetBrowserVersion: 'VITE_RALLAR_AGENT_BROWSER_VERSION',
    fleetOs: 'VITE_RALLAR_AGENT_OS',
    fleetTags: 'VITE_RALLAR_AGENT_TAGS',
    runnerAgentPrefix: 'VITE_RALLAR_RUNNER_AGENT_PREFIX',
    runnerAgentCount: 'VITE_RALLAR_RUNNER_AGENT_COUNT',
    fleetLatitude: 'VITE_RALLAR_AGENT_LATITUDE',
    fleetLongitude: 'VITE_RALLAR_AGENT_LONGITUDE',
    fleetLocationLabel: 'VITE_RALLAR_AGENT_LOCATION_LABEL'
} as const;

export function toLaunchParams(text: string, prefix: '?' | '#'): URLSearchParams {
    return new URLSearchParams(text.startsWith(prefix) ? text.slice(1) : text);
}

/** A URL parameter wins over its Vite environment variable, and a blank value names nothing. */
export function resolveLaunchValue(sources: BootstrapLaunchSources, setting: LaunchSetting): LaunchValue | undefined {
    const fromUrl = sources.params.get(setting)?.trim();
    if (fromUrl) {
        return { launchKey: setting, text: fromUrl };
    }
    const environmentKey = LAUNCH_ENVIRONMENT_KEYS[setting];
    const fromEnvironment = sources.env[environmentKey]?.trim();
    return fromEnvironment ? { launchKey: environmentKey, text: fromEnvironment } : undefined;
}

export function resolveLaunchText(sources: BootstrapLaunchSources, setting: LaunchSetting): string | undefined {
    return resolveLaunchValue(sources, setting)?.text;
}
