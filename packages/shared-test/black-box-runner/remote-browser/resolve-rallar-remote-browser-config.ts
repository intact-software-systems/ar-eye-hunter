// deno-lint-ignore-file no-explicit-any
import type { ApiJsonValue } from '../../../shared/api/api-json-value.ts';

import { decodeTrimmedText } from '../../rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { getRemoteBrowserRunnerOptions } from '../execution/remote-browser-execution.ts';

export interface RallarRemoteBrowserConfig {
    readonly controlBaseUrl: string;
    readonly runId: string;
    readonly agentId: string;
    /** Absent when neither the step, the runner options nor the environment names a control token. */
    readonly token?: string;
    readonly pollIntervalMs: number;
    readonly timeoutMs: number;
}

/** A step request, interaction config or runner option block; every setting read from it is decoded before use. */
export type RallarRemoteBrowserSettingSource = Readonly<Partial<Record<keyof RallarRemoteBrowserConfig, ApiJsonValue>>>;

export interface ResolveRallarRemoteBrowserConfigInput {
    readonly request: RallarRemoteBrowserSettingSource;
    readonly config: RallarRemoteBrowserSettingSource;
    readonly context: any;
}

const ENVIRONMENT_KEYS = {
    controlBaseUrl: 'RALLAR_BLACK_BOX_CONTROL_BASE_URL',
    runId: 'RALLAR_BLACK_BOX_RUN_ID',
    agentId: 'RALLAR_BLACK_BOX_AGENT_ID',
    token: 'RALLAR_BLACK_BOX_CONTROL_TOKEN'
} as const;

type RemoteBrowserTextSetting = keyof typeof ENVIRONMENT_KEYS;

/** The control-server environment variables the runner captured; an unset variable is absent. */
type RemoteBrowserEnvironment = Readonly<Partial<Record<typeof ENVIRONMENT_KEYS[RemoteBrowserTextSetting], string>>>;

interface RemoteBrowserConfigSources {
    readonly request: RallarRemoteBrowserSettingSource;
    readonly config: RallarRemoteBrowserSettingSource;
    readonly runnerOptions: RallarRemoteBrowserSettingSource;
    readonly environment: RemoteBrowserEnvironment;
}

const DEFAULT_CONTROL_BASE_URL = 'http://localhost:5180';
const DEFAULT_RUN_ID = 'remote-browser-run';
const DEFAULT_AGENT_ID = 'visible-agent-local';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

/**
 * Text settings take the first non-blank value from the step, the interaction config, the runner options and the
 * environment; interval and timeout take the first value the step or the runner options set.
 */
export function resolveRallarRemoteBrowserConfig(
    input: ResolveRallarRemoteBrowserConfigInput
): RallarRemoteBrowserConfig {
    const sources: RemoteBrowserConfigSources = {
        request: input.request,
        config: input.config,
        runnerOptions: getRemoteBrowserRunnerOptions(input.context),
        environment: input.context.remoteBrowserEnvironment ?? {}
    };
    const token = resolveSettingText(sources, 'token');
    return {
        controlBaseUrl: resolveSettingText(sources, 'controlBaseUrl') ?? DEFAULT_CONTROL_BASE_URL,
        runId: resolveSettingText(sources, 'runId') ?? DEFAULT_RUN_ID,
        agentId: resolveSettingText(sources, 'agentId') ?? DEFAULT_AGENT_ID,
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
        sources.request[setting],
        sources.config[setting],
        sources.runnerOptions[setting],
        sources.environment[ENVIRONMENT_KEYS[setting]]
    ]
        .map(decodeTrimmedText)
        .find((text) => text !== undefined);
}

function resolveSettingNumber(
    sources: RemoteBrowserConfigSources,
    setting: 'pollIntervalMs' | 'timeoutMs'
): number | undefined {
    return decodePositiveNumber(sources.request[setting] ?? sources.runnerOptions[setting]);
}

function decodePositiveNumber(value: ApiJsonValue | undefined): number | undefined {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
