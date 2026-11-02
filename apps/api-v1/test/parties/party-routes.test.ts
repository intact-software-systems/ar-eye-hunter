import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import type { PartyCommand } from '@shared-server/rallar-system/parties/party-command.ts';
import { Either } from '@shared/resilience/Either.ts';
import { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import assert from 'node:assert/strict';
import { registerPartyRoutes, type PartyRouteDependencies } from '../../src/parties/register-party-routes.ts';
import { createTracedApiTestApp } from '../services/create-traced-api-test-app.ts';

const scope = { applicationId: 'game', workspaceId: 'default' };
const ref = { ...scope, partyId: 'friends' };
const path = '/api/parties/apps/game/workspaces/default';
const request = { ref, expectedRosterRevision: null, intent: { action: 'create' } };

Deno.test('party HTTP reads bind the caller and commands capture only authenticated authority', async () => {
    const app = createTracedApiTestApp();
    const commands: PartyCommand[] = [];
    registerPartyRoutes(app, {
        ...dependencies(),
        mutation: {
            submit: async ({ command }) => {
                commands.push(command);
                return Either.ofRight({
                    ref: command.request.ref,
                    principalId: command.principalId,
                    requestId: command.requestId,
                    status: 'applied',
                    code: null
                });
            }
        }
    });
    const response = await app.request(`${path}?principalId=bob`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { scope, principalId: 'alice', observedAtEpochMs: 1000, maxMembers: 2, party: null, invitations: [] });
    const created = await app.request(`${path}/requests/create-party-request-1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
    });
    assert.equal(created.status, 200, await created.clone().text());
    assert.deepEqual(commands, [{
        principalId: 'alice',
        sessionId: 'alice-session',
        sessionIssuedAtEpochMs: 1,
        sessionExpiresAtEpochMs: 10000,
        requestId: 'create-party-request-1',
        request,
        capturedAtEpochMs: null,
        policy: null
    }]);
});

Deno.test('party HTTP refuses unauthenticated access, cross-scope commands and injected authority', async () => {
    const anonymous = createTracedApiTestApp();
    registerPartyRoutes(anonymous, { ...dependencies(), requireSession: () => Promise.reject(authenticationRequired('Sign in')) });
    assert.equal((await anonymous.request(path)).status, 401);
    assert.equal((await anonymous.request(`${path}/requests/create-party-request-2`, { method: 'POST' })).status, 401);
    const authenticated = createTracedApiTestApp();
    registerPartyRoutes(authenticated, dependencies());
    for (
        const body of [
            { ...request, principalId: 'admin' },
            { ...request, ref: { ...ref, workspaceId: 'foreign' } },
            { ...request, expectedRosterRevision: -1 },
            { ...request, policy: { maxMembers: 100 } }
        ]
    ) {
        const response = await authenticated.request(`${path}/requests/create-party-request-3`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        });
        assert.equal(response.status, 400);
    }
});

function dependencies(): PartyRouteDependencies {
    return {
        requireSession: async () => ({
            clientId: 'alice',
            username: 'alice',
            accessToken: 'test-only',
            sessionId: 'alice-session',
            issuedAtEpochMs: 1,
            expiresAtEpochMs: 10000
        }),
        reader: { read: async (scope, principalId) => ({ scope, principalId, observedAtEpochMs: 1000, maxMembers: 2, party: null, invitations: [] }) },
        mutation: {
            submit: async ({ command }) =>
                Either.ofRight({ ref: command.request.ref, principalId: command.principalId, requestId: command.requestId, status: 'applied', code: null })
        },
        mutationQuota: new RateLimiterPolicy(1000, 100)
    };
}
