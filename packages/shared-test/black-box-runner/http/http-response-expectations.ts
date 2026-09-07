import { Either } from '../../../shared/resilience/Either.ts';
import {
    compareJson,
    COMPARISON,
    toConfig,
    type ComparisonResult,
    type JsonComparisonObject,
    type JsonValue,
    type NotCompatibleResult
} from '../../json-compare/compare-json-values.ts';
import { toInteractionOutputFields } from '../execution/black-box-scenario-results.ts';
import type {
    RallarRemoteBrowserConfig,
    RallarRemoteBrowserControlResultEnvelope
} from '../rallar-remote-browser-provider.ts';
import { normalizeBlackBoxResponseHeaders } from './normalize-black-box-response-headers.ts';

interface HttpInteractionRequest {
    readonly method?: string;
    readonly path?: string;
    readonly timeoutMs?: number | string;
    readonly scenarioExecutionNumber?: number;
    readonly interactionExecutionNumber?: number;
    readonly repeatIndex?: number;
    readonly correlation?: JsonComparisonObject;
    readonly input?: JsonValue;
    readonly output?: JsonValue;
    readonly outputPath?: JsonValue;
    readonly outputs?: JsonValue;
    readonly transform?: JsonValue;
    readonly secret?: boolean;
    readonly redact?: boolean;
    readonly redactAs?: string;
}

interface HttpResponseExpectation {
    readonly headers?: JsonComparisonObject;
    readonly comparison?: string;
    readonly ignoreJsonKeys?: readonly string[];
    readonly ignoreJsonPaths?: readonly string[];
    readonly statusCode?: JsonValue;
    readonly status?: JsonValue;
    readonly statusCodes?: JsonValue;
    readonly allowedStatusCodes?: JsonValue;
    readonly body?: JsonValue;
    readonly bodyAnyOf?: JsonValue;
    readonly anyBodyOf?: JsonValue;
    readonly bodyIn?: JsonValue;
}

interface HttpInteraction {
    readonly request: HttpInteractionRequest;
    readonly response?: HttpResponseExpectation;
}

interface HttpInteractionConfig {
    readonly interactionName: string;
    readonly interaction: HttpInteraction;
    readonly interactionConfig?: JsonComparisonObject;
}

interface HttpResponseObservation {
    readonly status: number;
    readonly statusText: string;
    readonly ok?: boolean;
    readonly headers?: Headers | Readonly<Record<string, string>>;
    readonly blackBoxAttemptNumber?: number;
    readonly blackBoxMaxAttempts?: number;
}

export interface ToHttpStatusInput extends ToHttpInteractionStatusInput {
    readonly result: string;
    readonly details?: HttpResponseMismatchDetails | RemoteHttpFailureDetails;
}

export interface ToHttpInteractionStatusInput {
    readonly config: HttpInteractionConfig;
    readonly interaction: HttpInteraction;
    readonly response: HttpResponseObservation;
    readonly actualJson: JsonValue | undefined;
}

interface HttpInteractionStatus {
    readonly name: string;
    readonly status: 'SUCCESS' | 'FAILURE';
    readonly result?: string;
    readonly runnerRunId?: JsonValue;
    readonly runnerStepId?: JsonValue;
    readonly correlation?: JsonComparisonObject;
    readonly method?: string;
    readonly path?: string;
    readonly timeoutMs?: number | string;
    readonly attemptNumber?: number;
    readonly maxAttempts?: number;
    readonly scenarioExecutionNumber?: number;
    readonly interactionExecutionNumber?: number;
    readonly repeatIndex?: number;
    readonly expected?: HttpResponseExpectation;
    readonly actual: {
        readonly body: JsonValue | undefined;
        readonly headers: Readonly<Record<string, string>>;
        readonly statusCode: number;
        readonly statusText: string;
    };
    readonly details?: HttpResponseMismatchDetails | RemoteHttpFailureDetails;
    readonly input?: JsonValue;
    readonly output?: JsonValue;
    readonly outputPath?: JsonValue;
    readonly outputs?: JsonValue;
    readonly transform?: JsonValue;
    readonly secret?: boolean;
    readonly redact?: boolean;
    readonly redactAs?: string;
}

