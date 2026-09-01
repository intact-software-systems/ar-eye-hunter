// deno-lint-ignore-file no-explicit-any
import { isRecord } from './black-box-redaction.ts';

export interface RunnerCorrelationConfig {
    runnerRunId: string;
    enabled: boolean;
    injectHeaders: boolean;
    injectPayloads: boolean;
    runIdHeader: string;
    stepIdHeader: string;
    payloadField: string;
}

export function randomUuid(): string {
    const cryptoApi = globalThis.crypto as Crypto | undefined;
    if (cryptoApi?.randomUUID) {
        return cryptoApi.randomUUID();
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
        const random = Math.floor(Math.random() * 16);
        const value = character === 'x' ? random : (random & 0x3) | 0x8;
        return value.toString(16);
    });
}

export function stringOption(...values: any[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }

    return undefined;
}

function booleanOption(...values: any[]): boolean {
    return values.some((value) => value === true);
}

export function toRunnerCorrelationConfig(options: any = {}): RunnerCorrelationConfig {
    const rawCorrelation = isRecord(options.correlation)
        ? options.correlation
        : {};
    const enabled = options.correlation !== false && rawCorrelation.enabled !== false;

    return {
        runnerRunId: stringOption(
            rawCorrelation.runnerRunId,
            rawCorrelation.runId,
            options.runnerRunId,
            options.runId
        ) || 'bb-run-' + randomUuid(),
        enabled,
        injectHeaders: enabled && booleanOption(
            rawCorrelation.injectHeaders,
            rawCorrelation.headerInjection,
            rawCorrelation.headers
        ),
        injectPayloads: enabled && booleanOption(
            rawCorrelation.injectPayloads,
            rawCorrelation.injectPayload,
            rawCorrelation.payloadInjection,
            rawCorrelation.payloads
        ),
        runIdHeader: stringOption(
            rawCorrelation.runIdHeader,
            rawCorrelation.runnerRunIdHeader,
            rawCorrelation.headers && isRecord(rawCorrelation.headers) ? rawCorrelation.headers.runId : undefined,
            rawCorrelation.headers && isRecord(rawCorrelation.headers) ? rawCorrelation.headers.runnerRunId : undefined
        ) || 'x-rallar-black-box-run-id',
        stepIdHeader: stringOption(
            rawCorrelation.stepIdHeader,
            rawCorrelation.runnerStepIdHeader,
            rawCorrelation.headers && isRecord(rawCorrelation.headers) ? rawCorrelation.headers.stepId : undefined,
            rawCorrelation.headers && isRecord(rawCorrelation.headers) ? rawCorrelation.headers.runnerStepId : undefined
        ) || 'x-rallar-black-box-step-id',
        payloadField: stringOption(
            rawCorrelation.payloadField,
            rawCorrelation.payloadKey,
            rawCorrelation.field
        ) || 'blackBoxRunner'
    };
}

export function toPublicCorrelationConfig(config: RunnerCorrelationConfig): any {
    return {
        runnerRunId: config.runnerRunId,
        enabled: config.enabled,
        injection: {
            headers: config.injectHeaders,
            payloads: config.injectPayloads,
            runIdHeader: config.runIdHeader,
            stepIdHeader: config.stepIdHeader,
            payloadField: config.payloadField
        }
    };
}

export function toCorrelationReportFields(interaction: any): any {
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
