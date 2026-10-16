import type { ApiMutationFailureJsonValue } from '@shared/api/mutation/api-mutation-failure.ts';

import { ApiMutationRouteFailure, createApiMutationFailure } from '../routes/api-mutation-route-failure.ts';
import { readApiMutationRouteRequestId } from '../routes/api-mutation-route-ingress.ts';
import type { GroupStateRouteRequest } from './group-state-route-contracts.ts';

export interface GroupStateRouteRequestContext {
    readonly req: GroupStateRouteRequest & {
        json(): Promise<ApiMutationFailureJsonValue>;
        param(name: 'requestId'): string | undefined;
    };
}

export async function readGroupStateRouteRequest<T extends { requestId?: string; }>(
    context: GroupStateRouteRequestContext
): Promise<T & { requestId: string; }> {
    const requestBody = (await readGroupStateRouteRequestBody(context)) as T;
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

/** Malformed JSON stays the request's own failure; a body the client stopped sending is its typed 400. */
async function readGroupStateRouteRequestBody(
    context: GroupStateRouteRequestContext
): Promise<ApiMutationFailureJsonValue> {
    try {
        return await context.req.json();
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            throw error;
        }
        throw new ApiMutationRouteFailure(createApiMutationFailure({
            code: 'api-mutation-request-body-unreadable',
            status: 400,
            message: 'API mutation request body could not be read'
        }));
    }
}
