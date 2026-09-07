import type { LocalWsRequest } from '../execution/local-websocket-session.ts';
import type {
    WsInteraction,
    WsInteractionRequest,
    WsInteractionResult
} from './ws-wait-expectations.ts';

export interface WsInteractionConfig {
    readonly interactionName?: string;
    readonly interaction: WsInteraction;
    readonly controlBaseUrl?: string;
    readonly runId?: string;
    readonly agentId?: string;
    readonly token?: string;
}

export interface ToWsFailureStatusInput {
    readonly config: WsInteractionConfig;
    readonly interaction: WsInteraction;
    readonly result: string;
    readonly details?: Readonly<Record<string, unknown>>;
}

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

function toOutputReportFields(
    interaction: WsInteraction
): Pick<WsInteractionRequest, 'output' | 'outputPath' | 'outputs' | 'transform' | 'secret' | 'redact' | 'redactAs'> {
    return {
        output: interaction.request.output,
        outputPath: interaction.request.outputPath,
        outputs: interaction.request.outputs,
        transform: interaction.request.transform,
        secret: interaction.request.secret,
        redact: interaction.request.redact,
        redactAs: interaction.request.redactAs
    };
}

interface WsCorrelationReportFields {
    readonly runnerRunId?: unknown;
    readonly runnerStepId?: unknown;
    readonly correlation?: WsInteractionRequest['correlation'];
}

function toCorrelationReportFields(interaction: WsInteraction): WsCorrelationReportFields {
    const correlation = interaction?.request?.correlation;
    if (!correlation) {
        return {};
    }

    return {
        runnerRunId: correlation.runnerRunId,
        runnerStepId: correlation.runnerStepId,
        correlation
    };
}

export function toWsConnectionName(request: LocalWsRequest): string {
    return request.connection || request.name || 'default';
}

export function toWsExpectedConnectionName(interaction: WsInteraction): string {
    return interaction.response?.connection ||
        interaction.response?.onConnection ||
        interaction.request?.expectConnection ||
        toWsConnectionName(interaction.request);
}

export function toWsSuccessStatus(
    config: WsInteractionConfig,
    interaction: WsInteraction,
    details: Readonly<Record<string, unknown>> = {}
): WsInteractionResult {
    return {
        name: config.interactionName,
        status: SUCCESS,
        transport: 'WS',
        ...toCorrelationReportFields(interaction),
        action: interaction.request.action,
        connection: interaction.request.connection || interaction.response?.connection,
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: details,
        ...toOutputReportFields(interaction),
        input: interaction.request.input
    };
}

export function toWsFailureStatus(input: ToWsFailureStatusInput): WsInteractionResult {
    const { config, interaction, result, details = {} } = input;
    return {
        name: config.interactionName,
        status: FAILURE,
        result,
        transport: 'WS',
        ...toCorrelationReportFields(interaction),
        action: interaction.request.action,
        connection: interaction.request.connection || interaction.response?.connection,
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: details,
        ...config
    };
}
