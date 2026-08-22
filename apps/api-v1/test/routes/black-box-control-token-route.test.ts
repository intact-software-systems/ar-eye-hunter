import { verifyRallarBlackBoxOperatorToken } from '@shared-server/http/black-box-operator-token.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';
import * as configRoutes from '../../src/routes/config-route.ts';
import { authenticationRequired } from '../../src/services/request-auth-service.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const DEFAULT_TTL_MS = 86_400_000;

Deno.test('black-box control token route rejects unauthenticated requests', async () => {
    const app = createApp({
        requireApiAuthSession: () => Promise.reject(authenticationRequired('Unauthorized: Missing bearer token')),
        readEnv: (name) => name === 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET' ? 'operator-secret' : undefined
    });

    const response = await app.request('/api/black-box/control-token', {
        method: 'POST'
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
        error: 'Unauthorized: Missing bearer token'
    });
});

Deno.test('black-box control token route issues a 24h operator token by default', async () => {
    const app = createApp({
        requireApiAuthSession: () => Promise.resolve(createAuthSession('alice-client')),
        readEnv: (name) => name === 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET' ? 'operator-secret' : undefined
    });

    const response = await app.request('/api/black-box/control-token', {
        method: 'POST',
        headers: {
            authorization: 'Bearer access-token',
            'x-client-id': 'alice-client'
        }
    });
    const payload = await response.json() as {
        tokenType: string;
        token: string;
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
        ttlMs: number;
    };

    assert.equal(response.status, 200);
    assert.equal(payload.tokenType, 'Bearer');
    assert.equal(payload.issuedAtEpochMs, NOW_EPOCH_MS);
    assert.equal(payload.expiresAtEpochMs, NOW_EPOCH_MS + DEFAULT_TTL_MS);
    assert.equal(payload.ttlMs, DEFAULT_TTL_MS);
    const verified = await verifyRallarBlackBoxOperatorToken({
        token: payload.token,
        secret: 'operator-secret',
        nowEpochMs: NOW_EPOCH_MS + 1_000
    });
    assert.equal(verified.ok, true);
    if (verified.ok) {
        assert.equal(verified.claims.sub, 'alice');
        assert.equal(verified.claims.sessionId, 'alice-client-session');
        assert.equal(verified.claims.jti, 'token-id-1');
    }
});

Deno.test('black-box control token route rejects clients outside the allowlist', async () => {
    const app = createApp({
        requireApiAuthSession: () => Promise.resolve(createAuthSession('alice-client')),
        readEnv: (name) => {
            switch (name) {
                case 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET':
                    return 'operator-secret';
                case 'RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS':
                    return 'bob-client';
                default:
                    return undefined;
            }
        }
    });

    const response = await app.request('/api/black-box/control-token', {
        method: 'POST',
        headers: {
            authorization: 'Bearer access-token',
            'x-client-id': 'alice-client'
        }
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
        error: 'Forbidden: black-box operator token is not allowed for this client'
    });
});

Deno.test('black-box control token route reports missing signing secret clearly', async () => {
    const app = createApp({
        requireApiAuthSession: () => Promise.resolve(createAuthSession('alice-client'))
    });

    const response = await app.request('/api/black-box/control-token', {
        method: 'POST',
        headers: {
            authorization: 'Bearer access-token',
            'x-client-id': 'alice-client'
        }
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
        error: 'Black-box operator token broker is not configured.'
    });
});

function createApp(
    dependencies: Partial<configRoutes.ConfigRouteDependencies>
): Hono {
    const app = new Hono();
    configRoutes.registerConfigRoutes(app, {
        requireApiAuthSession: () => Promise.resolve(createAuthSession('alice-client')),
        readEnv: () => undefined,
        now: () => NOW_EPOCH_MS,
        createTokenId: () => 'token-id-1',
        appAuthInbox: {} as never,
        authUserRepository: {} as never,
        staticClients: [],
        registrationMode: 'public',
        adminClientIds: new Set(),
        ...dependencies
    });
    return app;
}

function createAuthSession(clientId: string): IssuedAuthSession {
    return {
        clientId,
        username: 'alice',
        accessToken: 'access-token',
        sessionId: `${clientId}-session`,
        issuedAtEpochMs: NOW_EPOCH_MS,
        expiresAtEpochMs: NOW_EPOCH_MS + DEFAULT_TTL_MS
    };
}
