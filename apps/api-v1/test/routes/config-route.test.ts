import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { toApiV1PublicConfiguration } from '../../src/configuration/to-api-v1-public-configuration.ts';
import { createConfigRouteTestApp } from './config-route-test-runtime.ts';

test('/api/config serves the configured replaced-layout overlap', async () => {
    const app = createConfigRouteTestApp({
        publicConfiguration: {
            ...toApiV1PublicConfiguration({
                apiBaseUrl: 'https://api.example.test',
                wsBaseUrl: 'wss://api.example.test',
                rtcReplacedLayoutOverlapMs: 7_000
            }),
            serverPeerId: 'default-qbox-server'
        }
    });

    const response = await app.request('/api/config');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        apiBaseUrl: 'https://api.example.test',
        wsBaseUrl: 'wss://api.example.test',
        endpoints: { createWs: '/api/ws/:id' },
        rtcReplacedLayoutOverlapMs: 7_000,
        serverPeerId: 'default-qbox-server'
    });
});
