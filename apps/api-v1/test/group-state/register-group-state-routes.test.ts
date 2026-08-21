import assert from 'node:assert/strict';

import {
    createGroupStateRouteSnapshot,
    createGroupStateRouteTestRuntime,
    createPredecessorGroupStateRouteAuthSession,
    createPredecessorGroupStateRouteSnapshot,
    createPredecessorGroupStateRouteTestRuntime
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups';
const GROUP_STATE_ROUTE_BASE = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups';
const GROUP_ROUTE_PATH = `${GROUP_STATE_ROUTE_BASE}/:groupId`;
const GROUP_MUTATION_REQUEST_ID = 'group-registration-request-001';

interface GroupStateRouteMatch {
    readonly method: 'GET' | 'POST' | 'PUT';
    readonly path: string;
    readonly body?: Record<string, unknown>;
    readonly status: 200 | 201;
}

const GROUP_STATE_ROUTE_MATCHES: readonly GroupStateRouteMatch[] = [
    { method: 'GET', path: API_BASE, status: 200 },
    {
        method: 'POST',
        path: mutationPath(API_BASE),
        body: { groupId: 'room-1', displayName: 'Room', kind: 'room' },
        status: 201
    },
    { method: 'GET', path: `${API_BASE}/room-1`, status: 200 },
    {
        method: 'PUT',
        path: mutationPath(`${API_BASE}/room-1`),
        body: { displayName: 'Room' },
        status: 200
    },
    { method: 'GET', path: `${API_BASE}/room-1/events`, status: 200 },
    { method: 'GET', path: `${API_BASE}/room-1/events/page`, status: 200 },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/director/appoint`),
        body: { heartbeatTtlMs: 1 },
        status: 200
    },
    { method: 'POST', path: mutationPath(`${API_BASE}/room-1/join`), body: {}, status: 200 },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/invites/accept`),
        body: {},
        status: 200
    },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/join-code/rotate`),
        body: { joinCode: 'next', expiresAtEpochMs: 1 },
        status: 200
    },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/invites/bob`),
        body: { invitationExpiresAtEpochMs: 1 },
        status: 200
    },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/invites/bob/revoke`),
        body: {},
        status: 200
    },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/admissions/bob/grant`),
        body: {},
        status: 200
    },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/admissions/bob/decline`),
        body: {},
        status: 200
    },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/members/bob/remove`),
        body: {},
        status: 200
    },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/members/bob/ban`),
        body: {},
        status: 200
    },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/members/bob/unban`),
        body: {},
        status: 200
    },
    {
        method: 'PUT',
        path: mutationPath(`${API_BASE}/room-1/members/bob/role`),
        body: { role: 'admin' },
        status: 200
    },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/owner/transfer`),
        body: { newOwnerPrincipalId: 'bob' },
        status: 200
    },
    {
        method: 'PUT',
        path: mutationPath(`${API_BASE}/room-1/members/alice`),
        body: { status: 'active' },
        status: 200
    },
    {
        method: 'PUT',
        path: mutationPath(`${API_BASE}/room-1/sessions/alice-session`),
        body: {
            generationId: 'generation',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 1
        },
        status: 200
    },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/sessions/alice-session/heartbeat`),
        body: { generationId: 'generation', lastHeartbeatAtEpochMs: 1, expiresAtEpochMs: 1 },
        status: 200
    },
    {
        method: 'POST',
        path: mutationPath(`${API_BASE}/room-1/sessions/alice-session/disconnect`),
        body: {
            generationId: 'generation',
            lastHeartbeatAtEpochMs: 1,
            disconnectedAtEpochMs: 1,
            expiresAtEpochMs: 1
        },
        status: 200
    }
];

