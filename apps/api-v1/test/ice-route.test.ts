import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';
import { createLocalIceConfig, registerIceRoutes } from '../src/routes/ice-route.ts';

Deno.test('local ICE configuration uses the resolved cache lifetime', () => {
    assert.deepEqual(createLocalIceConfig(1_000, 300_000), {
        iceServers: [],
        expiresAtEpochMs: 301_000
    });
});

Deno.test('ICE route applies resolved authentication and request-rate policy', async () => {
    const app = new Hono();
    const session = testSession();
    registerIceRoutes(app, {
        requireApiAuthSession: () => Promise.resolve(session),
        configuration: {
            mode: 'local',
            cacheTtlMs: 1_000,
            rateLimit: { windowMs: 60_000, requests: 1 }
        },
        nowEpochMs: () => 300_000
    });

    const first = await app.request('/api/webrtc/ice');
    const second = await app.request('/api/webrtc/ice');

    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
        iceServers: [],
        expiresAtEpochMs: 301_000
    });
    assert.equal(second.status, 429);
});

Deno.test('Metered ICE route caches one provider response for the resolved lifetime', async () => {
    const app = new Hono();
    let providerCalls = 0;
    registerIceRoutes(app, {
        requireApiAuthSession: () => Promise.resolve(testSession()),
        configuration: {
            mode: 'metered',
            cacheTtlMs: 1_000,
            rateLimit: { windowMs: 60_000, requests: 2 },
            appName: 'rallar-test',
            apiKey: 'secret-not-logged',
            region: 'eu'
        },
        nowEpochMs: () => 300_000,
        readMeteredIceCandidates: () => {
            providerCalls += 1;
            return Promise.resolve(Response.json([{ urls: ['turn:example.test'] }]));
        }
    });

    const first = await app.request('/api/webrtc/ice');
    const second = await app.request('/api/webrtc/ice');

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(providerCalls, 1);
    assert.deepEqual(await second.json(), {
        iceServers: [{ urls: ['turn:example.test'] }],
        expiresAtEpochMs: 301_000
    });
});

function testSession() {
    return {
        clientId: `ice-client-${crypto.randomUUID()}`,
        username: 'alice',
        accessToken: 'access-token',
        sessionId: 'session-1',
        expiresAtEpochMs: 360_000
    };
}
