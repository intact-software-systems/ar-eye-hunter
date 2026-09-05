// deno-lint-ignore-file no-explicit-any
import { withPollUntil } from '../execution/with-poll-until.ts';
import { toHttpInteractionStatus } from './http-response-expectations.ts';

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

function isRecord(value: any): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRetryPolicy(request: any): any {
    const retry = request?.resilience?.retry || request?.retry || {};

    return {
        maxAttempts: Number.parseInt(retry.maxAttempts || 1),
        backoffMs: Number.parseInt(retry.backoffMs || 0),
        backoffMultiplier: Number.parseFloat(retry.backoffMultiplier || 1),
        onStatus: retry.onStatus || [],
        onException: retry.onException !== false
    };
}

function shouldRetryStatus(response: any, retryPolicy: any): boolean {
    return retryPolicy.onStatus
        .map((status: any) => Number.parseInt(status))
        .includes(response.status);
}

function toBackoffMs(retryPolicy: any, attemptNumber: number): number {
    return retryPolicy.backoffMs * Math.pow(retryPolicy.backoffMultiplier, attemptNumber - 1);
}

async function fetchWithRetry(request: any): Promise<any> {
    const retryPolicy = toRetryPolicy(request);
    const maxAttempts = Number.isFinite(retryPolicy.maxAttempts) && retryPolicy.maxAttempts > 0
        ? retryPolicy.maxAttempts
        : 1;

    let lastException: any;

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
        try {
            const response = await fetchDataBasic(request) as any;

            response.blackBoxAttemptNumber = attemptNumber;
            response.blackBoxMaxAttempts = maxAttempts;

            if (attemptNumber < maxAttempts && shouldRetryStatus(response, retryPolicy)) {
                const backoffMs = toBackoffMs(retryPolicy, attemptNumber);
                if (backoffMs > 0) {
                    await sleep(backoffMs);
                }
                continue;
            }

            return response;
        }
        catch (e) {
            lastException = e instanceof Error
                ? e
                : new Error(String(e));

            lastException.blackBoxAttemptNumber = attemptNumber;
            lastException.blackBoxMaxAttempts = maxAttempts;

            if (!retryPolicy.onException || attemptNumber >= maxAttempts) {
                throw lastException;
            }

            const backoffMs = toBackoffMs(retryPolicy, attemptNumber);
            if (backoffMs > 0) {
                await sleep(backoffMs);
            }
        }
    }

    throw lastException || new Error('Request failed without response');
}

function toBody(request: any): BodyInit | undefined {
    if (request.form) {
        return new URLSearchParams(request.form);
    }

    return request.body && request.method !== undefined && request.method !== 'GET'
        ? JSON.stringify(request.body)
        : undefined;
}

async function toJson(res: Response): Promise<any> {
    return res.json()
        .catch(() => {
            return {};
        });
}

function fetchDataBasic(request: any): Promise<Response> {
    const controller = request.timeoutMs
        ? new AbortController()
        : undefined;

    const timeout = request.timeoutMs
        ? setTimeout(() => controller?.abort(), Number.parseInt(request.timeoutMs))
        : undefined;

    return fetch(
        request.path,
        {
            method: request.method,
            credentials: request.credentials ? request.credentials : 'omit',
            mode: request.mode ? request.mode : 'cors',
            headers: request.headers,
            body: toBody(request),
            signal: controller?.signal
        }
    ).finally(() => {
        if (timeout) {
            clearTimeout(timeout);
        }
    });
}

function toHttpExceptionStatus(config: any, interaction: any, error: any): any {
    return {
        name: config.interactionName,
        exception: error?.name === 'AbortError'
            ? 'Request timed out after ' + interaction.request.timeoutMs + ' ms'
            : error?.message,
        status: FAILURE,
        ...toCorrelationReportFields(interaction),
        method: interaction.request.method || 'GET',
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        attemptNumber: error.blackBoxAttemptNumber,
        maxAttempts: error.blackBoxMaxAttempts,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        ...config
    };
}

function executeSingleHttpAttempt(interaction: any, config: any): Promise<any> {
    return fetchWithRetry(interaction.request)
        .then(async (response) => {
            const actualJson = await toJson(response);
            return toHttpInteractionStatus(config, interaction, response, actualJson);
        })
        .catch((e) => {
            return toHttpExceptionStatus(config, interaction, e);
        });
}

function isPollUntilHttpRequest(request: any): boolean {
    return String(request?.action || '').toLowerCase() === 'poll-until' ||
        isRecord(request?.poll);
}

// Success is the step's own expect passing; exhaustion of either bound is a

export function executeHttpInteraction(interaction: any, config: any): Promise<any> {
    if (isPollUntilHttpRequest(interaction.request)) {
        return withPollUntil({
            request: interaction.request,
            execute: () => executeSingleHttpAttempt(interaction, config)
        });
    }

    return executeSingleHttpAttempt(interaction, config);
}
