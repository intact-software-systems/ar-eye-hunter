import assert from 'node:assert/strict';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';

import {
  toGroupAppInboxError,
  toGroupStateErrorResponse,
} from '../../src/group-state/group-state-route-errors.ts';

import {
  createGroupStateRouteAuthSession,
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
  withStrictGroupStateRouteReadAuth,
} from './group-state-route-test-runtime.ts';

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

Deno.test('group route adapter preserves canonical AppInbox status code and message', async () => {
  const failure = JSON.stringify({
    type: 'app-inbox-failure',
    version: 'canonical.v2',
    code: 'group-mutation-idempotency-conflict',
    status: 409,
    message: 'Group mutation command differs for request same-request',
    issues: null,
    denial: null,
    retry: null,
  });
  const { app } = createGroupStateRouteTestRuntime({
    session: createGroupStateRouteAuthSession('alice'),
    groupService: {},
    processGroupAppInbox: () => Promise.reject(toGroupAppInboxError(failure)),
  });

  const response = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: 'same-request',
        groupId: 'room-1',
        displayName: 'Room 1',
        kind: 'room',
        joinMode: 'open',
      }),
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'Group mutation command differs for request same-request',
    code: 'group-mutation-idempotency-conflict',
  });
});

Deno.test('group state routes return stable policy error codes when available', async () => {
  await withStrictGroupStateRouteReadAuth(false, async () => {
    const { app } = createGroupStateRouteTestRuntime({
      session: createGroupStateRouteAuthSession('alice'),
      groupService: {
        listSnapshots: () =>
          Promise.reject(
            new GroupPolicyDeniedError({
              allowed: false,
              code: 'group-invite-required',
              message: 'Invite required.',
              details: { groupId: 'room-1' },
            }),
          ),
      },
    });

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: 'Forbidden: Invite required.',
      code: 'group-invite-required',
      message: 'Invite required.',
      details: { groupId: 'room-1' },
    });
  });
});

Deno.test('group mutation routes return stable lifecycle policy error codes', async () => {
  await withStrictGroupStateRouteReadAuth(false, async () => {
    const snapshot = createGroupStateRouteSnapshot('room-1', ['alice']);
    const ownerSnapshot: GroupSnapshot = {
      ...snapshot,
      members: snapshot.members.map((member) =>
        member.principalId === 'alice' ? { ...member, role: 'owner' as const } : member
      ),
    };
    const { app } = createGroupStateRouteTestRuntime({
      session: createGroupStateRouteAuthSession('alice'),
      groupService: {
        readSnapshot: () => Promise.resolve(ownerSnapshot),
      },
      processGroupAppInbox: () =>
        Promise.reject(
          new GroupPolicyDeniedError({
            allowed: false,
            code: 'group-archived',
            message: 'Group is archived.',
            details: { groupId: 'room-1' },
          }),
        ),
    });

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ displayName: 'Renamed' }),
      },
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: 'Forbidden: Group is archived.',
      code: 'group-archived',
      message: 'Group is archived.',
      details: { groupId: 'room-1' },
    });
  });
});

Deno.test('group route adapter reconstructs a legacy AppInbox policy denial with details', async () => {
  const toGroupError = toGroupAppInboxError;
  assert.ok(toGroupError);
  const failure = JSON.stringify({
    error: 'Forbidden: Invite required.',
    code: 'group-invite-required',
    message: 'Invite required.',
    details: { groupId: 'room-1' },
  });
  const snapshot = createGroupStateRouteSnapshot('room-1', ['alice']);
  const ownerSnapshot: GroupSnapshot = {
    ...snapshot,
    members: snapshot.members.map((member) =>
      member.principalId === 'alice' ? { ...member, role: 'owner' as const } : member
    ),
  };
  const { app } = createGroupStateRouteTestRuntime({
    session: createGroupStateRouteAuthSession('alice'),
    groupService: {
      readSnapshot: () => Promise.resolve(ownerSnapshot),
    },
    processGroupAppInbox: () => Promise.reject(toGroupError(failure)),
  });

  const response = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: 'legacy-group-denial',
        displayName: 'Renamed',
      }),
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: 'Forbidden: Invite required.',
    code: 'group-invite-required',
    message: 'Invite required.',
    details: { groupId: 'room-1' },
  });
});
