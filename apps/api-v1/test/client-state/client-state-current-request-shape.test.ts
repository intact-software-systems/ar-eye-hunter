import assert from 'node:assert/strict';

import {
    createAuthSession,
    createClientRouteApp,
    createClientRouteDeps,
    createClientSnapshot,
    toClientStateWritten
} from './client-state-route-test-runtime.ts';

Deno.test('client REST mutations reject non-object JSON before AppInbox enqueue', async () => {
    let processCount = 0;
    const app = createClientRouteApp(
        createClientRouteDeps({
            session: createAuthSession('alice'),
            clientService: {},
            processClientAppInbox: () => {
                processCount += 1;
                return Promise.resolve(toClientStateWritten(createClientSnapshot('alice')));
            }
        })
    );

    const response = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/principal/' +
            'requests/ClientMutationRequest_012345',
        {
            method: 'PUT',
            headers: {
                authorization: 'Bearer token',
                'content-type': 'application/json'
            },
            body: '[]'
        }
    );

    assert.equal(response.status, 400);
    assert.equal(processCount, 0);
});
