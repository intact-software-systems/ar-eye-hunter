import type { ApiMutationFailureJsonValue } from '@shared/api/mutation/api-mutation-failure.ts';

import { readApiMutationRouteRequestId } from '../routes/api-mutation-route-ingress.ts';
import type { GroupStateRouteRequest } from './group-state-route-contracts.ts';

export interface GroupStateRouteRequestContext {
  readonly req: GroupStateRouteRequest & {
    json(): Promise<ApiMutationFailureJsonValue>;
    param(name: 'requestId'): string | undefined;
  };
}

export async function readGroupStateRouteRequest<T extends { requestId?: string }>(
  context: GroupStateRouteRequestContext,
): Promise<T & { requestId: string }> {
  const requestBody = (await context.req.json()) as T;
  const requestId = readApiMutationRouteRequestId({
    requestId: context.req.param('requestId'),
    idempotencyKey: context.req.header('Idempotency-Key'),
    mutationBody: requestBody as ApiMutationFailureJsonValue,
  });

  return {
    ...requestBody,
    requestId,
  };
}
