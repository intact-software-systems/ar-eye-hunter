import {
    toRallarBlackBoxRoutineBrowserDiagnostics,
    type RallarBlackBoxRoutineBrowserDiagnostics
} from '@shared-test/black-box-runner/fixtures/browser-diagnostics-recording.ts';
import { decodeEventHistoryLaunch } from '@shared-test/rallar-bb-test/browser-control-agent/decode-event-history-launch.ts';
import {
    isRallarBlackBoxBrowserCensusIntervalMs,
    RALLAR_BLACK_BOX_BROWSER_CENSUS_INTERVAL_EXPECTATION,
    RALLAR_BLACK_BOX_CLIENT_DEFAULTS
} from '@shared-test/rallar-bb-test/client-defaults.ts';
import type { RallarBlackBoxEventHistoryPolicy } from '@shared-test/rallar-bb-test/runtime/event-history.ts';
import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import {
    readEnvironmentBoolean,
    readEnvironmentList,
    readEnvironmentPositiveInteger,
    readEnvironmentString,
    readOptionalEnvironmentCoordinate,
    readOptionalEnvironmentPositiveInteger,
    readRequiredEnvironmentString,
    type HeadlessWorkerEnvironment
} from './headless-worker-environment-values.ts';

export type HeadlessWorkerTransport = 'realtime' | 'messages.rtc';
export type HeadlessWorkerBrowserLogLevel = 'warning' | 'info' | 'debug';
export type HeadlessWorkerEntry = 'operator-spa' | 'headless';
export type HeadlessWorkerBrowserEngine = 'chromium' | 'firefox' | 'webkit';
export type HeadlessWorkerExitMode =
    | 'signal'
    | 'after-target-distributed-run-terminal'
    | 'after-idle-ms';

export interface HeadlessWorkerCredentials {
    readonly username: string;
    readonly password: string;
}

export interface HeadlessWorkerAgentConfig {
    readonly agentId: string;
    readonly actor: string;
    readonly sessionId: string;
    readonly credentials: HeadlessWorkerCredentials;
    readonly controlToken?: string;
    readonly url: string;
}

export interface HeadlessWorkerConfig {
    readonly eventHistory: RallarBlackBoxEventHistoryPolicy;
    readonly spaUrl: string;
    readonly controlUrl: string;
    readonly apiBaseUrl: string;
    readonly headlessEntry: HeadlessWorkerEntry;
    readonly browserEngine: HeadlessWorkerBrowserEngine;
    readonly runId: string;
    readonly agentPrefix: string;
    readonly agentCount: number;
    readonly agentStartIndex: number;
    readonly roomId: string;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly transport: HeadlessWorkerTransport;
    readonly routineBrowserDiagnostics: RallarBlackBoxRoutineBrowserDiagnostics;
    /** Absent when the worker inherits the SDK host capture default. */
    readonly rtcCaptureMode?: RtcSignalingDiagnostics.CaptureMode;
    readonly statsIntervalMs?: number;
    /** Zero, the default, turns every agent page's browser census off. */
    readonly browserCensusIntervalMs: number;
    readonly heartbeatIntervalMs?: number;
    readonly controlToken?: string;
    readonly controlReadToken?: string;
    readonly reportUploadUrl?: string;
    readonly environment?: string;
    readonly fleetRegion?: string;
    readonly fleetProvider?: string;
    readonly fleetDatacenter?: string;
    readonly fleetHostId?: string;
    readonly fleetAgentPoolId?: string;
    readonly fleetDeploymentId?: string;
    readonly fleetBrowserName?: string;
    readonly fleetBrowserVersion?: string;
    readonly fleetOs?: string;
    readonly fleetTags?: readonly string[];
    readonly fleetLatitude?: number;
    readonly fleetLongitude?: number;
    readonly fleetLocationLabel?: string;
    readonly register: boolean;
    readonly restoreSession: boolean;
    readonly logoutOnClose: boolean;
    readonly leaveRoomOnClose: boolean;
    readonly browserLogLevel: HeadlessWorkerBrowserLogLevel;
    readonly headless: boolean;
    readonly launchTimeoutMs: number;
    readonly readyTimeoutMs: number;
    readonly pageDisconnectTimeoutMs: number;
    readonly exitMode: HeadlessWorkerExitMode;
    readonly targetDistributedRunId?: string;
    readonly controlHttpUrl?: string;
    readonly idleExitMs?: number;
    readonly distributedPollIntervalMs: number;
    readonly agentCredentials: readonly HeadlessWorkerCredentials[];
    readonly agentControlTokens: readonly (string | undefined)[];
    readonly agents: readonly HeadlessWorkerAgentConfig[];
}

