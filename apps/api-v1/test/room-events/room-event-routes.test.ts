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
        events: { read: async () => null, mutate: { submit: async () => { throw new Error('Unexpected event write'); } } }
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
