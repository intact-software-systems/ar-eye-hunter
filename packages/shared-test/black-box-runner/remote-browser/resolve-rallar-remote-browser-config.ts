// deno-lint-ignore-file no-explicit-any
import { decodeTrimmedText } from '../../rallar-bb-test/runtime/decode-runtime-result-values.ts';

/** Remote-browser settings given to the runner or a provider; an absent one falls through to the next source. */
export interface RallarRemoteBrowserOptions {
    /** Absent when these options name no control server. */
    readonly controlBaseUrl?: string;
    /** Absent when these options name no control run. */
    readonly runId?: string;
    /** Absent when these options name no browser agent. */
    readonly agentId?: string;
    /** Absent when these options carry no control token. */
    readonly token?: string;
    /** Absent when these options leave the polling interval to the step or the default. */
    readonly pollIntervalMs?: number;
    /** Absent when these options leave the command timeout to the step or the default. */
    readonly timeoutMs?: number;
}

export interface RallarRemoteBrowserConfig {
    readonly controlBaseUrl: string;
    readonly runId: string;
    readonly agentId: string;
    /** Absent when neither the step, the options nor the environment names a control token. */
    readonly token?: string;
    readonly pollIntervalMs: number;
    readonly timeoutMs: number;
}

export interface ResolveRallarRemoteBrowserConfigInput {
    readonly request: any;
    readonly config: any;
    readonly context: any;
    readonly options: RallarRemoteBrowserOptions;
}

interface RemoteBrowserConfigSources {
    readonly request: any;
    readonly control: any;
    readonly config: any;
    readonly runnerOptions: any;
    readonly options: RallarRemoteBrowserOptions;
    readonly environment: any;
}

interface RemoteBrowserTextSetting {
    readonly field: 'controlBaseUrl' | 'runId' | 'agentId' | 'token';
    readonly stepKeys: readonly string[];
    readonly controlKey: string;
    readonly environmentKey: string;
}

const CONTROL_BASE_URL_SETTING: RemoteBrowserTextSetting = {
    field: 'controlBaseUrl',
    stepKeys: ['controlBaseUrl', 'controlServerUrl'],
    controlKey: 'baseUrl',
    environmentKey: 'RALLAR_BLACK_BOX_CONTROL_BASE_URL'
};
const RUN_ID_SETTING: RemoteBrowserTextSetting = {
    field: 'runId',
    stepKeys: ['runId', 'controlRunId'],
    controlKey: 'runId',
    environmentKey: 'RALLAR_BLACK_BOX_RUN_ID'
};
const AGENT_ID_SETTING: RemoteBrowserTextSetting = {
    field: 'agentId',
    stepKeys: ['agentId', 'controlAgentId'],
    controlKey: 'agentId',
    environmentKey: 'RALLAR_BLACK_BOX_AGENT_ID'
};
const TOKEN_SETTING: RemoteBrowserTextSetting = {
    field: 'token',
    stepKeys: ['token', 'controlToken'],
    controlKey: 'token',
    environmentKey: 'RALLAR_BLACK_BOX_CONTROL_TOKEN'
};

const DEFAULT_CONTROL_BASE_URL = 'http://localhost:5180';
const DEFAULT_RUN_ID = 'remote-browser-run';
const DEFAULT_AGENT_ID = 'visible-agent-local';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

/**
 * Text settings take the first non-blank value from the step, its control block, the interaction config, the runner
 * options, the provider options and the environment; interval and timeout take the first value that is set.
 */
export function resolveRallarRemoteBrowserConfig(
    input: ResolveRallarRemoteBrowserConfigInput
): RallarRemoteBrowserConfig {
    const sources: RemoteBrowserConfigSources = {
        request: input.request,
        control: input.request.control ?? {},
        config: input.config,
        runnerOptions: input.context.options?.rallarRemoteBrowser ?? {},
        options: input.options,
        environment: input.context.remoteBrowserEnvironment ?? {}
    };
    const token = resolveSettingText(sources, TOKEN_SETTING);
    return {
        controlBaseUrl: resolveSettingText(sources, CONTROL_BASE_URL_SETTING) ?? DEFAULT_CONTROL_BASE_URL,
        runId: resolveSettingText(sources, RUN_ID_SETTING) ?? DEFAULT_RUN_ID,
        agentId: resolveSettingText(sources, AGENT_ID_SETTING) ?? DEFAULT_AGENT_ID,
        ...(token === undefined ? {} : { token }),
        pollIntervalMs: resolveSettingNumber(sources, 'pollIntervalMs') ?? DEFAULT_POLL_INTERVAL_MS,
        timeoutMs: resolveSettingNumber(sources, 'timeoutMs') ?? DEFAULT_TIMEOUT_MS
    };
}

function resolveSettingText(
    sources: RemoteBrowserConfigSources,
    setting: RemoteBrowserTextSetting
): string | undefined {
    return [
        ...setting.stepKeys.map((key) => sources.request[key]),
        sources.control[setting.controlKey],
        sources.config[setting.field],
        sources.runnerOptions[setting.field],
        sources.options[setting.field],
        sources.environment[setting.environmentKey]
    ]
        .map(decodeTrimmedText)
        .find((text) => text !== undefined);
}

function resolveSettingNumber(
    sources: RemoteBrowserConfigSources,
    field: 'pollIntervalMs' | 'timeoutMs'
): number | undefined {
    return decodePositiveNumber(
        sources.request[field] ?? sources.control[field] ?? sources.runnerOptions[field] ?? sources.options[field]
    );
}

function decodePositiveNumber(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