export interface HeadlessWorkerConfigInput {
    readonly env?: HeadlessWorkerEnvironment;
}

export type HeadlessWorkerAgentUrlInput =
    & Omit<
        HeadlessWorkerConfig,
        | 'eventHistory'
        | 'routineBrowserDiagnostics'
        | 'agents'
        | 'agentCredentials'
        | 'browserLogLevel'
        | 'agentControlTokens'
        | 'controlReadToken'
        | 'exitMode'
        | 'targetDistributedRunId'
        | 'controlHttpUrl'
        | 'idleExitMs'
        | 'distributedPollIntervalMs'
        | 'pageDisconnectTimeoutMs'
    >
    & Omit<HeadlessWorkerAgentConfig, 'url'>
    & Readonly<{
        routineBrowserDiagnostics?: RallarBlackBoxRoutineBrowserDiagnostics;
        eventHistory?: RallarBlackBoxEventHistoryPolicy;
    }>;

const DEFAULT_AGENT_COUNT = 1;
const DEFAULT_AGENT_START_INDEX = 1;
const DEFAULT_AGENT_PREFIX = 'hetzner-agent';
const DEFAULT_TRANSPORT: HeadlessWorkerTransport = 'realtime';
const DEFAULT_BROWSER_LOG_LEVEL: HeadlessWorkerBrowserLogLevel = 'warning';
const DEFAULT_BROWSER_ENGINE: HeadlessWorkerBrowserEngine = 'chromium';
const DEFAULT_EXIT_MODE: HeadlessWorkerExitMode = 'signal';
const DEFAULT_DISTRIBUTED_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = 45_000;
const DEFAULT_PAGE_DISCONNECT_TIMEOUT_MS = 10_000;

const REQUIRED_ENV = [
    'RALLAR_BLACK_BOX_SPA_URL',
    'RALLAR_BLACK_BOX_CONTROL_URL',
    'RALLAR_API_BASE_URL',
    'RALLAR_BLACK_BOX_RUN_ID',
    'RALLAR_BLACK_BOX_ROOM_ID'
] as const;

export function readHeadlessWorkerConfig(
    input: HeadlessWorkerConfigInput = {}
): HeadlessWorkerConfig {
    const env = input.env ?? {};
    const missing = REQUIRED_ENV.filter((key) => !readEnvironmentString(env, key));
    if (missing.length > 0) {
        throw new Error(`Missing required headless worker env: ${missing.join(', ')}`);
    }

    const agentCount = readEnvironmentPositiveInteger(env, 'RALLAR_BLACK_BOX_AGENT_COUNT', DEFAULT_AGENT_COUNT);
    const agentStartIndex = readEnvironmentPositiveInteger(
        env,
        'RALLAR_BLACK_BOX_AGENT_START_INDEX',
        DEFAULT_AGENT_START_INDEX
    );
    const controlUrl = readRequiredEnvironmentString(env, 'RALLAR_BLACK_BOX_CONTROL_URL');
    const exitRequest = readHeadlessWorkerExitRequest(env);
    const browserEngine = readEnvironmentBrowserEngine(env);
    const agentCredentials = readAgentCredentials(env, agentCount);
    const controlToken = readEnvironmentString(env, 'RALLAR_BLACK_BOX_CONTROL_TOKEN');
    const agentControlTokens = readAgentControlTokens(env, agentCount, controlToken);
    const baseConfig = {
        ...readHeadlessWorkerPageEnvironment(env),
        controlUrl,
        browserEngine,
        agentCount,
        agentStartIndex,
        controlToken,
        ...readHeadlessWorkerFleetReportingEnvironment(env, browserEngine),
        ...readHeadlessWorkerBrowserLifecycleEnvironment(env),
        ...exitRequest,
        controlHttpUrl: toBaseUrlWithoutTrailingSlash(
            readEnvironmentString(env, 'RALLAR_CONTROL_HTTP_URL') ?? toControlHttpUrl(controlUrl)
        ),
        distributedPollIntervalMs: readEnvironmentPositiveInteger(
            env,
            'RALLAR_BLACK_BOX_DISTRIBUTED_POLL_INTERVAL_MS',
            DEFAULT_DISTRIBUTED_POLL_INTERVAL_MS
        ),
        agentCredentials,
        agentControlTokens
    };
    return { ...baseConfig, agents: createHeadlessWorkerAgents(baseConfig) };
}

