import type { Context } from 'jsr:@hono/hono@4.11.9';

import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type {
    ApiMutationFailureJsonObject,
    ApiMutationFailureJsonValue
} from '@shared/api/mutation/api-mutation-failure.ts';
import type { Either } from '@shared/resilience/Either.ts';

import { toApiMutationRouteFailure } from '../api-mutation-route-failure.ts';
import { readApiMutationRouteRequestId } from '../api-mutation-route-ingress.ts';

export interface AuthMutationRequest {
    readonly requestId: string;
    readonly body: ApiMutationFailureJsonObject;
}

export async function readAuthMutationRequest(
    context: Context
): Promise<AuthMutationRequest> {
    const text = await context.req.raw.text();
    const value: ApiMutationFailureJsonValue = text.length === 0 ? {} : JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('API mutation request body must be a JSON object');
    }
    const body = value as ApiMutationFailureJsonObject;
    return {
        requestId: readApiMutationRouteRequestId({
            requestId: context.req.param('requestId'),
            idempotencyKey: context.req.header('idempotency-key'),
            mutationBody: body
        }),
        body
    };
}

export function requireAuthMutationResult<R>(result: Either<AppInboxFailure, R>): R {
    if (result.right !== undefined) {
        return result.right;
    }
    const failure = result.left;
    if (!failure) {
        throw new Error('Auth mutation result is unavailable');
    }
    throw toApiMutationRouteFailure(failure);
}

export function toJsonResponse<T>(data: T, status = 200): Response {
    return Response.json(data, {
        status,
        headers: { 'content-type': 'application/json' }
    });
}
