// deno-lint-ignore-file no-explicit-any
import { compareJson, COMPARISON, toConfig } from '../../json-compare/CompareJson.ts';
import { normalizeBlackBoxResponseHeaders } from './normalize-black-box-response-headers.ts';

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

function toOutputReportFields(interaction: any): any {
    return {
        output: interaction.request.output,
        outputPath: interaction.request.outputPath,
        outputs: interaction.request.outputs,
        transform: interaction.request.transform,
        secret: interaction.request.secret,
        redact: interaction.request.redact,
        redactAs: interaction.request.redactAs,
    };
}

function toCorrelationReportFields(interaction: any): any {
    const correlation = interaction?.request?.correlation;
    if (!correlation) {
        return {};
    }

    return {
        runnerRunId: correlation.runnerRunId,
        runnerStepId: correlation.runnerStepId,
        correlation,
    };
}

export function toStatus(
    config: any,
    result: string,
    actualJson: any,
    res: any,
    interaction: any,
    results: any = {},
): any {
    return {
        name: config.interactionName,
        status: FAILURE,
        result,
        ...toCorrelationReportFields(interaction),
        method: interaction.request.method || 'GET',
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        attemptNumber: res.blackBoxAttemptNumber,
        maxAttempts: res.blackBoxMaxAttempts,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            body: actualJson,
            headers: normalizeBlackBoxResponseHeaders(res.headers),
            statusCode: res.status,
            statusText: res.statusText,
        },
        details: results,
        ...config,
    };
}

function toSuccessStatus(config: any, actualJson: any, response: any, interaction: any): any {
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
            statusText: response.statusText,
        },
        ...toOutputReportFields(interaction),
        input: interaction.request.input,
    };
}

function toNumberList(value: unknown): number[] {
    if (Array.isArray(value)) {
        return value
            .map(item => Number.parseInt(String(item), 10))
            .filter(item => Number.isFinite(item));
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
        ...toNumberList(response?.allowedStatusCodes),
    ];
}

function bodyExpectationAlternatives(response: any): any[] {
    const alternatives = response?.bodyAnyOf ?? response?.anyBodyOf ?? response?.bodyIn;

    return Array.isArray(alternatives)
        ? alternatives
        : [];
}

function compareExpectedBody(expectedBody: any, actualJson: any, interaction: any): any {
    return compareJson(
        expectedBody,
        actualJson,
        toConfig(
            interaction.response?.comparison || COMPARISON.COMPATIBLE,
            interaction.response?.ignoreJsonKeys || [],
            interaction.response?.ignoreJsonPaths || [],
        ),
    );
}

export function toHttpInteractionStatus(
    config: any,
    interaction: any,
    response: any,
    actualJson: any,
): any {
    const expectedStatuses = expectedHttpStatusCodes(interaction.response);
    const hasExpectedStatus = expectedStatuses.length > 0;

    const actualStatusCode = Number.parseInt(String(response.status), 10);
    if (hasExpectedStatus && !expectedStatuses.includes(actualStatusCode)) {
        return toStatus(
            config,
            'Expected responseCode not the same as actual responseCode',
            actualJson,
            response,
            interaction,
            {
                expectedStatusCodes: expectedStatuses,
            },
        );
    }

    if (!response.ok && !hasExpectedStatus) {
        return toStatus(config, 'Server request failed.', actualJson, response, interaction);
    }

    const bodyAlternatives = bodyExpectationAlternatives(interaction.response);
    if (bodyAlternatives.length > 0) {
        if (actualJson === undefined || actualJson === null) {
            return toStatus(
                config,
                'Server with no body in response. Expects a body.',
                actualJson,
                response,
                interaction,
            );
        }

        const comparisons = bodyAlternatives.map(expectedBody =>
            compareExpectedBody(expectedBody, actualJson, interaction));
        const matchedIndex = comparisons.findIndex(result => result.isEqual);
        if (matchedIndex < 0) {
            return toStatus(
                config,
                'Expected response not to match any accepted response body',
                actualJson,
                response,
                interaction,
                {
                    bodyAnyOf: bodyAlternatives,
                    comparisons,
                },
            );
        }
    } else if (interaction?.response?.body !== undefined) {
        if (actualJson === undefined || actualJson === null) {
            return toStatus(
                config,
                'Server with no body in response. Expects a body.',
                actualJson,
                response,
                interaction,
            );
        }

        const results = compareExpectedBody(interaction.response.body, actualJson, interaction);

        if (!results.isEqual) {
            return toStatus(
                config,
                'Expected response not the same as actual response',
                actualJson,
                response,
                interaction,
                results,
            );
        }
    }

    return toSuccessStatus(config, actualJson, response, interaction);
}
