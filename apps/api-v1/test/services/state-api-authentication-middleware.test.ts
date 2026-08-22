import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { authenticationRequired, authorizationDenied } from '../../src/services/request-auth-service.ts';
import { createStateApiAuthenticationMiddleware } from '../../src/services/state-api-authentication-middleware.ts';

const CLIENT_PATH = '/api/state/apps/app/workspaces/workspace/clients/alice';
const INSTANCE_PATH = `${CLIENT_PATH}/instances/browser`;
const SESSION_PATH = `${INSTANCE_PATH}/sessions/session-1`;
const STRICT_MUTATIONS = [
    ['PUT', `${CLIENT_PATH}/principal/requests/Request_ID-012345678`],
    ['PUT', `${INSTANCE_PATH}/requests/Request_ID-012345678`],
    ['PUT', `${SESSION_PATH}/requests/Request_ID-012345678`],
    ['POST', `${SESSION_PATH}/heartbeat/requests/Request_ID-012345678`],
    ['POST', `${SESSION_PATH}/disconnect/requests/Request_ID-012345678`]
] as const;

Deno.test('strict client mutations receive canonical authentication failures', async () => {
    for (
        const failure of [
            authenticationRequired('Credential proof was not accepted', 'credential-rejected'),
            authorizationDenied('Caller cannot mutate this principal', 'principal-mismatch')
        ]
    ) {
        for (const [method, path] of STRICT_MUTATIONS) {
            const app = new Hono();
            app.use(
                '/api/state/*',
                createStateApiAuthenticationMiddleware(() => Promise.reject(failure))
            );
            app.on(method, path, (context) => context.json({ ok: true }));

            const response = await app.request(path, { method });

            assert.equal(response.status, failure.status);
            assert.deepEqual(await response.json(), {
                type: 'api-mutation-failure',
                version: 'canonical.v1',
                code: failure.code,
                status: failure.status,
                message: failure.message,
                issues: null,
                denial: {
                    code: failure.code,
                    message: failure.message,
                    details: null
                },
                retry: null
            });
        }
    }
});

Deno.test('removed client mutation paths bypass auth middleware and remain 404', async () => {
    const app = new Hono();
    app.use(
        '/api/state/*',
        createStateApiAuthenticationMiddleware(() => Promise.reject(authenticationRequired('Must not be disclosed')))
    );

    for (
        const [method, path] of [
            ['PUT', `${CLIENT_PATH}/principal`],
            ['PUT', INSTANCE_PATH],
            ['PUT', SESSION_PATH],
            ['POST', `${SESSION_PATH}/heartbeat`],
            ['POST', `${SESSION_PATH}/disconnect`]
        ] as const
    ) {
        assert.equal((await app.request(path, { method })).status, 404);
    }
});

Deno.test('state authentication retains the legacy response contract for reads', async () => {
    const failure = authenticationRequired('Credential wording has no status prefix');
    const app = new Hono();
    app.use(
        '/api/state/*',
        createStateApiAuthenticationMiddleware(() => Promise.reject(failure))
    );
    app.get(
        '/api/state/apps/app/workspaces/workspace/clients',
        (context) => context.json({ ok: true })
    );

    const response = await app.request(
        '/api/state/apps/app/workspaces/workspace/clients'
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: failure.message });
});
