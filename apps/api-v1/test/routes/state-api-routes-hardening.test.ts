import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';
import {
  type AppInboxEnqueueInput,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import * as clientStateRoutes from '../../src/routes/client-state-routes.ts';
import * as groupStateRoutes from '../../src/routes/group-state-routes.ts';

const TEST_SCOPE: StateScope = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
};

Deno.test('non-strict state read routes preserve authenticated non-self client reads', async () => {
  await withStrictReadAuth(false, async () => {
    const snapshot = createClientSnapshot('bob');
    const deps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {
        readSnapshot: () => Promise.resolve(snapshot),
      },
    });
    const app = createClientRouteApp(deps);

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/bob',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(deps.authCallCount(), 1);
  });
});

Deno.test('malformed client REST mutations return terminal 400 before inbox enqueue', async () => {
  const processCalls: unknown[] = [];
  const deps = createClientRouteDeps({
    session: createAuthSession('alice'),
    clientService: {},
    processClientAppInbox: (input) => {
      processCalls.push(input);
      return Promise.resolve(createClientSnapshot('alice'));
    },
  });
  const app = createClientRouteApp(deps);
  const base = '/api/state/apps/app-1/workspaces/workspace-1/clients/alice';
  const cases = [
    {
      method: 'PUT',
      path: `${base}/principal`,
      body: { username: '', status: 'unknown' },
    },
    {
      method: 'PUT',
      path: `${base}/instances/browser`,
      body: { capabilities: [42] },
    },
    {
      method: 'PUT',
      path: `${base}/instances/browser/sessions/alice-session`,
      body: { generationId: { forged: true } },
    },
    {
      method: 'POST',
      path: `${base}/instances/browser/sessions/alice-session/heartbeat`,
      body: { generationId: 'generation-1', lastHeartbeatAtEpochMs: -1 },
    },
    {
      method: 'POST',
      path: `${base}/instances/browser/sessions/alice-session/disconnect`,
      body: {},
    },
  ] as const;

  for (const testCase of cases) {
    const response = await app.request(testCase.path, {
      method: testCase.method,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(testCase.body),
    });
    assert.equal(response.status, 400, testCase.path);
    assert.match((await response.json()).error, /Client|client/);
  }
  assert.equal(processCalls.length, 0);
});

Deno.test('client REST mutation preserves explicit terminal idempotency 409', async () => {
  const conflict = Object.assign(
    new Error('Client mutation command differs for request same-request'),
    {
      code: 'client-mutation-idempotency-conflict',
      status: 409,
    },
  );
  let processCount = 0;
  const deps = createClientRouteDeps({
    session: createAuthSession('alice'),
    clientService: {},
    processClientAppInbox: () => {
      processCount += 1;
      return Promise.reject(conflict);
    },
  });
  const response = await createClientRouteApp(deps).request(
    '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/principal',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: 'same-request',
        username: 'alice',
        metadata: { beta: 2, alpha: 1 },
      }),
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'Client mutation command differs for request same-request',
  });
  assert.equal(processCount, 1);
});

Deno.test('strict state read routes reject non-self client snapshot and event reads', async () => {
  await withStrictReadAuth(true, async () => {
    const deps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {
        readSnapshot: () => Promise.resolve(createClientSnapshot('bob')),
        listEventPage: () =>
          Promise.resolve({
            events: [createClientEvent('bob-event')],
            hasMore: false,
          }),
      },
    });
    const app = createClientRouteApp(deps);

    const snapshotResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/bob',
      { headers: { authorization: 'Bearer token' } },
    );
    const eventsResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/bob/events/page',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(snapshotResponse.status, 403);
    assert.equal(eventsResponse.status, 403);
    assert.deepEqual(await snapshotResponse.json(), {
      error: 'Forbidden: state read principal id does not match authenticated client',
    });
  });
});

Deno.test('strict state read routes allow active group members and reject non-members', async () => {
  await withStrictReadAuth(true, async () => {
    const memberSnapshot = createGroupSnapshot('room-1', ['alice']);
    const nonMemberSnapshot = createGroupSnapshot('room-2', ['bob']);
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        readSnapshot: (ref: { groupId: string }) =>
          Promise.resolve(
            ref.groupId === 'room-1' ? memberSnapshot : nonMemberSnapshot,
          ),
      },
    });
    const app = createGroupRouteApp(deps);

    const allowed = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      { headers: { authorization: 'Bearer token' } },
    );
    const denied = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-2',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), memberSnapshot);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'group-policy-denied');
  });
});

