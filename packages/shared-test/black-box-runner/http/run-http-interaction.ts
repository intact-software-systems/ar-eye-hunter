// deno-lint-ignore-file no-explicit-any
import { Either } from '../../../shared/resilience/Either.ts';
import { toError } from '../../../shared/resilience/to-error.ts';

import type { BlackBoxFetch } from '../execution/black-box-scenario-context.ts';
import {
    hasPollUntilPolicy,
    toBackoffMs,
    withPollUntil
} from '../execution/with-poll-until.ts';
import { toHttpInteractionStatus } from './http-response-expectations.ts';

export interface RunHttpInteractionInput {
    readonly interaction: any;
    readonly config: any;
    readonly now: () => number;
    readonly fetch: BlackBoxFetch;
}

interface HttpRetryPolicy {
    readonly maxAttempts: number;
    readonly backoffMs: number;
    readonly backoffMultiplier: number;
    readonly onStatus: any;
    readonly onException: boolean;
}

interface HttpAttemptCount {
    readonly attemptNumber: number;
    readonly maxAttempts: number;
}

interface HttpAttemptInput extends HttpAttemptCount {
    readonly request: any;
    readonly fetch: BlackBoxFetch;
    readonly retryPolicy: HttpRetryPolicy;
}

interface HttpAttemptResponse extends HttpAttemptCount {
    readonly response: Response;
    readonly retriesOnStatus: boolean;
}

interface HttpAttemptFailure extends HttpAttemptCount {
    readonly error: Error;
}

interface HttpResponseStatusInput {
    readonly config: any;
    readonly interaction: any;
    readonly attempt: HttpAttemptResponse;
}

interface HttpExceptionStatusInput {
    readonly config: any;
    readonly interaction: any;
    readonly error: Error;
    /** Absent when the failure came from evaluating a received response rather than from sending the request. */
    readonly attempt: HttpAttemptCount | undefined;
}

const FAILURE = 'FAILURE';

export function runHttpInteraction(input: RunHttpInteractionInput): Promise<any> {
    if (hasPollUntilPolicy(input.interaction.request)) {
        return withPollUntil({
            now: input.now,
            request: input.interaction.request,
            execute: () => runHttpAttempts(input)
        });
    }

    return runHttpAttempts(input);
}

function runHttpAttempts(input: RunHttpInteractionInput): Promise<any> {
    const { interaction, config } = input;
    return sendHttpRequestWithRetry(interaction.request, input.fetch)
        .then((sent) =>
            sent.fold(
                (failure) => toHttpExceptionStatus({ config, interaction, error: failure.error, attempt: failure }),
                (attempt) => toHttpResponseStatus({ config, interaction, attempt })
            )
        )
        .catch((caught) => toHttpExceptionStatus({ config, interaction, error: toError(caught), attempt: undefined }));
}

async function toHttpResponseStatus(input: HttpResponseStatusInput): Promise<any> {
    const { config, interaction, attempt } = input;
    const { response } = attempt;
    return toHttpInteractionStatus({
        config,
        interaction,
        response: {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            headers: response.headers,
            blackBoxAttemptNumber: attempt.attemptNumber,
            blackBoxMaxAttempts: attempt.maxAttempts
        },
        actualJson: await readResponseJson(response)
    });
}

async function sendHttpRequestWithRetry(
    request: any,
    fetch: BlackBoxFetch
): Promise<Either<HttpAttemptFailure, HttpAttemptResponse>> {
    const retryPolicy = toRetryPolicy(request);
    const maxAttempts = Number.isFinite(retryPolicy.maxAttempts) && retryPolicy.maxAttempts > 0
        ? retryPolicy.maxAttempts
        : 1;

    for (let attemptNumber = 1;; attemptNumber++) {
        const attempt = await sendHttpAttempt({ request, fetch, retryPolicy, attemptNumber, maxAttempts });
        const retries = attempt.fold(
            (failure) => retryPolicy.onException && failure.attemptNumber < maxAttempts,
            (received) => received.retriesOnStatus
        );
        if (!retries) {
            return attempt;
        }
        await waitForBackoff(toBackoffMs(retryPolicy, attemptNumber));
    }
}

async function sendHttpAttempt(input: HttpAttemptInput): Promise<Either<HttpAttemptFailure, HttpAttemptResponse>> {
    const { request, fetch, retryPolicy, attemptNumber, maxAttempts } = input;
    try {
        const response = await sendHttpRequest(request, fetch);
        return Either.ofRight({
            attemptNumber,
            maxAttempts,
            response,
            retriesOnStatus: attemptNumber < maxAttempts && isRetryStatus(response, retryPolicy)
        });
    }
    catch (caught) {
        return Either.ofLeft({ attemptNumber, maxAttempts, error: toError(caught) });
    }
}

function sendHttpRequest(request: any, fetch: BlackBoxFetch): Promise<Response> {
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

function toRetryPolicy(request: any): HttpRetryPolicy {
    const retry = request?.resilience?.retry || request?.retry || {};

    return {
        maxAttempts: Number.parseInt(retry.maxAttempts || 1),
        backoffMs: Number.parseInt(retry.backoffMs || 0),
        backoffMultiplier: Number.parseFloat(retry.backoffMultiplier || 1),
        onStatus: retry.onStatus || [],
        onException: retry.onException !== false
    };
}

function isRetryStatus(response: Response, retryPolicy: HttpRetryPolicy): boolean {
    return retryPolicy.onStatus
        .map((status: any) => Number.parseInt(status))
        .includes(response.status);
}

function toBody(request: any): BodyInit | undefined {
    if (request.form) {
        return new URLSearchParams(request.form);
    }

    return request.body && request.method !== undefined && request.method !== 'GET'
        ? JSON.stringify(request.body)
        : undefined;
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

function toHttpExceptionStatus(input: HttpExceptionStatusInput): any {
    const { config, interaction, error, attempt } = input;
    return {
        name: config.interactionName,
        exception: error.name === 'AbortError'
            ? 'Request timed out after ' + interaction.request.timeoutMs + ' ms'
            : error.message,
        status: FAILURE,
        ...toCorrelationReportFields(interaction),
        method: interaction.request.method || 'GET',
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        attemptNumber: attempt?.attemptNumber,
        maxAttempts: attempt?.maxAttempts,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        ...config
    };
}

function readResponseJson(response: Response): Promise<any> {
    return response.json()
        .catch(() => {
            return {};
        });
}

async function waitForBackoff(backoffMs: number): Promise<void> {
    if (backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
}
