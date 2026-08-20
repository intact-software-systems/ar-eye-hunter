import type { ApiMutationFailureJsonValue } from '@shared/api/mutation/api-mutation-failure.ts';
import { assertApiMutationRequestId } from '@shared/api/mutation/api-mutation-request.ts';

export interface ApiMutationRouteRequestIdInputDto {
  readonly requestId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly mutationBody: ApiMutationFailureJsonValue;
}

export function readApiMutationRouteRequestId(input: ApiMutationRouteRequestIdInputDto): string {
  if (input.idempotencyKey !== undefined || hasRequestId(input.mutationBody)) {
    throw new TypeError('API mutation requestId must be supplied only by the request path');
  }
  return assertApiMutationRequestId(input.requestId ?? '');
}

function hasRequestId(mutationBody: ApiMutationFailureJsonValue): boolean {
  return mutationBody !== null &&
    typeof mutationBody === 'object' &&
    Object.hasOwn(mutationBody, 'requestId');
}
