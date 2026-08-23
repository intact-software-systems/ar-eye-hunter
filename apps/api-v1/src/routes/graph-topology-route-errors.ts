import { isGroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import type {
    ApiMutationFailure,
    ApiMutationFailureIssue,
    ApiMutationFailureJsonValue
} from '@shared/api/mutation/api-mutation-failure.ts';

import { createApiMutationFailure, toApiMutationFailureResponse } from './api-mutation-route-failure.ts';
import { toApiMutationFailureJsonObject } from './to-api-mutation-failure-json-object.ts';

export function toGraphTopologyErrorResponse(
    c: { json(value: unknown, status?: number): Response; },
    error: unknown
): Response {
    if (isGroupPolicyDeniedError(error)) {
        return c.json(
            {
                error: error.message,
                code: error.denial.code,
                message: error.denial.message,
                issues: null,
                denial: error.denial,
                retry: null,
                details: error.denial.details
            },
            error.status
        );
    }
    if (isStatusError(error)) {
        return c.json(
            {
                error: error.message,
                code: error.code ?? 'topology-mutation-failed',
                message: error.message,
                issues: error.issues ?? null,
                denial: null,
                retry: null
            },
            error.status
        );
    }

    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('not found')
        ? 404
        : message.startsWith('Unauthorized:')
        ? 401
        : message.startsWith('Forbidden:')
        ? 403
        : message.includes('stale') || message.includes('conflict')
        ? 409
        : 400;
    return c.json({ error: message }, status);
}

interface GraphTopologyMutationFailureResponseWriter {
    json(value: ApiMutationFailure, status?: number): Response;
}

export function toGraphTopologyMutationErrorResponse<Failure>(
    context: GraphTopologyMutationFailureResponseWriter,
    error: Failure
): Response {
    if (isGroupPolicyDeniedError(error)) {
        const failure = createApiMutationFailure({
            code: error.denial.code,
            status: error.status,
            message: error.denial.message,
            denial: {
                code: error.denial.code,
                message: error.denial.message,
                details: toApiMutationFailureJsonObject(error.denial.details)
            }
        });
        return context.json(failure, failure.status);
    }
    if (isStatusError(error) && error.issues !== undefined) {
        const failure = createApiMutationFailure({
            code: error.code ?? 'topology-mutation-failed',
            status: error.status,
            message: error.message,
            issues: error.issues.map((issue) => toApiMutationFailureIssue(issue, error.message))
        });
        return context.json(failure, failure.status);
    }
    return toApiMutationFailureResponse(
        context,
        error instanceof Error ? error : new Error(String(error))
    );
}

function isStatusError<Failure>(
    error: Failure
): error is Failure & Error & {
    status: number;
    code?: string;
    issues?: readonly object[];
} {
    return error instanceof Error &&
        'status' in error &&
        typeof error.status === 'number' &&
        (!('issues' in error) ||
            error.issues === undefined ||
            (Array.isArray(error.issues) &&
                error.issues.every((issue) => typeof issue === 'object' && issue !== null)));
}

function toApiMutationFailureIssue(
    value: object,
    fallbackMessage: string
): ApiMutationFailureIssue {
    const issue = toApiMutationFailureJsonObject(value) ?? {};
    return {
        code: typeof issue.code === 'string' && issue.code.length > 0
            ? issue.code
            : 'topology-mutation-validation-failed',
        path: isApiMutationFailurePath(issue.path) ? issue.path : null,
        message: typeof issue.message === 'string' && issue.message.length > 0
            ? issue.message
            : fallbackMessage,
        details: toApiMutationFailureJsonObject(issue.details)
    };
}

function isApiMutationFailurePath(
    value: ApiMutationFailureJsonValue | undefined
): value is readonly (string | number)[] | null {
    return value === null ||
        (Array.isArray(value) &&
            value.every((part) => typeof part === 'string' || (typeof part === 'number' && Number.isFinite(part))));
}