export function createHeadlessWorkerAgents(
    config: Omit<HeadlessWorkerConfig, 'agents'>
): readonly HeadlessWorkerAgentConfig[] {
    return Array.from({ length: config.agentCount }, (_, index) => {
        const ordinal = config.agentStartIndex + index;
        const agentId = `${config.agentPrefix}-${String(ordinal).padStart(2, '0')}`;
        const actor = agentId;
        return {
            agentId,
            actor,
            sessionId: agentId,
            credentials: config.agentCredentials[index],
            controlToken: config.agentControlTokens[index],
            url: createHeadlessWorkerAgentUrl({
                ...config,
                agentId,
                actor,
                sessionId: agentId,
                credentials: config.agentCredentials[index],
                controlToken: config.agentControlTokens[index]
            })
        };
    });
}

export function createHeadlessWorkerAgentUrl(
    input: HeadlessWorkerAgentUrlInput
): string {
    const url = toAgentSpaUrl(input.spaUrl, input.headlessEntry);
    const params = url.searchParams;
    params.set('mode', 'control');
    params.set('provider', 'browser-rallar');
    params.set('autoConnect', '1');
    if (input.headlessEntry === 'operator-spa') {
        params.set('tab', 'local-workbench');
    }
    else {
        params.delete('tab');
    }
    params.set('controlUrl', input.controlUrl);
    params.set('runId', input.runId);
    params.set('agentId', input.agentId);
    setHeadlessWorkerRallarLaunchParams(params, input);
    setHeadlessWorkerFleetReportingParams(params, input);
    if (input.register) {
        params.set(
            'rallarRegister',
            input.headlessEntry === 'headless' ? 'if-needed' : '1'
        );
    }
    if (input.restoreSession) {
        params.set('rallarRestoreSession', '1');
    }
    return url.toString();
}

export interface HeadlessWorkerLaunchOptions {
    readonly headless: boolean;
    readonly timeout: number;
    readonly handleSIGINT: false;
    readonly handleSIGTERM: false;
    readonly args: readonly string[];
}

/**
 * The worker owns SIGINT and SIGTERM: Playwright's own handlers would close the browser under the pages' disconnect.
 * Without precise memory info Chromium answers `performance.memory` in buckets, which the census cannot read a heap
 * slope from; without the exposed collector the census reads the heap with garbage still on it.
 */
export function toHeadlessWorkerLaunchOptions(config: HeadlessWorkerConfig): HeadlessWorkerLaunchOptions {
    return {
        headless: config.headless,
        timeout: config.launchTimeoutMs,
        handleSIGINT: false,
        handleSIGTERM: false,
        args: config.browserEngine === 'chromium' && config.browserCensusIntervalMs > 0
            ? ['--enable-precise-memory-info', '--js-flags=--expose-gc']
            : []
    };
}

export function toControlRunSnapshotUrl(
    controlUrl: string,
    runId: string
): string {
    const url = toControlHttpProtocolUrl(controlUrl);

    url.pathname = `/runs/${encodeURIComponent(runId)}`;
    url.search = '';
    url.hash = '';
    return url.toString();
}

