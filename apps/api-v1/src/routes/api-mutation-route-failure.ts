import { RequestAuthFailure } from '@shared-server/http/request-auth-service.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type {
    ApiMutationFailure,
    ApiMutationFailureDenial,
    ApiMutationFailureIssue,
    ApiMutationFailureRetry
} from '@shared/api/mutation/api-mutation-failure.ts';

import { toApiMutationFailureJsonObject } from './to-api-mutation-failure-json-object.ts';

interface ApiMutationFailureResponseWriter {
    json(value: ApiMutationFailure, status?: number): Response;
}

interface ApiMutationFailureInput {
    readonly code: string;
    readonly status: number;
    readonly message: string;
    readonly issues?: readonly ApiMutationFailureIssue[] | null;
    readonly denial?: ApiMutationFailureDenial | null;
    readonly retry?: ApiMutationFailureRetry | null;
}

export class ApiMutationRouteFailure extends Error {
    readonly failure: ApiMutationFailure;

    constructor(failure: ApiMutationFailure) {
        super(failure.message);
        this.failure = failure;
        this.name = 'ApiMutationRouteFailure';
    }
}

export function createApiMutationFailure(input: ApiMutationFailureInput): ApiMutationFailure {
    return {
        type: 'api-mutation-failure',
        version: 'canonical.v2',
        code: input.code,
        status: input.status,
        message: input.message,
        issues: input.issues ?? null,
        denial: input.denial ?? null,
        retry: input.retry ?? null
    };
}

export function toApiMutationRouteFailure(failure: AppInboxFailure): ApiMutationRouteFailure {
    return new ApiMutationRouteFailure(createApiMutationFailure({
        code: failure.code,
        status: failure.status,
        message: failure.message,
        issues: failure.issues?.map((issue) => ({
            code: issue.code,
            path: issue.path,
            message: issue.message,
            details: toApiMutationFailureJsonObject(issue.details)
        })) ?? null,
        denial: failure.denial
            ? {
                code: failure.denial.code,
                message: failure.denial.message,
                details: toApiMutationFailureJsonObject(failure.denial.details)
            }
            : failure.status === 401 || failure.status === 403
            ? { code: failure.code, message: failure.message, details: null }
            : null,
        retry: failure.retry
            ? {
                kind: failure.retry.kind,
                retryAfterMs: null,
                attempts: failure.retry.attempts,
                lane: failure.retry.lane,
                queueAgeMs: failure.retry.queueAgeMs,
                dueAgeMs: failure.retry.dueAgeMs
            }
            : null
    }));
}

export function toApiMutationFailureResponse(
    response: ApiMutationFailureResponseWriter,
    error: Error
): Response {
    const failure = readApiMutationFailure(error);
    return response.json(failure, failure.status);
}

export function toApiMutationRateLimitResponse(
    response: ApiMutationFailureResponseWriter,
    message: string,
    retryAfterMs: number
): Response {
    const failure = createApiMutationFailure({
        code: 'rate-limited',
        status: 429,
        message,
        retry: {
            kind: 'rate-limited',
            retryAfterMs,
            attempts: null,
            lane: null,
            queueAgeMs: null,
            dueAgeMs: null
        }
    });
    const result = response.json(failure, failure.status);
    result.headers.set('Retry-After', String(Math.ceil(retryAfterMs / 1_000)));
    return result;
}

export function toApiMutationUnavailableResponse(
    response: ApiMutationFailureResponseWriter,
    message: string
): Response {
    const failure = createApiMutationFailure({
        code: 'api-mutation-unavailable',
        status: 503,
        message,
        retry: {
            kind: 'unavailable',
            retryAfterMs: null,
            attempts: null,
            lane: null,
            queueAgeMs: null,
            dueAgeMs: null
        }
    });
    return response.json(failure, failure.status);
}

function readApiMutationFailure(error: Error): ApiMutationFailure {
    if (error instanceof ApiMutationRouteFailure) {
        return error.failure;
    }

    const message = error.message;
    if (error instanceof RequestAuthFailure) {
        return createApiMutationFailure({
            code: error.code,
            status: error.status,
            message,
            denial: {
                code: error.code,
                message,
                details: error.details
            }
        });
    }
    const status = readStatus(error);
    const code = readCode(error);
    if (error instanceof SyntaxError) {
        return validationFailure(
            'api-mutation-request-malformed',
            'API mutation request is malformed'
        );
    }
    if (error instanceof TypeError) {
        return validationFailure(code ?? 'api-mutation-request-invalid', message);
    }
    if (status === 400) {
        return validationFailure(code ?? 'api-mutation-request-invalid', message);
    }
    if (status === 503) {
        return createApiMutationFailure({
            code: code ?? 'api-mutation-unavailable',
            status,
            message,
            retry: {
                kind: 'unavailable',
                retryAfterMs: null,
                attempts: null,
                lane: null,
                queueAgeMs: null,
                dueAgeMs: null
            }
        });
    }
    if (status !== undefined) {
        return createApiMutationFailure({
            code: code ?? `api-mutation-${status}`,
            status,
            message
        });
    }
    return createApiMutationFailure({
        code: 'api-mutation-unexpected',
        status: 500,
        message: 'API mutation failed unexpectedly'
    });
}

function validationFailure(code: string, message: string): ApiMutationFailure {
    return createApiMutationFailure({
        code,
        status: 400,
        message,
        issues: [{ code, path: null, message, details: null }]
    });
}

function readCode(error: Error): string | undefined {
    const codedError = error as Error & { readonly code?: string; };
    return typeof codedError.code === 'string' && codedError.code.length > 0
        ? codedError.code
        : undefined;
}

function readStatus(error: Error): number | undefined {
    const statusError = error as Error & { readonly status?: number; };
    if (!Number.isSafeInteger(statusError.status)) {
        return undefined;
    }
    const status = Number(statusError.status);
    return status >= 400 && status <= 599 ? status : undefined;
}
