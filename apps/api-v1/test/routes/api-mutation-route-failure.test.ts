import assert from 'node:assert/strict';
import type { AppInboxFailure } from '@shared-server/rallar-system/services/app-inbox-failure.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';

import { toGroupMutationErrorResponse } from '../../src/group-state/group-state-route-errors.ts';
import { toApiMutationRouteFailure } from '../../src/routes/api-mutation-route-failure.ts';
import {
  toGraphTopologyMutationErrorResponse,
} from '../../src/routes/graph-topology-route-errors.ts';
import {
  toApiMutationFailureJsonObject,
} from '../../src/routes/to-api-mutation-failure-json-object.ts';

const UNINSPECTABLE_DETAILS = { uninspectable: '[Uninspectable]' };

function createUninspectableDetails(): Record<string, string> {
  return new Proxy({}, {
    ownKeys() {
      throw new Error('Details cannot be inspected');
    },
  });
}

Deno.test('canonical mutation failure details preserve explicit absence', () => {
  assert.equal(toApiMutationFailureJsonObject(null), null);
  assert.equal(toApiMutationFailureJsonObject(undefined), null);
});

Deno.test('canonical mutation failures retain BigInt details without throwing', () => {
  const details: Record<string, bigint> = { amount: 1n };
  const failure: AppInboxFailure = {
    type: 'app-inbox-failure',
    version: 'canonical.v2',
    code: 'payment-denied',
    status: 403,
    message: 'Payment denied',
    issues: null,
    denial: { code: 'payment-denied', message: 'Payment denied', details },
    retry: null,
  };

  const rendered = toApiMutationRouteFailure(failure).failure;

  assert.deepEqual(rendered.denial?.details, { amount: '1' });
  assert.doesNotThrow(() => JSON.stringify(rendered));
});

Deno.test('canonical mutation failures retain cyclic details with a stable marker', () => {
  const details: Record<string, object | string> = { label: 'root' };
  details.self = details;
  const failure: AppInboxFailure = {
    type: 'app-inbox-failure',
    version: 'canonical.v2',
    code: 'cyclic-denial',
    status: 403,
    message: 'Cyclic denial',
    issues: null,
    denial: { code: 'cyclic-denial', message: 'Cyclic denial', details },
    retry: null,
  };

  const rendered = toApiMutationRouteFailure(failure).failure;

  assert.deepEqual(rendered.denial?.details, { label: 'root', self: '[Circular]' });
  assert.doesNotThrow(() => JSON.stringify(rendered));
});

Deno.test('canonical mutation failures retain undefined-valued detail properties', () => {
  const details: Record<string, string | undefined> = {
    retained: 'yes',
    omitted: undefined,
  };
  const failure: AppInboxFailure = {
    type: 'app-inbox-failure',
    version: 'canonical.v2',
    code: 'partial-denial',
    status: 403,
    message: 'Partial denial',
    issues: null,
    denial: { code: 'partial-denial', message: 'Partial denial', details },
    retry: null,
  };

  const rendered = toApiMutationRouteFailure(failure).failure;

  assert.deepEqual(rendered.denial?.details, {
    retained: 'yes',
    omitted: 'undefined',
  });
});

Deno.test('canonical AppInbox denials retain an uninspectable root marker', () => {
  const failure: AppInboxFailure = {
    type: 'app-inbox-failure',
    version: 'canonical.v2',
    code: 'uninspectable-denial',
    status: 403,
    message: 'Uninspectable denial',
    issues: null,
    denial: {
      code: 'uninspectable-denial',
      message: 'Uninspectable denial',
      details: createUninspectableDetails(),
    },
    retry: null,
  };

  const rendered = toApiMutationRouteFailure(failure).failure;

  assert.deepEqual(rendered.denial?.details, UNINSPECTABLE_DETAILS);
});

Deno.test('group policy denials retain an uninspectable root marker', async () => {
  const response = toGroupMutationErrorResponse(
    {
      json: (value, status) => Response.json(value, { status: status ?? 200 }),
    },
    new GroupPolicyDeniedError({
      allowed: false,
      code: 'group-policy-denied',
      message: 'Group policy denied the mutation',
      details: createUninspectableDetails(),
    }),
  );

  assert.equal(response.status, 403);
  assert.deepEqual((await response.json()).denial?.details, UNINSPECTABLE_DETAILS);
});

Deno.test('topology policy denials retain an uninspectable root marker', async () => {
  const response = toGraphTopologyMutationErrorResponse(
    {
      json: (value, status) => Response.json(value, { status: status ?? 200 }),
    },
    new GroupPolicyDeniedError({
      allowed: false,
      code: 'group-policy-denied',
      message: 'Topology policy denied the mutation',
      details: createUninspectableDetails(),
    }),
  );

  assert.equal(response.status, 403);
  assert.deepEqual((await response.json()).denial?.details, UNINSPECTABLE_DETAILS);
});

Deno.test('topology mutation failures render cyclic issues canonically', async () => {
  const details: Record<string, object | string> = { label: 'topology-issue' };
  details.self = details;
  const error = Object.assign(new Error('Topology validation failed'), {
    status: 422,
    code: 'group-topology-validation-failed',
    issues: [{
      code: 'invalid-topology',
      path: ['config'],
      message: 'Topology config is invalid',
      details,
    }],
  });

  const response = toGraphTopologyMutationErrorResponse(
    {
      json: (value, status) => Response.json(value, { status: status ?? 200 }),
    },
    error,
  );

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    type: 'api-mutation-failure',
    version: 'canonical.v1',
    code: 'group-topology-validation-failed',
    status: 422,
    message: 'Topology validation failed',
    issues: [{
      code: 'invalid-topology',
      path: ['config'],
      message: 'Topology config is invalid',
      details: { label: 'topology-issue', self: '[Circular]' },
    }],
    denial: null,
    retry: null,
  });
});