Deno.test(
    'group state route registration retains all 26 Hono handlers in predecessor order',
    () => {
        const runtime = createGroupStateRouteTestRuntime({ installStateAuthentication: false });
        const registeredRoutes = (runtime.app as unknown as {
            readonly routes: readonly { readonly method: string; readonly path: string; }[];
        }).routes.map((route) => `${route.method} ${route.path}`);

        assert.deepEqual(registeredRoutes, [
            `GET ${GROUP_STATE_ROUTE_BASE}`,
            `GET ${GROUP_ROUTE_PATH}`,
            `GET ${GROUP_ROUTE_PATH}/events`,
            `GET ${GROUP_ROUTE_PATH}/events/page`,
            `POST ${GROUP_STATE_ROUTE_BASE}/requests/:requestId`,
            `PUT ${GROUP_ROUTE_PATH}/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/director/appoint/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/lifecycle/establish/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/lifecycle/activate/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/lifecycle/reopen/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/join/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/invites/accept/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/join-code/rotate/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/invites/:principalId/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/invites/:principalId/revoke/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/admissions/:principalId/grant/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/admissions/:principalId/decline/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/members/:principalId/remove/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/members/:principalId/ban/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/members/:principalId/unban/requests/:requestId`,
            `PUT ${GROUP_ROUTE_PATH}/members/:principalId/role/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/owner/transfer/requests/:requestId`,
            `PUT ${GROUP_ROUTE_PATH}/members/:principalId/requests/:requestId`,
            `PUT ${GROUP_ROUTE_PATH}/sessions/:sessionId/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/sessions/:sessionId/heartbeat/requests/:requestId`,
            `POST ${GROUP_ROUTE_PATH}/sessions/:sessionId/disconnect/requests/:requestId`
        ]);
    }
);

Deno.test(
    'group state route registration matches all 23 public method and path contracts',
    async () => {
        const snapshot = createGroupStateRouteSnapshot('room-1', ['alice', 'bob']);
        const runtime = createGroupStateRouteTestRuntime({
            groupService: {
                readSnapshot: () => Promise.resolve(snapshot),
                readCurrentSnapshot: () => Promise.resolve(snapshot)
            }
        });

        for (const expected of GROUP_STATE_ROUTE_MATCHES) {
            const response = await requestRegisteredGroupStateRoute(runtime.app, expected);
            assert.equal(response.status, expected.status, `${expected.method} ${expected.path}`);
        }
    }
);

Deno.test('moved group route auth retains predecessor token and timing shape', () => {
    const before = Date.now();
    const session = createPredecessorGroupStateRouteAuthSession('alice');
    const after = Date.now();

    assert.equal(session.accessToken, 'token');
    assert.ok(session.issuedAtEpochMs >= before - 1_000);
    assert.ok(session.issuedAtEpochMs <= after - 1_000);
    assert.ok(session.expiresAtEpochMs >= before + 60_000);
    assert.ok(session.expiresAtEpochMs <= after + 60_000);
});

Deno.test('moved group snapshots retain first-active-principal ownership', () => {
    const snapshot = createPredecessorGroupStateRouteSnapshot('room-2', ['bob']);

    assert.equal(snapshot.group.ownerPrincipalId, 'bob');
    assert.equal(snapshot.members[0]?.role, 'owner');
});

Deno.test('moved group route runtime rejects unexpected mutations by default', async () => {
    const { app } = createPredecessorGroupStateRouteTestRuntime();
    const response = await app.request(mutationPath(API_BASE), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            groupId: 'room-2',
            displayName: 'Room 2',
            kind: 'room'
        })
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
        type: 'api-mutation-failure',
        version: 'canonical.v1',
        code: 'api-mutation-unexpected',
        status: 500,
        message: 'API mutation failed unexpectedly',
        issues: null,
        denial: null,
        retry: null
    });
});

async function requestRegisteredGroupStateRoute(
    app: ReturnType<typeof createGroupStateRouteTestRuntime>['app'],
    expected: GroupStateRouteMatch
): Promise<Response> {
    return await app.request(expected.path, {
        method: expected.method,
        headers: expected.body ? { 'content-type': 'application/json' } : undefined,
        body: expected.body ? JSON.stringify(expected.body) : undefined
    });
}

function mutationPath(path: string): string {
    return `${path}/requests/${GROUP_MUTATION_REQUEST_ID}`;
}