function readHeadlessWorkerExitRequest(
    env: HeadlessWorkerEnvironment
): Pick<HeadlessWorkerConfig, 'exitMode' | 'targetDistributedRunId' | 'idleExitMs'> {
    const exitMode = readEnvironmentExitMode(env);
    const targetDistributedRunId = readEnvironmentString(
        env,
        'RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID'
    );
    const idleExitMs = readOptionalEnvironmentPositiveInteger(
        env,
        'RALLAR_BLACK_BOX_IDLE_EXIT_MS'
    );
    if (
        exitMode === 'after-target-distributed-run-terminal' &&
        !targetDistributedRunId
    ) {
        throw new Error(
            'RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID is required when ' +
                'RALLAR_BLACK_BOX_EXIT_MODE=after-target-distributed-run-terminal'
        );
    }
    if (exitMode === 'after-idle-ms' && idleExitMs === undefined) {
        throw new Error('RALLAR_BLACK_BOX_IDLE_EXIT_MS must be a positive integer');
    }
    return { exitMode, targetDistributedRunId, idleExitMs };
}

function readHeadlessWorkerPageEnvironment(
    env: HeadlessWorkerEnvironment
): Pick<
    HeadlessWorkerConfig,
    | 'spaUrl'
    | 'apiBaseUrl'
    | 'headlessEntry'
    | 'runId'
    | 'agentPrefix'
    | 'roomId'
    | 'applicationId'
    | 'workspaceId'
    | 'transport'
    | 'eventHistory'
    | 'routineBrowserDiagnostics'
    | 'rtcCaptureMode'
    | 'statsIntervalMs'
    | 'browserCensusIntervalMs'
    | 'heartbeatIntervalMs'
> {
    return {
        spaUrl: toBaseUrlWithoutTrailingSlash(readRequiredEnvironmentString(env, 'RALLAR_BLACK_BOX_SPA_URL')),
        apiBaseUrl: toBaseUrlWithoutTrailingSlash(readRequiredEnvironmentString(env, 'RALLAR_API_BASE_URL')),
        headlessEntry: readEnvironmentHeadlessEntry(env),
        runId: readRequiredEnvironmentString(env, 'RALLAR_BLACK_BOX_RUN_ID'),
        agentPrefix: readEnvironmentString(env, 'RALLAR_BLACK_BOX_AGENT_PREFIX') ??
            DEFAULT_AGENT_PREFIX,
        roomId: readRequiredEnvironmentString(env, 'RALLAR_BLACK_BOX_ROOM_ID'),
        applicationId: readEnvironmentString(env, 'RALLAR_APPLICATION_ID') ??
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_APPLICATION_ID'),
        workspaceId: readEnvironmentString(env, 'RALLAR_WORKSPACE_ID') ??
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_WORKSPACE_ID'),
        transport: readEnvironmentTransport(env, 'RALLAR_BLACK_BOX_TRANSPORT', DEFAULT_TRANSPORT),
        eventHistory: decodeEventHistoryLaunch(
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_EVENT_HISTORY'),
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_EVENT_HISTORY_MAX_EVENTS')
        ).fold(
            (issues) => {
                throw new Error(`Event history launch: ${issues.join('; ')}`);
            },
            (parsed) => parsed.policy ?? { mode: 'full' }
        ),
        routineBrowserDiagnostics: readHeadlessWorkerRoutineBrowserDiagnostics(env),
        rtcCaptureMode: parseRtcCaptureMode(readEnvironmentString(env, 'RALLAR_BLACK_BOX_RTC_CAPTURE_MODE')).fold(
            (issues) => {
                throw new Error(`RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: ${issues[0].message}`);
            },
            (parsed) => parsed.mode
        ),
        statsIntervalMs: readOptionalEnvironmentPositiveInteger(env, 'RALLAR_BLACK_BOX_STATS_INTERVAL_MS'),
        browserCensusIntervalMs: readEnvironmentBrowserCensusIntervalMs(env),
        heartbeatIntervalMs: readOptionalEnvironmentPositiveInteger(env, 'RALLAR_BLACK_BOX_HEARTBEAT_INTERVAL_MS')
    };
}

