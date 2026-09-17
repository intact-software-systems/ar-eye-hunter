// deno-lint-ignore-file no-explicit-any
import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';

import { decodeTrimmedText } from '../../rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '../../rallar-bb-test/schema/json-schema-validation.ts';
import { getRemoteBrowserRunnerOptions } from '../execution/remote-browser-execution.ts';

export interface RallarRemoteBrowserConfig {
    readonly controlBaseUrl: string;
    readonly runId: string;
    readonly agentId: string;
    /** Absent when no control block, interaction config, runner option or environment variable names a token. */
    readonly token?: string;
    readonly pollIntervalMs: number;
    readonly timeoutMs: number;
}

/** An interaction config or runner option block; every setting read from it is decoded before use. */
export type RallarRemoteBrowserSettingSource = Readonly<Partial<Record<keyof RallarRemoteBrowserConfig, ApiJsonValue>>>;

/** The members of a step request that address the control server; every value is decoded before use. */
export interface RallarRemoteBrowserStepSettings {
    /** Absent when the step leaves control-server settings to the interaction config, runner options or environment. */
    readonly control?: ApiJsonValue;
    /** Absent when the step names no timeout of its own. */
    readonly timeoutMs?: ApiJsonValue;
}

export interface ResolveRallarRemoteBrowserConfigInput {
    readonly request: RallarRemoteBrowserStepSettings;
    readonly config: RallarRemoteBrowserSettingSource;
    readonly context: any;
}

const CONTROL_BLOCK_KEYS = {
    controlBaseUrl: 'baseUrl',
    runId: 'runId',
    agentId: 'agentId',
    token: 'token'
} as const;

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
    readonly control: ApiJsonObject;
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
 * A recipe addresses the control server through the step's `control` block, usually declared once on its connection.
 * Text settings take the first non-blank value from that block, the interaction config, the runner options and the
 * environment; the polling interval takes the block's, then the runner options'. The step's own `timeoutMs` outranks
 * both timeouts, because the browser runs the command under it and its result cannot arrive sooner.
 */
export function resolveRallarRemoteBrowserConfig(
    input: ResolveRallarRemoteBrowserConfigInput
): RallarRemoteBrowserConfig {
    const sources: RemoteBrowserConfigSources = {
        control: isJsonRecordValue(input.request.control) ? input.request.control : {},
        config: input.config,
        runnerOptions: getRemoteBrowserRunnerOptions(input.context),
        environment: input.context.remoteBrowserEnvironment ?? {}
    };
    const token = resolveSettingText(sources, 'token');
    const pollIntervalMs = sources.control.pollIntervalMs ?? sources.runnerOptions.pollIntervalMs;
    const timeoutMs = input.request.timeoutMs ?? sources.control.timeoutMs ?? sources.runnerOptions.timeoutMs;
    return {
        controlBaseUrl: resolveSettingText(sources, 'controlBaseUrl') ?? DEFAULT_CONTROL_BASE_URL,
        runId: resolveSettingText(sources, 'runId') ?? DEFAULT_RUN_ID,
        agentId: resolveSettingText(sources, 'agentId') ?? DEFAULT_AGENT_ID,
        ...(token === undefined ? {} : { token }),
        pollIntervalMs: decodePositiveNumber(pollIntervalMs) ?? DEFAULT_POLL_INTERVAL_MS,
        timeoutMs: decodePositiveNumber(timeoutMs) ?? DEFAULT_TIMEOUT_MS
    };
}

function resolveSettingText(
    sources: RemoteBrowserConfigSources,
    setting: RemoteBrowserTextSetting
): string | undefined {
    return [
        sources.control[CONTROL_BLOCK_KEYS[setting]],
        sources.config[setting],
        sources.runnerOptions[setting],
        sources.environment[ENVIRONMENT_KEYS[setting]]
    ]
        .map(decodeTrimmedText)
        .find((text) => text !== undefined);
}

function decodePositiveNumber(value: ApiJsonValue | undefined): number | undefined {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
