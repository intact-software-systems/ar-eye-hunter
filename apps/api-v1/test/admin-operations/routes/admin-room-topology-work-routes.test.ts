import { test } from 'bun:test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';

import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import type { ReadAdminRoomTopologyWork } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-topology-work.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';

import { registerAdminRoomRoutes } from '../../../src/admin-operations/register-admin-room-routes.ts';
import { installApiDocumentationRoutes } from '../../../src/routes/swagger-routes.ts';

const roomRef = { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'private-room' };
const path = '/api/admin/operations/rooms/apps/ar-eye-hunter/workspaces/default/groups/private-room/topology-work/work-1';
const session: IssuedAuthSession = {
    clientId: 'admin',
    username: 'operator',
    sessionId: 'test-session',
    accessToken: 'test-token',
    issuedAtEpochMs: 1,
    expiresAtEpochMs: 30_000
};

interface TopologyWorkTestInput {
    readonly requireSession: () => Promise<IssuedAuthSession>;
    readonly topologyWork: Pick<ReadAdminRoomTopologyWork, 'read'>;
}

function createApp(input: TopologyWorkTestInput): Hono {
    const app = new Hono();
    registerAdminRoomRoutes(app, {
        adminClientIds: ['admin'],
        requireApiAuthSession: input.requireSession,
        directory: { read: () => Promise.reject(new Error('Directory must not be read')) },
        topologyWork: input.topologyWork
    });
    return app;
}

test('topology outcome reads require current API administrator authority before accessing retained work', async () => {
    let reads = 0;
    let authorized = true;
    const topologyWork = {
        read: () => {
            reads++;
            return Promise.reject(new Error('private work'));
        }
    };
    const ordinary = createApp({ topologyWork, requireSession: () => Promise.resolve({ ...session, clientId: 'player' }) });
    assert.equal((await ordinary.request(path)).status, 403);
    assert.equal(reads, 0);
    const admin = createApp({
        topologyWork,
        requireSession: () =>
            authorized
                ? Promise.resolve(session)
                : Promise.reject(authenticationRequired('Revoked'))
    });
    const failed = await admin.request(path);
    assert.equal(failed.status, 500);
    assert.equal((await failed.text()).includes('private work'), false);
    authorized = false;
    assert.equal((await admin.request(path)).status, 401);
    assert.equal(reads, 1);
});

test('topology outcome reads bind exact room and receipt identity and never cache the result', async () => {
    const app = createApp({
        requireSession: () => Promise.resolve(session),
        topologyWork: {
            read: (request) => {
                assert.deepEqual(request, { roomRef, outboxId: 'work-1' });
                return Promise.resolve({ ...request, observedAtEpochMs: 10_000, status: 'pending', attempts: 1, settledAtEpochMs: null });
            }
        }
    });
    const response = await app.request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.json()).status, 'pending');
    assert.equal((await app.request(path.replace('default/groups', 'bad%20scope/groups'))).status, 400);
    assert.equal((await app.request(path.replace('work-1', 'a'.repeat(257)))).status, 400);
});

test('topology work OpenAPI describes observed outcomes without claiming room recovery', async () => {
    const app = installApiDocumentationRoutes(new Hono());
    const response = await app.request('/api/openapi.json');
    const schema = await response.json();
    const operation = schema.paths['/api/admin/operations/rooms/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology-work/{outboxId}']?.get;
    assert.ok(operation);
    assert.deepEqual(operation.security, [{ bearerAuth: [], clientIdHeader: [] }]);
    assert.deepEqual(schema.components.schemas.AdminRoomTopologyWorkResponse.required, [
        'roomRef',
        'outboxId',
        'observedAtEpochMs',
        'status',
        'attempts',
        'settledAtEpochMs'
    ]);
});
