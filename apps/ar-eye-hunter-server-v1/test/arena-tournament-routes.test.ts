import { createTracedApiTestApp } from '@api-v1/test/services/create-traced-api-test-app.ts';
import { EMPTY_INPUT } from '@ar-eye-hunter/arena-player-state.ts';
import type { ArenaTournamentMutation } from '@ar-eye-hunter/server/arena-tournament-mutation.ts';
import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import { Either } from '@shared/resilience/Either.ts';
import assert from 'node:assert/strict';
import { registerArenaTournamentRoutes, type ArenaTournamentRouteDependencies } from '../src/arena-tournament-routes.ts';

const path = '/api/ar-eye/rooms/arena/tournament';

Deno.test('arena input routes bind the actor to authentication and accept controls without client scores or poses', async () => {
    const commands: ArenaTournamentMutation.Command[] = [];
    const app = createTracedApiTestApp();
    registerArenaTournamentRoutes(app, dependencies(commands));
    const input = { sequence: 1, yaw: 0, pitch: 0, controls: EMPTY_INPUT };
    const response = await app.request(`${path}/inputs/requests/arena-input-request-valid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(commands[0], {
        kind: 'input',
        roomRef: { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'arena' },
        actor: { principalId: 'alice', sessionId: 'alice-session', issuedAtEpochMs: 1 },
        requestId: 'arena-input-request-valid',
        input,
        capturedAtEpochMs: 1000
    });
    for (const extra of [{ score: 100 }, { position: [0, 0, 0] }, { actor: 'bob' }, { kind: 'tick' }, { capturedAtEpochMs: 999999 }]) {
        const invalid = await app.request(`${path}/inputs/requests/arena-input-request-forged`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...input, ...extra })
        });
        assert.equal(invalid.status, 400);
    }
    assert.equal(commands.length, 1);
});

Deno.test('arena snapshots and inputs require authentication', async () => {
    const app = createTracedApiTestApp();
    registerArenaTournamentRoutes(app, { ...dependencies([]), requireSession: () => Promise.reject(authenticationRequired('Sign in')) });
    assert.equal((await app.request(path)).status, 401);
    assert.equal((await app.request(`${path}/inputs/requests/arena-input-request-valid`, { method: 'POST' })).status, 401);
});

function dependencies(commands: ArenaTournamentMutation.Command[]): ArenaTournamentRouteDependencies {
    return {
        nowEpochMs: () => 1000,
        requireSession: async () => ({
            clientId: 'alice',
            username: 'alice',
            sessionId: 'alice-session',
            accessToken: 'test-only',
            issuedAtEpochMs: 1,
            expiresAtEpochMs: 10000
        }),
        snapshots: { readSnapshot: async () => null },
        operation: {
            submit: async ({ command }) => {
                commands.push(command);
                return Either.ofRight({ roomRef: command.roomRef, status: 'applied', reason: null, simulatedAtEpochMs: 1000, complete: false });
            }
        }
    };
}