Deno.test('group snapshot reads probe durable state instead of trusting a warm cache', async () => {
  await withStrictReadAuth(false, async () => {
    const staleSnapshot = createGroupSnapshot('room-1', ['alice']);
    const currentSnapshot = createGroupSnapshot('room-1', ['alice', 'bob']);
    let cachedReadCount = 0;
    let currentReadCount = 0;
    const groupService = {
      readSnapshot: () => {
        cachedReadCount += 1;
        return Promise.resolve(staleSnapshot);
      },
      readCurrentSnapshot: () => {
        currentReadCount += 1;
        return Promise.resolve(currentSnapshot);
      },
    };
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService,
    });
    const app = createGroupRouteApp(deps);

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), currentSnapshot);
    assert.equal(cachedReadCount, 0);
    assert.equal(currentReadCount, 1);
  });
});

Deno.test('state read routes hydrate process snapshot caches after successful client and group REST reads', async () => {
  await withStrictReadAuth(false, async () => {
    const clientSnapshot = createClientSnapshot('alice');
    const groupSnapshot = createGroupSnapshot('room-1', ['alice']);
    const hydrationInputs: unknown[] = [];
    const clientDeps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {
        listSnapshots: () => Promise.resolve([clientSnapshot]),
      },
      hydrateStateSyncSnapshotCaches: (input: unknown) => {
        hydrationInputs.push(input);
        return Promise.resolve({ clientSnapshotCount: 1, groupSnapshotCount: 0 });
      },
    });
    const groupDeps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        readSnapshot: () => Promise.resolve(groupSnapshot),
      },
      hydrateStateSyncSnapshotCaches: (input: unknown) => {
        hydrationInputs.push(input);
        return Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 1 });
      },
    });
    const app = new Hono();
    installAuthMiddleware(app, clientDeps.requireApiAuthSession);
    clientStateRoutes.init(app, clientDeps);
    groupStateRoutes.init(app, groupDeps);

    const clientsResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients',
      { headers: { authorization: 'Bearer token' } },
    );
    const groupResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(clientsResponse.status, 200);
    assert.equal(groupResponse.status, 200);
    assert.deepEqual(hydrationInputs, [
      { clients: [clientSnapshot] },
      { groups: [groupSnapshot] },
    ]);
  });
});

Deno.test('state event page routes call paged services instead of full-history listEvents', async () => {
  await withStrictReadAuth(false, async () => {
    const clientPage: StateEventPage<ClientEvent> = {
      events: [createClientEvent('client-event-1')],
      hasMore: false,
    };
    const groupPage: StateEventPage<GroupEvent> = {
      events: [createGroupEvent('group-event-1')],
      hasMore: false,
    };
    const clientDeps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {
        listEvents: () => Promise.reject(new Error('full client history should not be loaded')),
        listEventPage: () => Promise.resolve(clientPage),
      },
    });
    const groupDeps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        listEvents: () => Promise.reject(new Error('full group history should not be loaded')),
        listEventPage: () => Promise.resolve(groupPage),
      },
    });
    const app = new Hono();
    installAuthMiddleware(app, clientDeps.requireApiAuthSession);
    clientStateRoutes.init(app, clientDeps);
    groupStateRoutes.init(app, groupDeps);

    const clientResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/events/page?limit=10',
      { headers: { authorization: 'Bearer token' } },
    );
    const groupResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/events/page?limit=10',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(clientResponse.status, 200);
    assert.equal(groupResponse.status, 200);
    assert.deepEqual(await clientResponse.json(), clientPage);
    assert.deepEqual(await groupResponse.json(), groupPage);
  });
});

