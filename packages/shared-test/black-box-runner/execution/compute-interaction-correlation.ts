// deno-lint-ignore-file no-explicit-any
import { isRecord } from './black-box-redaction.ts';
import { stringOption, type RunnerCorrelationConfig } from './black-box-run-correlation.ts';

export interface InteractionCorrelationInput {
    readonly request: any;
    readonly transport: string;
    readonly interactionName: string;
    readonly correlationConfig: RunnerCorrelationConfig;
    readonly runIndex: any;
}

interface RunnerStepCorrelation {
    readonly runnerRunId: string;
    readonly runnerStepId: string;
    readonly runIndex: number;
    readonly scenarioExecutionNumber: any;
    readonly interactionExecutionNumber: any;
    readonly repeatIndex: any;
    readonly interactionName: string;
}

export function computeInteractionCorrelation(input: InteractionCorrelationInput): any {
    const { request, correlationConfig } = input;
    const correlation = toStepCorrelation(input);
    const transport = input.transport === 'WEBRTC' ? 'RTC' : input.transport === 'MQ' ? 'UNKNOWN' : input.transport;
    const injectHeaders = correlationConfig.injectHeaders && transport === 'HTTP';
    const payloadKey = request.send !== undefined ? 'send' : request.message !== undefined ? 'message' : 'body';
    const payload = request[payloadKey];
    const injectPayload = correlationConfig.injectPayloads &&
        String(request.action || 'send').toLowerCase() === 'send' &&
        (transport === 'WS' || transport === 'RTC') && isRecord(payload);

    return {
        ...request,
        runnerRunId: correlation.runnerRunId,
        runnerStepId: correlation.runnerStepId,
        correlation: {
            ...correlation,
            transport,
            injected: { headers: injectHeaders, payload: injectPayload }
        },
        ...(injectHeaders
            ? {
                headers: {
                    ...(isRecord(request.headers) ? request.headers : {}),
                    [correlationConfig.runIdHeader]: correlation.runnerRunId,
                    [correlationConfig.stepIdHeader]: correlation.runnerStepId
                }
            }
            : {}),
        ...(injectPayload
            ? {
                [payloadKey]: {
                    ...payload,
                    [correlationConfig.payloadField]: {
                        ...(isRecord(payload[correlationConfig.payloadField])
                            ? payload[correlationConfig.payloadField]
                            : {}),
                        runnerRunId: correlation.runnerRunId,
                        runnerStepId: correlation.runnerStepId
                    }
                }
            }
            : {})
    };
}

function toStepCorrelation(input: InteractionCorrelationInput): RunnerStepCorrelation {
    const { request, correlationConfig, interactionName } = input;
    const runIndex = Number.parseInt(String(input.runIndex || request.runIndex || 1), 10) || 1;
    const runnerStepId = stringOption(request.runnerStepId, request.correlation?.runnerStepId) ||
        toRunnerStepId(input, runIndex);

    return {
        runnerRunId: correlationConfig.runnerRunId,
        runnerStepId,
        runIndex,
        scenarioExecutionNumber: request.scenarioExecutionNumber,
        interactionExecutionNumber: request.interactionExecutionNumber,
        repeatIndex: request.repeatIndex,
        interactionName
    };
}

function toRunnerStepId(input: InteractionCorrelationInput, runIndex: number): string {
    const { request, correlationConfig, interactionName } = input;
    const scenarioExecutionNumber = Number.parseInt(String(request.scenarioExecutionNumber || 1), 10) || 1;
    const interactionExecutionNumber = Number.parseInt(String(request.interactionExecutionNumber || 0), 10) || 0;
    const repeatIndex = Number.parseInt(String(request.repeatIndex || 1), 10) || 1;
    const safeName = String(interactionName || 'step')
        .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'step';

    return [
        correlationConfig.runnerRunId,
        'run',
        runIndex,
        'scenario',
        scenarioExecutionNumber,
        'step',
        interactionExecutionNumber,
        safeName,
        'repeat',
        repeatIndex
    ].join('-');
}
