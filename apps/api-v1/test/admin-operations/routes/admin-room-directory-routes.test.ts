import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import { ReadAdminRoomDirectory } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-directory.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';

import { registerAdminRoomRoutes } from '../../../src/admin-operations/register-admin-room-routes.ts';
import { installApiDocumentationRoutes } from '../../../src/routes/swagger-routes.ts';

const path = '/api/admin/operations/rooms/apps/ar-eye-hunter/workspaces/default';
const session: IssuedAuthSession = {
    clientId: 'admin',
    username: 'operator',
    sessionId: 'test-session',
    accessToken: 'test-token',
    issuedAtEpochMs: 1,
    expiresAtEpochMs: 30_000
};

function createApp(input: {
    readonly requireSession: () => Promise<IssuedAuthSession>;
    readonly directory?: Pick<ReadAdminRoomDirectory, 'read'>;
}): Hono {
    const app = new Hono();
    registerAdminRoomRoutes(app, {
        adminClientIds: ['admin'],
        requireApiAuthSession: input.requireSession,
        directory: input.directory ?? new ReadAdminRoomDirectory({
            repository: { findEntriesByPrefixPage: () => Promise.resolve([]) },
            nowEpochMs: () => 10_000
        })
    });
    return app;
}

Deno.test('room inspection denies missing, ordinary and revoked API authority', async () => {
    const forbiddenDirectory = { read: () => Promise.reject(new Error('private-room-identity')) };
    const anonymous = createApp({
        requireSession: () => Promise.reject(authenticationRequired('Sign in required')),
        directory: forbiddenDirectory
    });
    assert.equal((await anonymous.request(path)).status, 401);
    const ordinary = createApp({
        requireSession: () => Promise.resolve({ ...session, clientId: 'player' }),
        directory: forbiddenDirectory
    });
    const denied = await ordinary.request(path);
    assert.equal(denied.status, 403);
    assert.equal((await denied.text()).includes('private-room-identity'), false);
    let signedIn = true;
    const changing = createApp({
        requireSession: () => signedIn ? Promise.resolve(session) : Promise.reject(authenticationRequired('Expired'))
    });
    assert.equal((await changing.request(path)).status, 200);
    signedIn = false;
    assert.equal((await changing.request(path)).status, 401);
});

Deno.test('room inspection validates bounded requests and marks responses private and uncacheable', async () => {
    const app = createApp({ requireSession: () => Promise.resolve(session) });
    const response = await app.request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), {
        scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' },
        observedAtEpochMs: 10_000,
        completeness: 'complete',
        entries: [],
        nextAfterGroupId: null
    });
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=Infinity', 'afterGroupId=', 'limit=1&limit=2']) {
        assert.equal((await app.request(`${path}?${query}`)).status, 400, query);
    }
    assert.equal((await app.request(path.replace('/default', '/bad%20workspace'))).status, 400);
});

Deno.test('room inspection does not leak internal read errors or misreport them as empty success', async () => {
    const app = createApp({
        requireSession: () => Promise.resolve(session),
        directory: { read: () => Promise.reject(new TypeError('secret corrupted row body')) }
    });
    const response = await app.request(path);
    assert.equal(response.status, 500);
    assert.equal((await response.text()).includes('secret corrupted row body'), false);
});

Deno.test('room directory OpenAPI advertises admin authorization and bounded pagination', async () => {
    const app = installApiDocumentationRoutes(new Hono());
    const response = await app.request('/api/openapi.json');
    const schema = await response.json();
    const operation = schema.paths['/api/admin/operations/rooms/apps/{applicationId}/workspaces/{workspaceId}']?.get;
    assert.ok(operation, 'the runtime directory endpoint must be documented');
    assert.deepEqual(operation.security, [{ bearerAuth: [], clientIdHeader: [] }]);
    const limit = operation.parameters.find((parameter: { name?: string; }) => parameter.name === 'limit');
    assert.deepEqual(limit.schema, { type: 'integer', minimum: 1, maximum: 100, default: 50 });
    assert.deepEqual(schema.components.schemas.AdminRoomDirectoryResponse.required, [
        'scope',
        'observedAtEpochMs',
        'completeness',
        'entries',
        'nextAfterGroupId'
    ]);
});
