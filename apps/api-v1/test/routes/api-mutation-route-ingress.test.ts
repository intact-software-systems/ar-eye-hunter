import assert from 'node:assert/strict';

import {
  type ApiMutationRouteRequestIdInputDto,
  readApiMutationRouteRequestId,
} from '../../src/routes/api-mutation-route-ingress.ts';

const REQUEST_ID = 'Request_ID-012345678';

Deno.test('API mutation ingress accepts the route request ID as the only identity source', () => {
  assert.equal(
    readApiMutationRouteRequestId({
      requestId: REQUEST_ID,
      idempotencyKey: undefined,
      mutationBody: { displayName: 'Room' },
    }),
    REQUEST_ID,
  );
});

Deno.test('API mutation ingress rejects legacy headers and JSON body request IDs', () => {
  const rejectedIngresses: readonly ApiMutationRouteRequestIdInputDto[] = [
    {
      requestId: REQUEST_ID,
      idempotencyKey: REQUEST_ID,
      mutationBody: { displayName: 'Room' },
    },
    {
      requestId: REQUEST_ID,
      idempotencyKey: undefined,
      mutationBody: { displayName: 'Room', requestId: REQUEST_ID },
    },
  ];
  for (const ingress of rejectedIngresses) {
    assert.throws(
      () => readApiMutationRouteRequestId(ingress),
      /requestId must be supplied only by the request path/,
    );
  }
});
