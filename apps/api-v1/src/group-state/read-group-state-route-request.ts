import type { ApiMutationFailureJsonValue } from '@shared/api/mutation/api-mutation-failure.ts';
import { Either } from '@shared/resilience/Either.ts';

import { ApiMutationRouteFailure, createApiMutationFailure } from '../routes/api-mutation-route-failure.ts';
import { readApiMutationRouteRequestId } from '../routes/api-mutation-route-ingress.ts';
import type { GroupStateRouteRequest } from './group-state-route-contracts.ts';

export interface GroupStateRouteRequestContext {
    readonly req: GroupStateRouteRequest & {
        json(): Promise<ApiMutationFailureJsonValue>;
        param(name: 'requestId'): string | undefined;
    };
}

/** The parsed body, or the typed failure of a body the client stopped sending before it was read. */
type GroupStateRouteRequestBodyRead = Either<ApiMutationRouteFailure, ApiMutationFailureJsonValue>;

/** The transport failures a body read raises when the client aborts or drops the request mid-body. */
const ABORTED_REQUEST_BODY_ERRORS = [
    Deno.errors.BadResource,
    Deno.errors.Http,
    Deno.errors.ConnectionReset,
    Deno.errors.UnexpectedEof,
    Deno.errors.Interrupted
] as const;

export async function readGroupStateRouteRequest<T extends { requestId?: string; }>(
    context: GroupStateRouteRequestContext
): Promise<T & { requestId: string; }> {
    const body = await readGroupStateRouteRequestBody(context);
    if (body.left !== undefined) {
        throw body.left;
    }
    const requestBody = body.right as T;
    const requestId = readApiMutationRouteRequestId({
        requestId: context.req.param('requestId'),
        idempotencyKey: context.req.header('Idempotency-Key'),
        mutationBody: requestBody as ApiMutationFailureJsonValue
    });

    return {
        ...requestBody,
        requestId
    };
}

async function readGroupStateRouteRequestBody(
    context: GroupStateRouteRequestContext
): Promise<GroupStateRouteRequestBodyRead> {
    try {
        return Either.ofRight(await context.req.json());
    }
    catch (error) {
        if (!ABORTED_REQUEST_BODY_ERRORS.some((abortedError) => error instanceof abortedError)) {
            throw error;
        }
        return Either.ofLeft(
            new ApiMutationRouteFailure(createApiMutationFailure({
                code: 'api-mutation-request-body-unreadable',
                status: 400,
                message: 'API mutation request body could not be read'
            }))
        );
    }
}
