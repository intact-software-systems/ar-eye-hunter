import assert from 'node:assert/strict';

import { createGroupStateRouteAuthSession, createGroupStateRouteSnapshot, createGroupStateRouteTestRuntime } from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';

Deno.test('group point reads expose the authoritative causal pair and forward floors', async () => {
    const snapshot = {
        ...createGroupStateRouteSnapshot('room-1'),
        causalRevision: { groupRevision: 4, presenceRevision: 6 }
    };
    const calls: unknown[] = [];
    const runtime = createGroupStateRouteTestRuntime({
        readGroupSnapshot: (ref, options) => {
            calls.push({ ref, options });
            return Promise.resolve({ status: 'found', source: 'cache', snapshot });
        }
    });
    const response = await runtime.app.request(
        `${API_BASE}?minGroupRevision=3&minPresenceRevision=5`
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('rallar-state-source'), 'cache');
    assert.equal(response.headers.get('rallar-group-revision'), '4');
    assert.equal(response.headers.get('rallar-presence-revision'), '6');
    assert.deepEqual(calls, [{
        ref: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
        options: {
            minCausalRevision: { groupRevision: 3, presenceRevision: 5 },
            strictMode: false
        }
    }]);
});

Deno.test('group point reads authorize durable shortfall before typed 409', async () => {
    const denied = createGroupStateRouteSnapshot('room-1', ['bob']);
    const allowed = createGroupStateRouteSnapshot('room-1', ['alice']);
    const deniedRuntime = createGroupStateRouteTestRuntime({
        session: createGroupStateRouteAuthSession('alice'),
        strictReadAuthorization: true,
        readGroupSnapshot: () => Promise.resolve({ status: 'floor-not-satisfied', source: 'durable', snapshot: denied })
    });
    const allowedRuntime = createGroupStateRouteTestRuntime({
        session: createGroupStateRouteAuthSession('alice'),
        strictReadAuthorization: true,
        readGroupSnapshot: () => Promise.resolve({ status: 'floor-not-satisfied', source: 'durable', snapshot: allowed })
    });

    const deniedResponse = await deniedRuntime.app.request(
        `${API_BASE}?minGroupRevision=2&minPresenceRevision=0`
    );
    const shortfall = await allowedRuntime.app.request(
        `${API_BASE}?minGroupRevision=2&minPresenceRevision=0`
    );

    assert.equal(deniedResponse.status, 403);
    assert.equal(shortfall.status, 409);
    assert.equal((await shortfall.json()).code, 'state-revision-floor-not-satisfied');
    assert.equal(shortfall.headers.get('retry-after'), null);
});

Deno.test('group point reads reject partial causal floors', async () => {
    const response = await createGroupStateRouteTestRuntime().app.request(
        `${API_BASE}?minGroupRevision=1`
    );

    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'invalid-group-causal-revision');
});