Deno.test('state event array routes call bounded recent services instead of full-history listEvents', async () => {
  await withStrictReadAuth(false, async () => {
    const clientEvent = createClientEvent('client-event-2');
    const groupEvent = createGroupEvent('group-event-2');
    const clientQueries: unknown[] = [];
    const groupQueries: unknown[] = [];
    const clientDeps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {
        listEvents: () => Promise.reject(new Error('full client history should not be loaded')),
        listRecentEvents: (_ref, query) => {
          clientQueries.push(query);
          return Promise.resolve([clientEvent]);
        },
      },
    });
    const groupDeps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        listEvents: () => Promise.reject(new Error('full group history should not be loaded')),
        listRecentEvents: (_ref, query) => {
          groupQueries.push(query);
          return Promise.resolve([groupEvent]);
        },
      },
    });
    const app = new Hono();
    installAuthMiddleware(app, clientDeps.requireApiAuthSession);
    clientStateRoutes.init(app, clientDeps);
    groupStateRoutes.init(app, groupDeps);

    const clientResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/events?eventType=session-connected&limit=1',
      { headers: { authorization: 'Bearer token' } },
    );
    const groupResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/events?eventType=member-left&limit=1',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(clientResponse.status, 200);
    assert.equal(groupResponse.status, 200);
    assert.deepEqual(await clientResponse.json(), [clientEvent]);
    assert.deepEqual(await groupResponse.json(), [groupEvent]);
    assert.deepEqual(clientQueries, [{
      eventTypes: ['session-connected'],
      limit: 1,
    }]);
    assert.deepEqual(groupQueries, [{
      eventTypes: ['member-left'],
      limit: 1,
    }]);
  });
});

Deno.test('group state routes return stable policy error codes when available', async () => {
  await withStrictReadAuth(false, async () => {
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
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
    const app = createGroupRouteApp(deps);

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
  await withStrictReadAuth(false, async () => {
    const snapshot = createGroupSnapshot('room-1', ['alice']);
    const ownerSnapshot: GroupSnapshot = {
      ...snapshot,
      members: snapshot.members.map((member) =>
        member.principalId === 'alice' ? { ...member, role: 'owner' as const } : member
      ),
    };
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
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
    const app = createGroupRouteApp(deps);

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

Deno.test('group join route enqueues explicit join intent with authenticated actor', async () => {
  await withStrictReadAuth(false, async () => {
    const snapshot = createGroupSnapshot('room-1', ['alice']);
    const enqueued: AppInboxEnqueueInput<unknown>[] = [];
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {},
      processGroupAppInbox: <V, R>(input: AppInboxEnqueueInput<V>): Promise<R> => {
        enqueued.push(input);
        return Promise.resolve({
          status: 'ok',
          result: {
            right: {
              snapshot,
            },
          },
        } as R);
      },
    });
    const app = createGroupRouteApp(deps);

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/join',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          inviteToken: 'invite-1',
          joinCode: 'code-1',
          requestId: 'join-request-1',
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(enqueued.length, 1);
    assert.deepEqual(enqueued[0], {
      type: AppInboxType.GROUP_JOIN,
      resourceId: 'join-request-1',
      contextId: 'app-1:workspace-1:room-1',
      senderId: 'alice',
      data: {
        scope: TEST_SCOPE,
        groupId: 'room-1',
        request: {
          inviteToken: 'invite-1',
          joinCode: 'code-1',
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'join-request-1',
        },
      },
    });
  });
});

Deno.test('group invite routes enqueue safe invite workflows with authenticated actors', async () => {
  await withStrictReadAuth(false, async () => {
    const snapshot = createGroupSnapshot('room-1', ['alice']);
    const enqueued: AppInboxEnqueueInput<unknown>[] = [];
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {},
      processGroupAppInbox: <V, R>(input: AppInboxEnqueueInput<V>): Promise<R> => {
        enqueued.push(input);
        return Promise.resolve({
          status: 'ok',
          result: {
            right: {
              snapshot,
            },
          },
        } as R);
      },
    });
    const app = createGroupRouteApp(deps);

    const createResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/invites/bob',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          invitationExpiresAtEpochMs: 2_000,
          requestId: 'invite-create-1',
        }),
      },
    );
    const revokeResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/invites/bob/revoke',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId: 'invite-revoke-1' }),
      },
    );
    const acceptResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/invites/accept',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId: 'invite-accept-1' }),
      },
    );

    assert.equal(createResponse.status, 200);
    assert.equal(revokeResponse.status, 200);
    assert.equal(acceptResponse.status, 200);
    assert.deepEqual(enqueued, [
      {
        type: AppInboxType.GROUP_INVITE_CREATE,
        resourceId: 'invite-create-1',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          principalId: 'bob',
          request: {
            invitationExpiresAtEpochMs: 2_000,
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'invite-create-1',
          },
        },
      },
      {
        type: AppInboxType.GROUP_INVITE_REVOKE,
        resourceId: 'invite-revoke-1',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          principalId: 'bob',
          request: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'invite-revoke-1',
          },
        },
      },
      {
        type: AppInboxType.GROUP_INVITE_ACCEPT,
        resourceId: 'invite-accept-1',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          request: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'invite-accept-1',
          },
        },
      },
    ]);
  });
});

