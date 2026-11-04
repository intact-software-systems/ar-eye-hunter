import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ViewWatchCommand } from '@shared-server/rallar-system/view-watch/view-watch-command.ts';
import { Either } from '@shared/resilience/Either.ts';
import assert from 'node:assert/strict';
import { registerViewWatchRoutes, type ViewWatchRouteDependencies } from '../../src/group-state/register-view-watch-routes.ts';
import { createTracedApiTestApp } from '../services/create-traced-api-test-app.ts';

const session: IssuedAuthSession = {
    clientId: 'alice',
    username: 'alice',
    sessionId: 'alice-session',
    accessToken: 'test-token',
    issuedAtEpochMs: 1000,
    expiresAtEpochMs: 20000
};
const path = '/api/state/apps/game/workspaces/default/view-watches/session-preview/requests/watch-request-number-1';
const request = { groupId: 'unlisted-room', connectionGenerationId: 'alice-generation', expectedRegistrationId: null };

function dependencies(commands: ViewWatchCommand[]): ViewWatchRouteDependencies {
    return {
        requireSession: () => Promise.resolve(session),
        mutation: {
            submit: ({ command }) => {
                commands.push(command);
                return Promise.resolve(
                    Either.ofRight({ status: 'applied', requestId: command.requestId, registrationId: command.requestId, groupId: command.request.groupId })
                );
            }
        }
    };
}

Deno.test('watch route binds scope and issued authority, and returns the committed registration token', async () => {
    const commands: ViewWatchCommand[] = [];
    const app = createTracedApiTestApp();
    registerViewWatchRoutes(app, dependencies(commands));
    const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), {
        status: 'applied',
        requestId: 'watch-request-number-1',
        registrationId: 'watch-request-number-1',
        groupId: 'unlisted-room'
    });
    assert.deepEqual(commands, [{
        scope: { applicationId: 'game', workspaceId: 'default' },
        principalId: 'alice',
        sessionId: 'alice-session',
        sessionIssuedAtEpochMs: 1000,
        sessionExpiresAtEpochMs: 20000,
        requestId: 'watch-request-number-1',
        request
    }]);
});

Deno.test('watch route rejects missing auth, forged principal, malformed shape and short request IDs before admission', async () => {
    const commands: ViewWatchCommand[] = [];
    const unauthenticated = createTracedApiTestApp();
    registerViewWatchRoutes(unauthenticated, { ...dependencies(commands), requireSession: () => Promise.reject(authenticationRequired('Sign in')) });
    assert.equal((await unauthenticated.request(path, { method: 'POST' })).status, 401);
    const app = createTracedApiTestApp();
    registerViewWatchRoutes(app, dependencies(commands));
    for (const body of [{ ...request, principalId: 'bob' }, { groupId: 'unlisted-room' }]) {
        const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(response.status, 400);
    }
    const response = await app.request(path.replace('watch-request-number-1', 'short'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
    });
    assert.equal(response.status, 400);
    assert.deepEqual(commands, []);
});