function readHeadlessWorkerRoutineBrowserDiagnostics(
    env: HeadlessWorkerEnvironment
): RallarBlackBoxRoutineBrowserDiagnostics {
    const value = env.RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS;
    const mode = value === undefined
        ? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.routineBrowserDiagnostics
        : toRallarBlackBoxRoutineBrowserDiagnostics(value);
    if (mode === undefined) {
        throw new Error('Routine browser diagnostics environment selection must be enabled or disabled.');
    }
    return mode;
}

function readHeadlessWorkerFleetReportingEnvironment(
    env: HeadlessWorkerEnvironment,
    browserEngine: HeadlessWorkerBrowserEngine
): Pick<
    HeadlessWorkerConfig,
    | 'controlReadToken'
    | 'reportUploadUrl'
    | 'environment'
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
    | 'fleetLatitude'
    | 'fleetLongitude'
    | 'fleetLocationLabel'
> {
    return {
        controlReadToken: readEnvironmentString(env, 'RALLAR_BLACK_BOX_CONTROL_READ_TOKEN'),
        reportUploadUrl: readEnvironmentString(env, 'RALLAR_BLACK_BOX_REPORT_UPLOAD_URL'),
        environment: readEnvironmentString(env, 'RALLAR_BLACK_BOX_ENVIRONMENT'),
        fleetRegion: readEnvironmentString(env, 'RALLAR_AGENT_REGION') ??
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_AGENT_REGION'),
        fleetProvider: readEnvironmentString(env, 'RALLAR_AGENT_PROVIDER') ??
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_AGENT_PROVIDER'),
        fleetDatacenter: readEnvironmentString(env, 'RALLAR_AGENT_DATACENTER') ??
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_AGENT_DATACENTER'),
        fleetHostId: readEnvironmentString(env, 'RALLAR_AGENT_HOST_ID') ??
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_AGENT_HOST_ID'),
        fleetAgentPoolId: readEnvironmentString(env, 'RALLAR_AGENT_POOL_ID') ??
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_AGENT_POOL_ID'),
        fleetDeploymentId: readEnvironmentString(env, 'RALLAR_AGENT_DEPLOYMENT_ID') ??
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_AGENT_DEPLOYMENT_ID'),
        fleetBrowserName: readEnvironmentString(env, 'RALLAR_AGENT_BROWSER_NAME') ??
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_AGENT_BROWSER_NAME') ??
            browserEngine,
        fleetBrowserVersion: readEnvironmentString(env, 'RALLAR_AGENT_BROWSER_VERSION') ??
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_AGENT_BROWSER_VERSION'),
        fleetOs: readEnvironmentString(env, 'RALLAR_AGENT_OS') ??
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_AGENT_OS'),
        fleetTags: readEnvironmentList(env, 'RALLAR_AGENT_TAGS') ??
            readEnvironmentList(env, 'RALLAR_BLACK_BOX_AGENT_TAGS'),
        ...readHeadlessWorkerFleetLocationEnvironment(env)
    };
}

function readHeadlessWorkerFleetLocationEnvironment(
    env: HeadlessWorkerEnvironment
): Pick<HeadlessWorkerConfig, 'fleetLatitude' | 'fleetLongitude' | 'fleetLocationLabel'> {
    return {
        fleetLatitude: readOptionalEnvironmentCoordinate({
            env,
            primaryKey: 'RALLAR_AGENT_LATITUDE',
            fallbackKey: 'RALLAR_BLACK_BOX_AGENT_LATITUDE',
            min: -90,
            max: 90
        }),
        fleetLongitude: readOptionalEnvironmentCoordinate({
            env,
            primaryKey: 'RALLAR_AGENT_LONGITUDE',
            fallbackKey: 'RALLAR_BLACK_BOX_AGENT_LONGITUDE',
            min: -180,
            max: 180
        }),
        fleetLocationLabel: readEnvironmentString(env, 'RALLAR_AGENT_LOCATION_LABEL') ??
            readEnvironmentString(env, 'RALLAR_BLACK_BOX_AGENT_LOCATION_LABEL')
    };
}