Deno.test('group join-code route enqueues rotation workflow with authenticated actor', async () => {
  await withStrictReadAuth(false, async () => {
    const snapshot = createGroupSnapshot('room-1', ['alice']);
    const responseBody = {
      joinCode: 'code-1',
      expiresAtEpochMs: 2_000,
      snapshot,
    };
    const enqueued: AppInboxEnqueueInput<unknown>[] = [];
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {},
      processGroupAppInbox: <V, R>(input: AppInboxEnqueueInput<V>): Promise<R> => {
        enqueued.push(input);
        return Promise.resolve({
          status: 'ok',
          result: {
            right: responseBody,
          },
        } as R);
      },
    });
    const app = createGroupRouteApp(deps);

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/join-code/rotate',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          joinCode: 'code-1',
          expiresAtEpochMs: 2_000,
          requestId: 'rotate-code-1',
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), responseBody);
    assert.deepEqual(enqueued, [
      {
        type: AppInboxType.GROUP_JOIN_CODE_ROTATE,
        resourceId: 'rotate-code-1',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          request: {
            joinCode: 'code-1',
            expiresAtEpochMs: 2_000,
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'rotate-code-1',
          },
        },
      },
    ]);
  });
});

Deno.test('group governance routes enqueue safe workflows with authenticated actors', async () => {
  await withStrictReadAuth(false, async () => {
    const snapshot = createGroupSnapshot('room-1', ['alice', 'bob']);
    const enqueued: AppInboxEnqueueInput<unknown>[] = [];
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {},
      processGroupAppInbox: <V, R>(input: AppInboxEnqueueInput<V>): Promise<R> => {
        enqueued.push(input);
        return Promise.resolve({
          status: 'ok',
          result: {
            right: { snapshot },
          },
        } as R);
      },
    });
    const app = createGroupRouteApp(deps);

    const requests = [
      app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/members/bob/remove',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ requestId: 'remove-bob' }),
        },
      ),
      app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/members/bob/ban',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ requestId: 'ban-bob' }),
        },
      ),
      app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/members/bob/unban',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ requestId: 'unban-bob' }),
        },
      ),
      app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/members/bob/role',
        {
          method: 'PUT',
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ role: 'admin', requestId: 'role-bob' }),
        },
      ),
      app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/owner/transfer',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            newOwnerPrincipalId: 'bob',
            requestId: 'transfer-owner',
          }),
        },
      ),
    ];
    const responses = await Promise.all(requests);

    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), snapshot);
    }
    assert.deepEqual(enqueued, [
      {
        type: AppInboxType.GROUP_MEMBER_REMOVE,
        resourceId: 'remove-bob',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          principalId: 'bob',
          request: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'remove-bob',
          },
        },
      },
      {
        type: AppInboxType.GROUP_MEMBER_BAN,
        resourceId: 'ban-bob',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          principalId: 'bob',
          request: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'ban-bob',
          },
        },
      },
      {
        type: AppInboxType.GROUP_MEMBER_UNBAN,
        resourceId: 'unban-bob',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          principalId: 'bob',
          request: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'unban-bob',
          },
        },
      },
      {
        type: AppInboxType.GROUP_MEMBER_ROLE_SET,
        resourceId: 'role-bob',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          principalId: 'bob',
          request: {
            role: 'admin',
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'role-bob',
          },
        },
      },
      {
        type: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
        resourceId: 'transfer-owner',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          request: {
            newOwnerPrincipalId: 'bob',
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'transfer-owner',
          },
        },
      },
    ]);
  });
});

Deno.test('strict group reads reject banned members for snapshots and events', async () => {
  await withStrictReadAuth(true, async () => {
    const bannedSnapshot = createGroupSnapshotWithMember(
      'room-1',
      'alice',
      'banned',
    );
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        readSnapshot: () => Promise.resolve(bannedSnapshot),
        listEvents: () => Promise.reject(new Error('banned member read leaked')),
        listEventPage: () => Promise.reject(new Error('banned member read leaked')),
      },
    });
    const app = createGroupRouteApp(deps);

    const snapshotResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      { headers: { authorization: 'Bearer token' } },
    );
    const eventsResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/events/page',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(snapshotResponse.status, 403);
    assert.equal(eventsResponse.status, 403);
    assert.equal((await snapshotResponse.json()).code, 'member-banned');
  });
});