interface HttpResponseMismatch {
    readonly result: string;
    readonly details?: HttpResponseMismatchDetails;
}

type HttpResponseMismatchDetails = NotCompatibleResult | {
    readonly expectedStatusCodes?: readonly number[];
    readonly expectedHeaders?: JsonComparisonObject;
    readonly headerComparison?: NotCompatibleResult;
    readonly bodyAnyOf?: readonly (JsonValue | undefined)[];
    readonly comparisons?: readonly ComparisonResult[];
};

interface RemoteHttpFailureDetails {
    readonly remote: RallarRemoteBrowserConfig;
    readonly result: RallarRemoteBrowserControlResultEnvelope;
}

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

function isRecord(value: JsonValue | undefined): value is JsonComparisonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toLowercaseHeaderNames(expectedHeaders: JsonComparisonObject): JsonComparisonObject {
    return Object.fromEntries(
        Object.entries(expectedHeaders)
            .map(([name, value]) => [String(name).toLowerCase(), value])
    );
}

function compareExpectedHeaders(
    interaction: HttpInteraction,
    response: HttpResponseObservation
): ComparisonResult | undefined {
    const expectedHeaders = interaction.response?.headers;
    if (!isRecord(expectedHeaders)) {
        return undefined;
    }

    return compareJson(
        toLowercaseHeaderNames(expectedHeaders),
        normalizeBlackBoxResponseHeaders(response.headers),
        toConfig(
            interaction.response?.comparison || COMPARISON.COMPATIBLE,
            interaction.response?.ignoreJsonKeys || [],
            interaction.response?.ignoreJsonPaths || []
        )
    );
}

function toCorrelationReportFields(
    interaction: HttpInteraction
): Pick<HttpInteractionStatus, 'runnerRunId' | 'runnerStepId' | 'correlation'> {
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

export function toStatus(input: ToHttpStatusInput): HttpInteractionStatus {
    const { config, result, actualJson, response, interaction } = input;
    return {
        name: config.interactionName,
        status: FAILURE,
        result,
        ...toCorrelationReportFields(interaction),
        method: interaction.request.method || 'GET',
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        attemptNumber: response.blackBoxAttemptNumber,
        maxAttempts: response.blackBoxMaxAttempts,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            body: actualJson,
            headers: normalizeBlackBoxResponseHeaders(response.headers),
            statusCode: response.status,
            statusText: response.statusText
        },
        details: input.details ?? {},
        ...config
    };
}

function toSuccessStatus(input: ToHttpInteractionStatusInput): HttpInteractionStatus {
    const { config, actualJson, response, interaction } = input;
    return {
        name: config.interactionName,
        status: SUCCESS,
        ...toCorrelationReportFields(interaction),
        method: interaction.request.method,
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        attemptNumber: response.blackBoxAttemptNumber,
        maxAttempts: response.blackBoxMaxAttempts,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            body: actualJson,
            headers: normalizeBlackBoxResponseHeaders(response.headers),
            statusCode: response.status,
            statusText: response.statusText
        },
        ...toInteractionOutputFields(interaction),
        input: interaction.request.input
    };
}

function toNumberList(value: JsonValue | undefined): number[] {
    if (Array.isArray(value)) {
        return value
            .map((item) =>
                typeof item === 'string' || typeof item === 'number' ? Number.parseInt(String(item), 10) : Number.NaN
            )
            .filter((item) => Number.isFinite(item));
    }

    if (typeof value === 'string' && value.includes(',')) {
        return toNumberList(value.split(','));
    }

    if (typeof value === 'string' || typeof value === 'number') {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed)
            ? [parsed]
            : [];
    }

    return [];
}

