import assert from 'node:assert/strict';

import { createAuthSession, createClientEvent, createClientRouteApp, createClientRouteDeps, createClientSnapshot } from './client-state-route-test-runtime.ts';

Deno.test('non-strict state read routes preserve authenticated non-self client reads', async () => {
    const snapshot = createClientSnapshot('bob');
    const deps = createClientRouteDeps({
        session: createAuthSession('alice'),
        clientService: {
            readSnapshot: () => Promise.resolve(snapshot)
        }
    });
    const app = createClientRouteApp(deps);

    const response = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/clients/bob',
        { headers: { authorization: 'Bearer token' } }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(deps.authCallCount(), 1);
});

Deno.test('strict state read routes reject non-self client snapshot and event reads', async () => {
    const deps = createClientRouteDeps({
        session: createAuthSession('alice'),
        strictReadAuthorization: true,
        clientService: {
            readSnapshot: () => Promise.resolve(createClientSnapshot('bob')),
            listEventPage: () =>
                Promise.resolve({
                    events: [createClientEvent('bob-event')],
                    hasMore: false
                })
        }
    });
    const app = createClientRouteApp(deps);

    const snapshotResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/clients/bob',
        { headers: { authorization: 'Bearer token' } }
    );
    const eventsResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/clients/bob/events/page',
        { headers: { authorization: 'Bearer token' } }
    );

    assert.equal(snapshotResponse.status, 403);
    assert.equal(eventsResponse.status, 403);
    assert.deepEqual(await snapshotResponse.json(), {
        error: 'Forbidden: state read principal id does not match authenticated client'
    });
});

Deno.test('client point reads expose authoritative metadata and forward scalar floors', async () => {
    const snapshot = { ...createClientSnapshot('alice'), stateRevision: 7 };
    const calls: unknown[] = [];
    const deps = createClientRouteDeps({
        session: createAuthSession('alice'),
        clientService: {},
        readClientSnapshot: (ref, options) => {
            calls.push({ ref, options });
            return Promise.resolve({ status: 'found', source: 'cache', snapshot });
        }
    });
    const response = await createClientRouteApp(deps).request(
        '/api/state/apps/app-1/workspaces/workspace-1/clients/alice?minStateRevision=6'
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('rallar-state-source'), 'cache');
    assert.equal(response.headers.get('rallar-state-revision'), '7');
    assert.deepEqual(calls, [{
        ref: { applicationId: 'app-1', workspaceId: 'workspace-1', principalId: 'alice' },
        options: { minStateRevision: 6, strictMode: false }
    }]);
});

Deno.test('client point reads return typed 400 and 409 responses', async () => {
    const snapshot = createClientSnapshot('alice');
    const deps = createClientRouteDeps({
        session: createAuthSession('alice'),
        clientService: {},
        readClientSnapshot: () => Promise.resolve({ status: 'floor-not-satisfied', source: 'durable', snapshot })
    });
    const app = createClientRouteApp(deps);

    const malformed = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/clients/alice?minStateRevision=01'
    );
    const shortfall = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/clients/alice?minStateRevision=2'
    );

    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, 'invalid-state-revision');
    assert.equal(shortfall.status, 409);
    assert.deepEqual(await shortfall.json(), {
        error: 'Client state revision floor was not satisfied',
        code: 'state-revision-floor-not-satisfied'
    });
    assert.equal(shortfall.headers.get('retry-after'), null);
});

Deno.test('strict client collection reads the authenticated self from durable current state', async () => {
    const snapshot = createClientSnapshot('alice');
    let currentReads = 0;
    const deps = createClientRouteDeps({
        session: createAuthSession('alice'),
        strictReadAuthorization: true,
        clientService: {
            readSnapshot: () => Promise.reject(new Error('cache-permitting read leaked')),
            readCurrentSnapshot: () => {
                currentReads += 1;
                return Promise.resolve(snapshot);
            }
        }
    });

    const response = await createClientRouteApp(deps).request(
        '/api/state/apps/app-1/workspaces/workspace-1/clients'
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [snapshot]);
    assert.equal(currentReads, 1);
});
