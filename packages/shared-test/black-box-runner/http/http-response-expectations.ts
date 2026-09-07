// deno-lint-ignore-file no-explicit-any
import { Either } from '../../../shared/resilience/Either.ts';
import { compareJson, COMPARISON, toConfig, type ComparisonResult } from '../../json-compare/compare-json-values.ts';
import { toInteractionOutputFields } from '../execution/black-box-scenario-results.ts';
import { normalizeBlackBoxResponseHeaders } from './normalize-black-box-response-headers.ts';

export interface ToHttpStatusInput {
    readonly config: any;
    readonly result: string;
    readonly actualJson: any;
    readonly response: any;
    readonly interaction: any;
    readonly details?: any;
}

export interface ToHttpInteractionStatusInput {
    readonly config: any;
    readonly interaction: any;
    readonly response: any;
    readonly actualJson: any;
}

interface HttpResponseMismatch {
    readonly result: string;
    readonly details?: Readonly<Record<string, unknown>>;
}

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

function isRecord(value: any): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toLowercaseHeaderNames(expectedHeaders: Record<string, any>): Record<string, any> {
    return Object.fromEntries(
        Object.entries(expectedHeaders)
            .map(([name, value]) => [String(name).toLowerCase(), value])
    );
}

function compareExpectedHeaders(interaction: any, response: any): ComparisonResult | undefined {
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

function toCorrelationReportFields(interaction: any): any {
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

export function toStatus(input: ToHttpStatusInput): any {
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

function toSuccessStatus(input: ToHttpInteractionStatusInput): any {
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

function toNumberList(value: unknown): number[] {
    if (Array.isArray(value)) {
        return value
            .map((item) => Number.parseInt(String(item), 10))
            .filter((item) => Number.isFinite(item));
    }

    if (typeof value === 'string' && value.includes(',')) {
        return toNumberList(value.split(','));
    }

    if (value !== undefined && value !== null) {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed)
            ? [parsed]
            : [];
    }

    return [];
}

function expectedHttpStatusCodes(response: any): number[] {
    return [
        ...toNumberList(response?.statusCode),
        ...toNumberList(response?.status),
        ...toNumberList(response?.statusCodes),
        ...toNumberList(response?.allowedStatusCodes)
    ];
}

function bodyExpectationAlternatives(response: any): any[] {
    const alternatives = response?.bodyAnyOf ?? response?.anyBodyOf ?? response?.bodyIn;

    return Array.isArray(alternatives)
        ? alternatives
        : [];
}

function compareExpectedBody(expectedBody: any, actualJson: any, interaction: any): ComparisonResult {
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

export function toHttpInteractionStatus(input: ToHttpInteractionStatusInput): any {
    return validateHttpResponse(input).fold(
        (mismatch) => toStatus({ ...input, ...mismatch }),
        () => toSuccessStatus(input)
    );
}

function validateHttpResponse(input: ToHttpInteractionStatusInput): Either<HttpResponseMismatch, true> {
    const { interaction, response } = input;
    const statusMismatch = computeHttpStatusMismatch(interaction, response);
    if (statusMismatch) {
        return Either.ofLeft(statusMismatch);
    }
    const headerComparison = compareExpectedHeaders(interaction, response);
    if (headerComparison !== undefined && !headerComparison.isEqual) {
        return Either.ofLeft({
            result: 'Expected response headers not the same as actual response headers',
            details: { expectedHeaders: interaction.response.headers, headerComparison }
        });
    }
    const bodyMismatch = computeHttpBodyMismatch(input);
    return bodyMismatch ? Either.ofLeft(bodyMismatch) : Either.ofRight(true);
}

function computeHttpStatusMismatch(interaction: any, response: any): HttpResponseMismatch | undefined {
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
