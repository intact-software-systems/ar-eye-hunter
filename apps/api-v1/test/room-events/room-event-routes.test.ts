import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { registerRoomEventRoutes } from '../../src/room-events/register-room-event-routes.ts';
import { createGroupStateRouteAuthSession } from '../group-state/group-state-route-test-runtime.ts';

test('public event commands reject worker settlement and a caller-supplied actor', async () => {
    const app = new Hono();
    registerRoomEventRoutes(app, {
        requireSession: async () => createGroupStateRouteAuthSession('alice'),
        readRoom: async () => undefined,
        nowEpochMs: () => 10,
        events: { pushPublicKey: null, read: async () => null, readOrganizer: async () => { throw new Error('Unexpected organizer read'); }, mutate: { submit: async () => { throw new Error('Unexpected event write'); } } }
    });
    const path = '/api/state/apps/a/workspaces/w/groups/lobby/event';
    const get = await app.request(path);
    assert.equal(get.status, 200);
    assert.equal(await get.json(), null);
    for (const body of [{ action: 'settle' }, { action: 'leave-queue', principalId: 'other' }]) {
        const response = await app.request(path + '/requests/event-authority-request-1', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        assert.equal(response.status, 400);
    }
});

test('the client can discover the public application server key before requesting notification permission', async () => {
    const app = new Hono();
    registerRoomEventRoutes(app, {
        requireSession: async () => createGroupStateRouteAuthSession('alice'), readRoom: async () => undefined, nowEpochMs: () => 10,
        events: { pushPublicKey: 'public-key', read: async () => null, readOrganizer: async () => { throw new Error('Unexpected organizer read'); }, mutate: { submit: async () => { throw new Error('Unexpected write'); } } }
    });
    const response = await app.request('/api/room-event-alerts/public-key');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { publicKey: 'public-key' });
});

test('organizer reads use the authenticated session and exact lobby', async () => {
    const app = new Hono();
    const session = createGroupStateRouteAuthSession('organizer');
    const lobby = { applicationId: 'a', workspaceId: 'w', groupId: 'lobby' };
    registerRoomEventRoutes(app, {
        requireSession: async () => session,
        readRoom: async () => undefined,
        nowEpochMs: () => 10,
        events: {
            pushPublicKey: null,
            read: async () => null,
            readOrganizer: async (group, actor) => {
                assert.deepEqual(group, lobby);
                assert.deepEqual(actor, { principalId: session.clientId, sessionId: session.sessionId });
                return { lobby, revision: 2, organizerId: actor.principalId, courts: [], closesAt: 100, closed: false, queue: [], players: [] };
            },
            mutate: { submit: async () => { throw new Error('Unexpected event write'); } }
        }
    });
    const response = await app.request('/api/state/apps/a/workspaces/w/groups/lobby/event/organizer');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await response.json()).organizerId, session.clientId);
});
