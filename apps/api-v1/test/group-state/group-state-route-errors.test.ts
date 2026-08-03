import assert from 'node:assert/strict';

import {
  toGroupAppInboxError,
  toGroupStateErrorResponse,
} from '../../src/group-state/group-state-route-errors.ts';

Deno.test('group route errors retain policy details and structured AppInbox status', async () => {
  const policyFailure = JSON.stringify({
    error: 'Forbidden: Invite required.',
    code: 'group-invite-required',
    message: 'Invite required.',
    details: { groupId: 'room-1' },
  });
  const policyError = toGroupAppInboxError(policyFailure);
  const policyResponse = toGroupStateErrorResponse(
    createErrorResponseContext(),
    policyError,
  );

  assert.equal(policyResponse.status, 403);
  assert.deepEqual(await policyResponse.json(), {
    error: 'Forbidden: Invite required.',
    code: 'group-invite-required',
    message: 'Invite required.',
    details: { groupId: 'room-1' },
  });

  const structuredFailure = JSON.stringify({
    type: 'app-inbox-failure',
    version: 'canonical.v2',
    code: 'group-mutation-idempotency-conflict',
    status: 409,
    message: 'Group mutation command differs for request same-request',
    issues: null,
    denial: null,
    retry: null,
  });
  const structuredResponse = toGroupStateErrorResponse(
    createErrorResponseContext(),
    toGroupAppInboxError(structuredFailure),
  );

  assert.equal(structuredResponse.status, 409);
  assert.deepEqual(await structuredResponse.json(), {
    error: 'Group mutation command differs for request same-request',
    code: 'group-mutation-idempotency-conflict',
  });
});

function createErrorResponseContext(): {
  json(value: unknown, status?: number): Response;
} {
  return {
    json: (body, status) => new Response(JSON.stringify(body), { status }),
  };
}
