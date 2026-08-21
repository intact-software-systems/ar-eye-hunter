import { Either } from '@shared/resilience/Either.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';
import * as configRoutes from '../src/routes/config-route.ts';

const SESSION = {
    clientId: 'client-a',
    username: 'alice',
    accessToken: 'access-a',
    sessionId: 'session-a',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 61_000
} as const;
const REQUEST_ID = 'LogoutMutationRequest_012345';

Deno.test('logout routes the session mutation through AppAuthInbox', async () => {
    const calls: unknown[] = [];
    const app = new Hono();
    configRoutes.registerConfigRoutes(app, {
        requireApiAuthSession: () => Promise.resolve(SESSION),
        now: () => 2_000,
        createTokenId: () => 'logout-request-1',
        readEnv: () => undefined,
        appAuthInbox: ({
            logoutSession: (input: unknown) => {
                calls.push(input);
                return Promise.resolve(Either.ofRight({ loggedOut: true }));
            }
        }) as never,
        authUserRepository: {} as never,
        staticClients: [],
        registrationMode: 'public',
        adminClientIds: new Set()
    });

    const response = await app.request(`/api/auth/logout/requests/${REQUEST_ID}`, {
        method: 'POST',
        body: JSON.stringify({})
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { loggedOut: true });
    assert.deepEqual(calls, [{
        requestId: REQUEST_ID,
        session: SESSION
    }]);
});

Deno.test('logout returns the durable AppInbox failure status', async () => {
    const app = new Hono();
    configRoutes.registerConfigRoutes(app, {
        requireApiAuthSession: () => Promise.resolve(SESSION),
        readEnv: () => undefined,
        now: () => 2_000,
        createTokenId: () => 'unused',
        appAuthInbox: ({
            logoutSession: () =>
                Promise.resolve(Either.ofLeft({
                    type: 'app-inbox-failure',
                    version: 'canonical.v2',
                    code: 'auth-logout-authority-differs',
                    message: 'Auth logout authority differs',
                    status: 403,
                    issues: null,
                    denial: {
                        code: 'auth-logout-authority-differs',
                        message: 'Auth logout authority differs',
                        details: null
                    },
                    retry: null
                }))
        }) as never,
        authUserRepository: {} as never,
        staticClients: [],
        registrationMode: 'public',
        adminClientIds: new Set()
    });

    const response = await app.request(`/api/auth/logout/requests/${REQUEST_ID}`, {
        method: 'POST',
        body: JSON.stringify({})
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
        type: 'api-mutation-failure',
        version: 'canonical.v1',
        code: 'auth-logout-authority-differs',
        status: 403,
        message: 'Auth logout authority differs',
        issues: null,
        denial: {
            code: 'auth-logout-authority-differs',
            message: 'Auth logout authority differs',
            details: null
        },
        retry: null
    });
});