function readHeadlessWorkerBrowserLifecycleEnvironment(
    env: HeadlessWorkerEnvironment
): Pick<
    HeadlessWorkerConfig,
    | 'register'
    | 'restoreSession'
    | 'logoutOnClose'
    | 'leaveRoomOnClose'
    | 'browserLogLevel'
    | 'headless'
    | 'launchTimeoutMs'
    | 'readyTimeoutMs'
    | 'pageDisconnectTimeoutMs'
> {
    return {
        register: readEnvironmentBoolean(env, 'RALLAR_BLACK_BOX_REGISTER', false),
        restoreSession: readEnvironmentBoolean(env, 'RALLAR_BLACK_BOX_RESTORE_SESSION', false),
        logoutOnClose: readEnvironmentBoolean(env, 'RALLAR_BLACK_BOX_LOGOUT_ON_CLOSE', false),
        leaveRoomOnClose: readEnvironmentBoolean(
            env,
            'RALLAR_BLACK_BOX_LEAVE_ROOM_ON_CLOSE',
            false
        ),
        browserLogLevel: readEnvironmentBrowserLogLevel(
            env,
            'RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL',
            DEFAULT_BROWSER_LOG_LEVEL
        ),
        headless: readEnvironmentBoolean(env, 'RALLAR_BLACK_BOX_HEADLESS', true),
        launchTimeoutMs: readEnvironmentPositiveInteger(
            env,
            'RALLAR_BLACK_BOX_LAUNCH_TIMEOUT_MS',
            DEFAULT_LAUNCH_TIMEOUT_MS
        ),
        readyTimeoutMs: readEnvironmentPositiveInteger(
            env,
            'RALLAR_BLACK_BOX_READY_TIMEOUT_MS',
            DEFAULT_READY_TIMEOUT_MS
        ),
        pageDisconnectTimeoutMs: readEnvironmentPositiveInteger(
            env,
            'RALLAR_BLACK_BOX_PAGE_DISCONNECT_TIMEOUT_MS',
            DEFAULT_PAGE_DISCONNECT_TIMEOUT_MS
        )
    };
}

function setHeadlessWorkerRallarLaunchParams(params: URLSearchParams, input: HeadlessWorkerAgentUrlInput): void {
    params.set('apiBaseUrl', input.apiBaseUrl);
    params.set('roomId', input.roomId);
    params.set('actor', input.actor);
    params.set('sessionId', input.sessionId);
    params.set('transport', input.transport);
    params.set(
        'routineBrowserDiagnostics',
        input.routineBrowserDiagnostics ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.routineBrowserDiagnostics
    );
    params.set('rallarUsername', input.credentials.username);
    params.set('rallarPassword', input.credentials.password);
    params.set('rallarLeaveRoomOnClose', input.leaveRoomOnClose ? '1' : '0');
    params.set('rallarLogoutOnClose', input.logoutOnClose ? '1' : '0');

    const eventHistory = input.eventHistory ?? { mode: 'full' };
    params.set('eventHistory', eventHistory.mode);
    if (eventHistory.mode === 'recent') {
        params.set('eventHistoryMaxEvents', String(eventHistory.maxEvents));
    }
    else {
        params.delete('eventHistoryMaxEvents');
    }
    setOptionalParam(params, 'rtcCaptureMode', input.rtcCaptureMode);
    setOptionalParam(params, 'applicationId', input.applicationId);
    setOptionalParam(params, 'workspaceId', input.workspaceId);
}