function expectedHttpStatusCodes(response: HttpResponseExpectation | undefined): number[] {
    return [
        ...toNumberList(response?.statusCode),
        ...toNumberList(response?.status),
        ...toNumberList(response?.statusCodes),
        ...toNumberList(response?.allowedStatusCodes)
    ];
}

function bodyExpectationAlternatives(
    response: HttpResponseExpectation | undefined
): readonly (JsonValue | undefined)[] {
    const alternatives = response?.bodyAnyOf ?? response?.anyBodyOf ?? response?.bodyIn;

    return Array.isArray(alternatives)
        ? alternatives
        : [];
}

function compareExpectedBody(
    expectedBody: JsonValue | undefined,
    actualJson: JsonValue | undefined,
    interaction: HttpInteraction
): ComparisonResult {
    return compareJson(
        expectedBody,
        actualJson,
        toConfig(
            interaction.response?.comparison || COMPARISON.COMPATIBLE,
            interaction.response?.ignoreJsonKeys || [],
            interaction.response?.ignoreJsonPaths || []
        )
    );
}

export function toHttpInteractionStatus(input: ToHttpInteractionStatusInput): HttpInteractionStatus {
    return computeHttpResponseMismatch(input).fold(
        (mismatch) => toStatus({ ...input, ...mismatch }),
        () => toSuccessStatus(input)
    );
}

function computeHttpResponseMismatch(input: ToHttpInteractionStatusInput): Either<HttpResponseMismatch, true> {
    const { interaction, response } = input;
    const statusMismatch = computeHttpStatusMismatch(interaction, response);
    if (statusMismatch) {
        return Either.ofLeft(statusMismatch);
    }
    const headerComparison = compareExpectedHeaders(interaction, response);
    if (headerComparison !== undefined && !headerComparison.isEqual) {
        return Either.ofLeft({
            result: 'Expected response headers not the same as actual response headers',
            details: { expectedHeaders: interaction.response?.headers, headerComparison }
        });
    }
    const bodyMismatch = computeHttpBodyMismatch(input);
    return bodyMismatch ? Either.ofLeft(bodyMismatch) : Either.ofRight(true);
}

function computeHttpStatusMismatch(
    interaction: HttpInteraction,
    response: HttpResponseObservation
): HttpResponseMismatch | undefined {
    const expectedStatuses = expectedHttpStatusCodes(interaction.response);
    const actualStatusCode = Number.parseInt(String(response.status), 10);
    if (expectedStatuses.length > 0 && !expectedStatuses.includes(actualStatusCode)) {
        return {
            result: 'Expected responseCode not the same as actual responseCode',
            details: { expectedStatusCodes: expectedStatuses }
        };
    }
    return !response.ok && expectedStatuses.length === 0 ? { result: 'Server request failed.' } : undefined;
}

function computeHttpBodyMismatch(input: ToHttpInteractionStatusInput): HttpResponseMismatch | undefined {
    const { interaction, actualJson } = input;
    const bodyAlternatives = bodyExpectationAlternatives(interaction.response);
    const expectsBody = bodyAlternatives.length > 0 || interaction.response?.body !== undefined;
    if (expectsBody && (actualJson === undefined || actualJson === null)) {
        return { result: 'Server with no body in response. Expects a body.' };
    }
    if (bodyAlternatives.length > 0) {
        const comparisons = bodyAlternatives.map((body) => compareExpectedBody(body, actualJson, interaction));
        return comparisons.some((comparison) => comparison.isEqual) ? undefined : {
            result: 'Expected response not to match any accepted response body',
            details: { bodyAnyOf: bodyAlternatives, comparisons }
        };
    }
    if (interaction.response?.body !== undefined) {
        const comparison = compareExpectedBody(interaction.response.body, actualJson, interaction);
        if (!comparison.isEqual) {
            return { result: 'Expected response not the same as actual response', details: comparison };
        }
    }
    return undefined;
}
