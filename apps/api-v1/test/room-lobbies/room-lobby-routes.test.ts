import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import { registerRoomLobbyReadRoute } from '../../src/room-lobbies/register-room-lobby-read-route.ts';

test('the private seat is bound to the signed-in account and URL workspace', async () => {
    const app = new Hono();
    registerRoomLobbyReadRoute(app, {
        requireSession: async request => {
            if (!request.header('authorization')) throw authenticationRequired('Sign in to read your seat');
            return { clientId: 'alice' };
        },
        read: async (scope, principalId) => ({ scope, principalId, seat: null })
    });
    const path = '/api/room-lobbies/apps/club/workspaces/courts?principalId=bob';
    assert.equal((await app.request(path)).status, 401);
    const response = await app.request(path, { headers: { authorization: 'test' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { scope: { applicationId: 'club', workspaceId: 'courts' }, principalId: 'alice', seat: null });
});
