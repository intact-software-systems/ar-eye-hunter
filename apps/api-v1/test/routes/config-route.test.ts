import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { toApiV1PublicConfiguration } from '../../src/configuration/to-api-v1-public-configuration.ts';
import { createConfigRouteTestApp } from './config-route-test-runtime.ts';

test('/api/time observes the server clock for each uncached response', async () => {
    let now = 1_800_000_000_000;
    const app = createConfigRouteTestApp({ now: () => now });
    const first = await app.request('/api/time');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await first.json(), {
        serverPeerId: 'default-qbox-server',
        serverNowEpochMs: 1_800_000_000_000
    });

    now += 125;
    const second = await app.request('/api/time');
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await second.json(), {
        serverPeerId: 'default-qbox-server',
        serverNowEpochMs: 1_800_000_000_125
    });
});

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
