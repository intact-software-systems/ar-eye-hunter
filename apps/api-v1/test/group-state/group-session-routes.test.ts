import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import assert from 'node:assert/strict';
import { registerGroupStateRoutes } from '../../src/group-state/register-group-state-routes.ts';
import { createTracedApiTestApp } from '../services/create-traced-api-test-app.ts';
import { createGroupStateRouteSnapshot, createGroupStateRouteTestDependencies, toGroupStateWritten } from './group-state-route-test-runtime.ts';

const BASE = '/api/state/apps/app-1/workspaces/workspace-1';
const PATH = `${BASE}/groups/room-1/session`;
const REQUEST_ID = 'session-request-123456789';

Deno.test('session previews authenticate and use only the current account', async () => {
    const calls: { readonly ref: GroupRef; readonly principalId: string; }[] = [];
    const app = createTracedApiTestApp();
    registerGroupStateRoutes(app, {
        ...createGroupStateRouteTestDependencies(),
        sessionDirectory: {
            read: async (ref, principalId) => {
                calls.push({ ref, principalId });
                return null;
            },
            listForPrincipal: async (_scope, principalId, afterKey) => {
                assert.equal(principalId, 'alice');
                assert.equal(afterKey, null);
                return { sessions: [], nextKey: null };
            }
        }
    });
    assert.equal((await app.request(PATH)).status, 404);
    assert.deepEqual(calls, [{ ref: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' }, principalId: 'alice' }]);
    const list = await app.request(`${BASE}/group-sessions`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { sessions: [], nextKey: null });
});

Deno.test('session writes bind path identity and authority and return no member roster', async () => {
    const app = createTracedApiTestApp();
    const calls: AuthenticatedGroupMutationEnqueue[] = [];
    registerGroupStateRoutes(app, {
        ...createGroupStateRouteTestDependencies(),
        processGroupAppInbox: async (_authority, enqueue) => {
            calls.push(enqueue);
            return toGroupStateWritten(createGroupStateRouteSnapshot('room-1'));
        }
    });
    const response = await app.request(`${PATH}/requests/${REQUEST_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reserve', expectedScheduleRevision: 1, startsAtEpochMs: null })
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { accepted: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, AppInboxType.GROUP_SESSION_CHANGE);
    assert.deepEqual(calls[0].data, {
        scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
        groupId: 'room-1',
        request: {
            requestId: REQUEST_ID,
            action: 'reserve',
            expectedScheduleRevision: 1,
            startsAtEpochMs: null,
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session'
        }
    });
});

Deno.test('session routes reject unauthenticated reads and writes', async () => {
    const app = createTracedApiTestApp();
    registerGroupStateRoutes(app, {
        ...createGroupStateRouteTestDependencies(),
        requireApiAuthSession: () => Promise.reject(authenticationRequired('Sign in'))
    });
    assert.equal((await app.request(PATH)).status, 401);
    assert.equal((await app.request(`${BASE}/group-sessions`)).status, 401);
    assert.equal((await app.request(`${PATH}/requests/${REQUEST_ID}`, { method: 'POST' })).status, 401);
});