function setHeadlessWorkerFleetReportingParams(params: URLSearchParams, input: HeadlessWorkerAgentUrlInput): void {
    params.set('browserCensusIntervalMs', String(input.browserCensusIntervalMs));
    setOptionalParam(
        params,
        'statsIntervalMs',
        toOptionalNumberString(input.statsIntervalMs)
    );
    setOptionalParam(
        params,
        'heartbeatIntervalMs',
        toOptionalNumberString(input.heartbeatIntervalMs)
    );
    setOptionalParam(params, 'controlToken', input.controlToken);
    setOptionalParam(params, 'reportUploadUrl', input.reportUploadUrl);
    setOptionalParam(params, 'environment', input.environment);
    setOptionalParam(params, 'fleetRegion', input.fleetRegion);
    setOptionalParam(params, 'fleetProvider', input.fleetProvider);
    setOptionalParam(params, 'fleetDatacenter', input.fleetDatacenter);
    setOptionalParam(params, 'fleetHostId', input.fleetHostId);
    setOptionalParam(params, 'fleetAgentPoolId', input.fleetAgentPoolId);
    setOptionalParam(params, 'fleetDeploymentId', input.fleetDeploymentId);
    setOptionalParam(params, 'fleetBrowserName', input.fleetBrowserName);
    setOptionalParam(params, 'fleetBrowserVersion', input.fleetBrowserVersion);
    setOptionalParam(params, 'fleetOs', input.fleetOs);
    setOptionalParam(params, 'fleetTags', input.fleetTags?.join(','));
    setOptionalParam(params, 'fleetLatitude', toOptionalNumberString(input.fleetLatitude));
    setOptionalParam(params, 'fleetLongitude', toOptionalNumberString(input.fleetLongitude));
    setOptionalParam(params, 'fleetLocationLabel', input.fleetLocationLabel);
}

function toAgentSpaUrl(spaUrl: string, entry: HeadlessWorkerEntry): URL {
    const url = new URL(spaUrl);
    if (entry === 'headless') {
        const basePath = url.pathname.endsWith('/')
            ? url.pathname
            : `${url.pathname}/`;
        url.pathname = basePath.endsWith('/headless/')
            ? basePath
            : `${basePath.replace(/\/+$/, '')}/headless/`;
    }
    return url;
}

function toControlHttpUrl(controlUrl: string): string {
    const url = toControlHttpProtocolUrl(controlUrl);
    url.search = '';
    url.hash = '';
    return url.toString();
}

function toControlHttpProtocolUrl(controlUrl: string): URL {
    const url = new URL(controlUrl);
    if (url.protocol === 'ws:') {
        url.protocol = 'http:';
    }
    else if (url.protocol === 'wss:') {
        url.protocol = 'https:';
    }
    else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(
            `Control URL must use ws, wss, http, or https. Received: ${controlUrl}`
        );
    }
    return url;
}

function readAgentCredentials(
    env: HeadlessWorkerEnvironment,
    agentCount: number
): readonly HeadlessWorkerCredentials[] {
    const genericUsername = readEnvironmentString(env, 'RALLAR_BLACK_BOX_USERNAME');
    const genericPassword = readEnvironmentString(env, 'RALLAR_BLACK_BOX_PASSWORD');
    const credentials: HeadlessWorkerCredentials[] = [];
    for (let index = 0; index < agentCount; index += 1) {
        const ordinal = index + 1;
        const username = readEnvironmentString(env, `RALLAR_BLACK_BOX_AGENT_${ordinal}_USERNAME`) ??
            genericUsername;
        const password = readEnvironmentString(env, `RALLAR_BLACK_BOX_AGENT_${ordinal}_PASSWORD`) ??
            genericPassword;
        if (!username || !password) {
            throw new Error(
                `Missing credentials for headless worker agent ${ordinal}. ` +
                    `Set RALLAR_BLACK_BOX_USERNAME/PASSWORD or ` +
                    `RALLAR_BLACK_BOX_AGENT_${ordinal}_USERNAME/PASSWORD.`
            );
        }
        credentials.push({ username, password });
    }
    return credentials;
}