Deno.test('strict group reads use shared full-state visibility policy', async () => {
  await withStrictReadAuth(true, async () => {
    const invitedSnapshot = createGroupSnapshotWithMember(
      'room-invited',
      'alice',
      'invited',
    );
    const deletedSnapshot = createDeletedGroupSnapshot('room-deleted', 'alice');
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        readSnapshot: (ref: { groupId: string }) =>
          Promise.resolve(
            ref.groupId === 'room-deleted' ? deletedSnapshot : invitedSnapshot,
          ),
        listEventPage: () =>
          Promise.resolve({
            events: [createGroupEvent('event-1')],
            hasMore: false,
          }),
      },
    });
    const app = createGroupRouteApp(deps);

    const invitedSnapshotResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-invited',
      { headers: { authorization: 'Bearer token' } },
    );
    const invitedEventsResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-invited/events/page',
      { headers: { authorization: 'Bearer token' } },
    );
    const deletedSnapshotResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-deleted',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(invitedSnapshotResponse.status, 403);
    assert.equal(invitedEventsResponse.status, 403);
    assert.equal(deletedSnapshotResponse.status, 403);
    assert.equal((await invitedSnapshotResponse.json()).code, 'group-policy-denied');
    assert.equal((await invitedEventsResponse.json()).code, 'group-policy-denied');
    assert.equal((await deletedSnapshotResponse.json()).code, 'group-deleted');
  });
});

function createClientRouteApp(
  deps: ReturnType<typeof createClientRouteDeps>,
): Hono {
  const app = new Hono();
  installAuthMiddleware(app, deps.requireApiAuthSession);
  clientStateRoutes.init(app, deps);
  return app;
}

function createGroupRouteApp(
  deps: ReturnType<typeof createGroupRouteDeps>,
): Hono {
  const app = new Hono();
  installAuthMiddleware(app, deps.requireApiAuthSession);
  groupStateRoutes.init(app, deps);
  return app;
}

function installAuthMiddleware(
  app: Hono,
  requireApiAuthSession: (
    req: { header(name: string): string | undefined },
  ) => Promise<Pick<AuthSession, 'clientId' | 'sessionId'>>,
): void {
  app.use('/api/state/*', async (c, next) => {
    await requireApiAuthSession(c.req);
    await next();
  });
}

function createClientRouteDeps(
  input: Readonly<{
    session: AuthSession;
    clientService: Partial<clientStateRoutes.ClientStateRouteService>;
    hydrateStateSyncSnapshotCaches?: clientStateRoutes.ClientStateRouteDependencies[
      'hydrateStateSyncSnapshotCaches'
    ];
    processClientAppInbox?: clientStateRoutes.ClientStateRouteDependencies[
      'processClientAppInbox'
    ];
  }>,
):
  & Required<clientStateRoutes.ClientStateRouteDependencies>
  & Readonly<{
    authCallCount(): number;
  }> {
  let authCalls = 0;
  return {
    getClientStateService: () => ({
      listSnapshots: () => Promise.resolve([]),
      readSnapshot: () => Promise.resolve(undefined),
      readPresenceSnapshot: () => Promise.resolve(undefined),
      listEvents: () => Promise.resolve([]),
      listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
      ...input.clientService,
    } as clientStateRoutes.ClientStateRouteService),
    requireApiAuthSession: () => {
      authCalls += 1;
      return Promise.resolve(input.session);
    },
    hydrateStateSyncSnapshotCaches: input.hydrateStateSyncSnapshotCaches ??
      (() => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 0 })),
    processClientAppInbox: input.processClientAppInbox ??
      (() => Promise.resolve(createClientSnapshot(input.session.clientId))),
    authCallCount: () => authCalls,
  };
}

function createGroupRouteDeps(
  input: Readonly<{
    session: AuthSession;
    groupService: Partial<groupStateRoutes.GroupStateRouteService>;
    hydrateStateSyncSnapshotCaches?: groupStateRoutes.GroupStateRouteDependencies[
      'hydrateStateSyncSnapshotCaches'
    ];
    processGroupAppInbox?: groupStateRoutes.GroupStateRouteDependencies[
      'processGroupAppInbox'
    ];
  }>,
): Required<groupStateRoutes.GroupStateRouteDependencies> {
  const readSnapshot = input.groupService.readSnapshot ??
    (() => Promise.resolve(undefined));

  return {
    getGroupStateService: () => ({
      listSnapshots: () => Promise.resolve([]),
      readSnapshot,
      readCurrentSnapshot: input.groupService.readCurrentSnapshot ?? readSnapshot,
      listEvents: () => Promise.resolve([]),
      listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
      ...input.groupService,
    } as groupStateRoutes.GroupStateRouteService),
    requireApiAuthSession: () => Promise.resolve(input.session),
    processGroupAppInbox: input.processGroupAppInbox ??
      (() => Promise.reject(new Error('Unexpected group mutation route call'))),
    hydrateStateSyncSnapshotCaches: input.hydrateStateSyncSnapshotCaches ??
      (() => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 0 })),
  };
}

