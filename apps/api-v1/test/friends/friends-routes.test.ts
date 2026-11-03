import assert from 'node:assert/strict';

import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import type { FriendsCommand } from '@shared-server/rallar-system/friends/friends-mutation-contracts.ts';
import { Either } from '@shared/resilience/Either.ts';
import { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';

import { registerFriendsRoutes, type FriendsRouteDependencies } from '../../src/friends/register-friends-routes.ts';
import { createTracedApiTestApp } from '../services/create-traced-api-test-app.ts';

function dependencies(): FriendsRouteDependencies {
    return {
        requireSession: async () => ({
            clientId: 'alice',
            username: 'alice',
            accessToken: 'test-token',
            sessionId: 'alice-session',
            issuedAtEpochMs: 1,
            expiresAtEpochMs: 10000
        }),
        reader: { read: async (principalId) => ({ principalId, shareOnline: false, contacts: [], invitations: [] }) },
        mutation: { submit: async ({ command }) => Either.ofRight({ principalId: command.principalId, requestId: command.requestId, status: 'applied' }) },
        mutationQuota: new RateLimiterPolicy(1000, 100)
    };
}

Deno.test('friends reads and mutations bind authority to the authenticated caller', async () => {
    const app = createTracedApiTestApp();
    const commands: FriendsCommand[] = [];
    registerFriendsRoutes(app, {
        ...dependencies(),
        mutation: {
            submit: async ({ command }) => {
                commands.push(command);
                return Either.ofRight({ principalId: command.principalId, requestId: command.requestId, status: 'applied' });
            }
        }
    });
    const view = await app.request('/api/friends/apps/game/workspaces/default?principalId=bob');
    assert.equal(view.status, 200);
    assert.deepEqual(await view.json(), { principalId: 'alice', shareOnline: false, contacts: [], invitations: [] });
    const response = await app.request('/api/friends/requests/friends-request-number-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request', username: 'bob' })
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(commands, [{
        principalId: 'alice',
        sessionId: 'alice-session',
        sessionIssuedAtEpochMs: 1,
        sessionExpiresAtEpochMs: 10000,
        requestId: 'friends-request-number-1',
        capturedAtEpochMs: null,
        request: { action: 'request', username: 'bob' }
    }]);
});

Deno.test('friends routes reject missing authentication and caller-injected authority', async () => {
    const app = createTracedApiTestApp();
    registerFriendsRoutes(app, { ...dependencies(), requireSession: () => Promise.reject(authenticationRequired('Sign in')) });
    assert.equal((await app.request('/api/friends/apps/game/workspaces/default')).status, 401);
    assert.equal((await app.request('/api/friends/requests/friends-request-number-1', { method: 'POST' })).status, 401);
    const authenticated = createTracedApiTestApp();
    registerFriendsRoutes(authenticated, dependencies());
    const response = await authenticated.request('/api/friends/requests/friends-request-number-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request', username: 'bob', principalId: 'admin' })
    });
    assert.equal(response.status, 400);
});

Deno.test('friends mutations require the canonical API request identity before admission', async () => {
    const app = createTracedApiTestApp();
    registerFriendsRoutes(app, dependencies());
    const response = await app.request('/api/friends/requests/short', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'visibility', shareOnline: false })
    });
    assert.equal(response.status, 400);
});
