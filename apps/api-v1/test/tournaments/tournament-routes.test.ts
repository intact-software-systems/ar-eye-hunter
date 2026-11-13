import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import type { TournamentService } from '@shared-server/rallar-system/tournaments/tournament-service.ts';
import { Either } from '@shared/resilience/Either.ts';
import { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { registerTournamentRoutes, type TournamentRouteDependencies } from '../../src/tournaments/register-tournament-routes.ts';
import { createTracedApiTestApp } from '../services/create-traced-api-test-app.ts';

const path = '/api/tournaments/apps/game/workspaces/default/tournaments/cup';

test('tournament reads and writes bind scope and account to the authenticated request', async () => {
    const app = createTracedApiTestApp();
    const commands: TournamentService.Command[] = [];
    registerTournamentRoutes(app, {
        ...dependencies(),
        mutation: {
            submit: async ({ command }) => {
                commands.push(command);
                return Either.ofRight({ ref: command.ref, requestId: command.requestId, status: 'applied', code: null });
            }
        }
    });
    const view = await app.request(`${path}?principalId=bob`);
    assert.equal(view.status, 200);
    assert.equal(view.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await view.json(), {
        ref: { applicationId: 'game', workspaceId: 'default', tournamentId: 'cup' },
        principalId: 'alice',
        observedAtEpochMs: 1000,
        tournament: null,
        listing: 'unlisted'
    });
    const response = await app.request(`${path}/requests/create-tournament-request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'create', title: 'Friday cup' })
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(commands, [{
        ref: { applicationId: 'game', workspaceId: 'default', tournamentId: 'cup' },
        requestId: 'create-tournament-request',
        actor: { principalId: 'alice', sessionId: 'alice-session', issuedAtEpochMs: 1 },
        request: { type: 'create', title: 'Friday cup' },
        materialized: null
    }]);
});

test('tournament catalogue authenticates the personal account and bounds its query', async () => {
    const app = createTracedApiTestApp();
    registerTournamentRoutes(app, dependencies());
    const catalog = '/api/tournaments/apps/game/workspaces/default/catalog';
    const response = await app.request(`${catalog}?view=mine&principalId=bob`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), {
        scope: { applicationId: 'game', workspaceId: 'default' },
        principalId: 'alice',
        view: 'mine',
        observedAtEpochMs: 1000,
        entries: [],
        nextCursor: null
    });
    for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'view=friends', 'cursor=']) {
        assert.equal((await app.request(`${catalog}?${query}`)).status, 400);
    }
    const anonymous = createTracedApiTestApp();
    registerTournamentRoutes(anonymous, { ...dependencies(), requireSession: () => Promise.reject(authenticationRequired('Sign in')) });
    assert.equal((await anonymous.request(catalog)).status, 401);
});

test('tournaments reject anonymous access, fabricated results, authority and internal reconciliation', async () => {
    const anonymous = createTracedApiTestApp();
    registerTournamentRoutes(anonymous, { ...dependencies(), requireSession: () => Promise.reject(authenticationRequired('Sign in')) });
    assert.equal((await anonymous.request(path)).status, 401);
    assert.equal((await anonymous.request(`${path}/requests/create-tournament-request`, { method: 'POST' })).status, 401);
    const app = createTracedApiTestApp();
    let submitted = 0;
    registerTournamentRoutes(app, {
        ...dependencies(),
        mutation: {
            submit: () => {
                submitted++;
                throw new Error('Invalid intent was admitted');
            }
        }
    });
    for (
        const request of [
            { type: 'reconcile' },
            { type: 'result', scores: [100, 0] },
            { type: 'register', principalId: 'admin' },
            { type: 'create', title: 'Cup', rulesId: 'easy' },
            { type: 'check-in', slot: 'semifinal-1', attemptId: 'one', actor: { principalId: 'bob' } },
            { type: 'schedule', slot: 'semifinal-1', scheduledAtEpochMs: 1000, roomId: 'existing-room' }
        ]
    ) {
        const response = await app.request(`${path}/requests/invalid-tournament-request`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request)
        });
        assert.equal(response.status, 400, await response.clone().text());
    }
    assert.equal(submitted, 0);
});

function dependencies(): TournamentRouteDependencies {
    return {
        requireSession: async () => ({
            clientId: 'alice',
            username: 'alice',
            accessToken: 'test-only',
            sessionId: 'alice-session',
            issuedAtEpochMs: 1,
            expiresAtEpochMs: 10000
        }),
        catalog: { read: async ({ scope, principalId, view }) => ({ scope, principalId, view, observedAtEpochMs: 1000, entries: [], nextCursor: null }) },
        reader: { read: async (account) => ({ ...account, observedAtEpochMs: 1000, tournament: null, listing: 'unlisted' }) },
        mutation: { submit: async ({ command }) => Either.ofRight({ ref: command.ref, requestId: command.requestId, status: 'applied', code: null }) },
        mutationQuota: new RateLimiterPolicy(1000, 100)
    };
}