async function withStrictReadAuth(
  enabled: boolean,
  action: () => Promise<void>,
): Promise<void> {
  const previous = Deno.env.get('RALLAR_STATE_STRICT_READ_AUTH');
  Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', enabled ? 'true' : 'false');
  try {
    await action();
  } finally {
    if (previous === undefined) {
      Deno.env.delete('RALLAR_STATE_STRICT_READ_AUTH');
    } else {
      Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', previous);
    }
  }
}

function createAuthSession(clientId: string): AuthSession {
  return {
    clientId,
    accessToken: 'token',
    username: clientId,
    sessionId: `${clientId}-session`,
    expiresAtEpochMs: Date.now() + 60_000,
  };
}

function createClientSnapshot(principalId: string): ClientSnapshot {
  return {
    stateRevision: 1,
    principal: {
      ...TEST_SCOPE,
      principalId,
      username: principalId,
      displayName: principalId,
      status: 'active',
      roles: [],
      metadata: {},
      snapshotVersion: 1,
      profileVersion: 1,
      presenceVersion: 0,
      created: { atEpochMs: 1, byServiceId: 'test' },
      updated: { atEpochMs: 1, byServiceId: 'test' },
    },
    instances: [],
    activeSessions: [],
    isOnline: false,
    activeSessionCount: 0,
  };
}

function createGroupSnapshot(
  groupId: string,
  activePrincipalIds: readonly string[],
): GroupSnapshot {
  return {
    stateRevision: 1,
    group: {
      ...TEST_SCOPE,
      groupId,
      displayName: groupId,
      kind: 'room',
      status: 'active',
      joinMode: 'open',
      metadata: {},
      snapshotVersion: 1,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 0,
      created: { atEpochMs: 1, byServiceId: 'test' },
      updated: { atEpochMs: 1, byServiceId: 'test' },
    },
    members: activePrincipalIds.map((principalId) => ({
      ...TEST_SCOPE,
      groupId,
      principalId,
      role: 'member' as const,
      status: 'active' as const,
      joined: { atEpochMs: 1, byServiceId: 'test' },
      updated: { atEpochMs: 1, byServiceId: 'test' },
    })),
    activeSessions: [],
    memberCount: activePrincipalIds.length,
    onlineMemberCount: 0,
  };
}

function createGroupSnapshotWithMember(
  groupId: string,
  principalId: string,
  status: 'active' | 'invited' | 'left' | 'removed' | 'banned',
): GroupSnapshot {
  const snapshot = createGroupSnapshot(
    groupId,
    status === 'active' ? [principalId] : [],
  );
  return {
    ...snapshot,
    members: [
      {
        ...TEST_SCOPE,
        groupId,
        principalId,
        role: 'member',
        status,
        joined: { atEpochMs: 1, byServiceId: 'test' },
        updated: { atEpochMs: 1, byServiceId: 'test' },
      },
    ],
    memberCount: status === 'active' ? 1 : 0,
    onlineMemberCount: 0,
  };
}

function createDeletedGroupSnapshot(
  groupId: string,
  principalId: string,
): GroupSnapshot {
  const snapshot = createGroupSnapshot(groupId, [principalId]);
  return {
    ...snapshot,
    group: {
      ...snapshot.group,
      status: 'deleted',
    },
  };
}

function createClientEvent(eventId: string): ClientEvent {
  return {
    ...TEST_SCOPE,
    principalId: 'alice',
    eventId,
    eventType: 'principal-updated',
    snapshotVersion: 1,
    occurredAtEpochMs: 1,
    actor: { serviceId: 'test' },
  };
}

function createGroupEvent(eventId: string): GroupEvent {
  return {
    ...TEST_SCOPE,
    groupId: 'room-1',
    eventId,
    eventType: 'group-updated',
    snapshotVersion: 1,
    occurredAtEpochMs: 1,
    actor: { serviceId: 'test' },
  };
}