function readAgentControlTokens(
    env: HeadlessWorkerEnvironment,
    agentCount: number,
    fallback: string | undefined
): readonly (string | undefined)[] {
    const tokens: (string | undefined)[] = [];
    for (let index = 0; index < agentCount; index += 1) {
        const ordinal = index + 1;
        tokens.push(
            readEnvironmentString(env, `RALLAR_BLACK_BOX_AGENT_${ordinal}_CONTROL_TOKEN`) ??
                fallback
        );
    }
    return tokens;
}

function setOptionalParam(
    params: URLSearchParams,
    key: string,
    value: string | undefined
): void {
    if (value && value.length > 0) {
        params.set(key, value);
    }
}

function toOptionalNumberString(value: number | undefined): string | undefined {
    return value === undefined ? undefined : String(value);
}

function readEnvironmentBrowserCensusIntervalMs(env: HeadlessWorkerEnvironment): number {
    const key = 'RALLAR_BLACK_BOX_BROWSER_CENSUS_INTERVAL_MS';
    const raw = readEnvironmentString(env, key);
    if (!raw) {
        return RALLAR_BLACK_BOX_CLIENT_DEFAULTS.browserCensusIntervalMs;
    }
    const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!isRallarBlackBoxBrowserCensusIntervalMs(parsed)) {
        throw new Error(`${key} must be ${RALLAR_BLACK_BOX_BROWSER_CENSUS_INTERVAL_EXPECTATION}. Received: ${raw}`);
    }
    return parsed;
}

function readEnvironmentTransport(
    env: HeadlessWorkerEnvironment,
    key: string,
    fallback: HeadlessWorkerTransport
): HeadlessWorkerTransport {
    const raw = readEnvironmentString(env, key);
    if (!raw) {
        return fallback;
    }
    if (raw === 'realtime' || raw === 'messages.rtc') {
        return raw;
    }
    throw new Error(`${key} must be realtime or messages.rtc. Received: ${raw}`);
}

function readEnvironmentHeadlessEntry(
    env: HeadlessWorkerEnvironment
): HeadlessWorkerEntry {
    const value = readEnvironmentString(env, 'RALLAR_BLACK_BOX_HEADLESS_ENTRY');
    if (!value || value === 'headless') {
        return 'headless';
    }
    if (value === 'operator-spa') {
        return 'operator-spa';
    }
    throw new Error(
        'RALLAR_BLACK_BOX_HEADLESS_ENTRY must be operator-spa or headless'
    );
}

function readEnvironmentBrowserLogLevel(
    env: HeadlessWorkerEnvironment,
    key: string,
    fallback: HeadlessWorkerBrowserLogLevel
): HeadlessWorkerBrowserLogLevel {
    const raw = readEnvironmentString(env, key);
    if (!raw) {
        return fallback;
    }
    if (raw === 'warning' || raw === 'info' || raw === 'debug') {
        return raw;
    }
    throw new Error(
        `${key} must be warning, info, or debug. Received: ${raw}`
    );
}

function readEnvironmentExitMode(
    env: HeadlessWorkerEnvironment
): HeadlessWorkerExitMode {
    const raw = readEnvironmentString(env, 'RALLAR_BLACK_BOX_EXIT_MODE');
    if (!raw) {
        return DEFAULT_EXIT_MODE;
    }
    if (
        raw === 'signal' ||
        raw === 'after-target-distributed-run-terminal' ||
        raw === 'after-idle-ms'
    ) {
        return raw;
    }
    throw new Error(
        'RALLAR_BLACK_BOX_EXIT_MODE must be signal, after-target-distributed-run-terminal, or after-idle-ms'
    );
}

function readEnvironmentBrowserEngine(
    env: HeadlessWorkerEnvironment
): HeadlessWorkerBrowserEngine {
    const value = readEnvironmentString(env, 'RALLAR_BLACK_BOX_BROWSER_ENGINE');
    if (!value) {
        return DEFAULT_BROWSER_ENGINE;
    }
    if (value === 'chromium' || value === 'firefox' || value === 'webkit') {
        return value;
    }
    throw new Error(
        'RALLAR_BLACK_BOX_BROWSER_ENGINE must be chromium, firefox, or webkit'
    );
}

function toBaseUrlWithoutTrailingSlash(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value;
}
