import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import type { MatchmakingCommand } from '@shared-server/rallar-system/matchmaking/matchmaking-command.ts';
import { Either } from '@shared/resilience/Either.ts';
import { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import assert from 'node:assert/strict';
import { registerMatchmakingRoutes, type MatchmakingRouteDependencies } from '../../src/matchmaking/register-matchmaking-routes.ts';
import { createTracedApiTestApp } from '../services/create-traced-api-test-app.ts';

const path = '/api/matchmaking/apps/game/workspaces/default';

Deno.test('matchmaking reads and commands bind scope and account to the authenticated HTTP boundary', async () => {
    const app = createTracedApiTestApp();
    const commands: MatchmakingCommand[] = [];
    registerMatchmakingRoutes(app, {
        ...dependencies(),
        mutation: {
            submit: async ({ command }) => {
                commands.push(command);
                return Either.ofRight({
                    scope: command.scope,
                    principalId: command.principalId,
                    requestId: command.requestId,
                    status: 'applied',
                    searchId: command.request.searchId,
                    code: null
                });
            }
        }
    });
    const view = await app.request(`${path}?principalId=bob`);
    assert.equal(view.status, 200);
    assert.equal(view.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await view.json(), {
        scope: { applicationId: 'game', workspaceId: 'default' },
        principalId: 'alice',
        observedAtEpochMs: 1000,
        state: { status: 'idle' }
    });
    const response = await app.request(`${path}/requests/start-search-request-1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start', searchId: 'search-alice' })
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(commands, [{
        scope: { applicationId: 'game', workspaceId: 'default' },
        principalId: 'alice',
        sessionId: 'session-alice',
        sessionIssuedAtEpochMs: 1,
        sessionExpiresAtEpochMs: 10000,
        requestId: 'start-search-request-1',
        request: { action: 'start', searchId: 'search-alice' },
        capturedAtEpochMs: null,
        policy: null,
        serviceId: null
    }]);
});

Deno.test('matchmaking requires authentication and rejects caller-supplied authority, policy and private expiry actions', async () => {
    const app = createTracedApiTestApp();
    registerMatchmakingRoutes(app, { ...dependencies(), requireSession: () => Promise.reject(authenticationRequired('Sign in')) });
    assert.equal((await app.request(path)).status, 401);
    assert.equal((await app.request(`${path}/requests/start-search-request-1`, { method: 'POST' })).status, 401);
    const authenticated = createTracedApiTestApp();
    registerMatchmakingRoutes(authenticated, dependencies());
    for (
        const body of [{ action: 'start', searchId: 'search-alice', principalId: 'admin' }, { action: 'start', searchId: 'search-alice', players: 1 }, {
            action: 'expire',
            searchId: 'search-alice'
        }]
    ) {
        const response = await authenticated.request(`${path}/requests/start-search-request-2`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        });
        assert.equal(response.status, 400);
    }
    assert.equal(
        (await authenticated.request(`${path}/requests/short`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'start', searchId: 'search-alice' })
        })).status,
        400
    );
});

function dependencies(): MatchmakingRouteDependencies {
    return {
        requireSession: async () => ({
            clientId: 'alice',
            username: 'alice',
            accessToken: 'test-only',
            sessionId: 'session-alice',
            issuedAtEpochMs: 1,
            expiresAtEpochMs: 10000
        }),
        reader: { read: async (account) => ({ ...account, observedAtEpochMs: 1000, state: { status: 'idle' } }) },
        mutation: {
            submit: async ({ command }) =>
                Either.ofRight({
                    scope: command.scope,
                    principalId: command.principalId,
                    requestId: command.requestId,
                    status: 'applied',
                    searchId: command.request.searchId,
                    code: null
                })
        },
        mutationQuota: new RateLimiterPolicy(1000, 100)
    };
}
