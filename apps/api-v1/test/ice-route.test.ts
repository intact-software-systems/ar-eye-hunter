import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { readApiV1Configuration } from '../src/configuration/read-api-v1-configuration.ts';
import { createLocalIceConfig, registerIceRoutes } from '../src/routes/ice-route.ts';
import { requireApiAuthSession } from '../src/services/request-auth-service.ts';
import { withPGliteSql } from './db/pglite-auth-test-harness.ts';

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

Deno.test('canonical retention ICE budget admits 101 requests and denies 102 for one authenticated principal', async () => {
    await withPGliteSql(async (sql) => {
        const configuration = await readFixtureConfiguration('101');
        const repository = new AuthSessionRepository(new PSqlRuntimeStateRepository(sql));
        const session = await issueSession(repository);
        const fixedNow = Date.now();
        const originalNow = Date.now;
        Date.now = () => fixedNow;
        try {
            const app = new Hono();
            registerIceRoutes(app, {
                configuration: configuration.ice,
                requireApiAuthSession: (request) => requireApiAuthSession(request, repository),
                nowEpochMs: () => fixedNow
            });
            for (let request = 1; request <= 101; request += 1) {
                const response = await app.request('/api/webrtc/ice', { headers: authHeaders(session) });
                assert.equal(response.status, 200, `ICE admission ${request} of 101`);
                assert.deepEqual(await response.json(), { iceServers: [], expiresAtEpochMs: fixedNow + 300_000 });
            }
            const denied = await app.request('/api/webrtc/ice', { headers: authHeaders(session) });
            assert.equal(denied.status, 429);
            assert.deepEqual(await denied.json(), { error: 'Too many ICE configuration requests' });
        }
        finally {
            Date.now = originalNow;
        }
    });
});

Deno.test('canonical default ICE budget preserves authentication, client isolation and window expiry', async () => {
    await withPGliteSql(async (sql) => {
        const configuration = await readFixtureConfiguration();
        const repository = new AuthSessionRepository(new PSqlRuntimeStateRepository(sql));
        const session = await issueSession(repository);
        const otherSession = await issueSession(repository);
        let clock = Date.now();
        const originalNow = Date.now;
        Date.now = () => clock;
        try {
            const app = new Hono();
            registerIceRoutes(app, {
                configuration: configuration.ice,
                requireApiAuthSession: (request) => requireApiAuthSession(request, repository),
                nowEpochMs: () => clock
            });
            assert.equal((await app.request('/api/webrtc/ice')).status, 401);
            for (let request = 1; request <= 20; request += 1) {
                assert.equal((await app.request('/api/webrtc/ice', { headers: authHeaders(session) })).status, 200);
            }
            assert.equal((await app.request('/api/webrtc/ice', { headers: authHeaders(session) })).status, 429);
            assert.equal((await app.request('/api/webrtc/ice', { headers: authHeaders(otherSession) })).status, 200);
            clock += 120_000;
            assert.equal((await app.request('/api/webrtc/ice', { headers: authHeaders(session) })).status, 200);
        }
        finally {
            Date.now = originalNow;
        }
    });
});

function readFixtureConfiguration(requests?: string) {
    const resource = (name: string) => new URL(`../resources/configuration/${name}-config.json`, import.meta.url);
    const environment: Record<string, string> = {
        RALLAR_API_CONFIGURATION_PROFILE: 'prod-in-memory',
        RALLAR_AUTH_CREDENTIAL_SECRET: 'local-test-auth-secret-0123456789',
        RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'local-test-operator-secret-0123456789'
    };
    if (requests !== undefined) {
        environment.RALLAR_ICE_RATE_LIMIT_REQUESTS = requests;
    }
    return readApiV1Configuration({
        environment: { get: (name) => environment[name] },
        readTextFile: (url) => Deno.readTextFile(url),
        defaultsUrl: resource('defaults'),
        profileUrls: { dev: resource('dev'), prod: resource('prod'), 'prod-hardened': resource('prod-hardened'), 'prod-in-memory': resource('prod-in-memory') },
        staticClientsUrl: new URL('../resources/authorised-clients.json', import.meta.url)
    });
}

async function issueSession(repository: AuthSessionRepository): Promise<AuthSession> {
    const sessionId = crypto.randomUUID();
    const issuer = createHmacAuthCredentialIssuer('local-test-auth-secret-0123456789');
    const session = {
        clientId: `ice-client-${crypto.randomUUID()}`,
        username: 'charlie',
        sessionId,
        accessToken: await issuer.issueAccessToken(sessionId),
        issuedAtEpochMs: Date.now(),
        expiresAtEpochMs: Date.now() + 3_600_000
    };
    await repository.putSession(session);
    return session;
}

function authHeaders(session: AuthSession): Record<string, string> {
    return { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId };
}

function testSession(): AuthSession {
    return {
        clientId: `ice-client-${crypto.randomUUID()}`,
        username: 'alice',
        accessToken: 'access-token',
        sessionId: 'session-1',
        expiresAtEpochMs: 360_000
    };
}
