import type { AuthSession } from '@shared/api/api-config.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { requireRecord } from '@shared/api/exact-object-decoding.ts';
import { decodeTournamentMutationResult } from '@shared/api/tournaments/tournament-mutation-result.ts';
import type { TournamentRequest } from '@shared/api/tournaments/tournament-request.ts';
import { decodeTournamentSnapshot } from '@shared/api/tournaments/tournament-snapshot.ts';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createPGliteTracedRallarServer, issueTracedTestSession, type PGliteTracedRallarServer } from '../db/pglite-traced-rallar-test-runtime.ts';

const ref = { applicationId: 'game', workspaceId: 'default', tournamentId: 'cup' };
const base = '/api/tournaments/apps/game/workspaces/default/tournaments/cup';

test('default API registers four accounts, admits an exact semifinal, and preserves private consent', async () => {
    const server = await createPGliteTracedRallarServer({
        tournaments: {
            profiles: [{
                scope: { applicationId: 'game', workspaceId: 'default' },
                rulesId: 'native-v1',
                noShowGraceMs: 600000,
                gameLifecycleTopic: 'app:game:tournament-start'
            }]
        }
    });
    try {
        const players = [];
        for (const clientId of ['alice', 'bob', 'charlie', 'dana']) {
            players.push(await issueTracedTestSession(server.rallar.runtime, clientId));
        }
        const creation = await change(server, players[0], { type: 'create', title: 'Friday cup' }, 'create-tournament-request');
        assert.deepEqual(await change(server, players[0], { type: 'create', title: 'Friday cup' }, 'create-tournament-request'), creation);
        for (const player of players) {
            await change(server, player, { type: 'register' });
        }
        await change(server, players[0], { type: 'launch' });
        const scheduledAtEpochMs = Date.now() + 1000;
        await change(server, players[0], { type: 'schedule', slot: 'semifinal-1', scheduledAtEpochMs });
        const scheduled = await read(server, players[0]);
        const attempt = scheduled.tournament!.matches[0].attempt!;
        for (const player of players.slice(0, 2)) {
            await change(server, player, { type: 'check-in', slot: 'semifinal-1', attemptId: attempt.binding.attemptId });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, scheduledAtEpochMs - Date.now())));
        await change(server, players[0], { type: 'start', slot: 'semifinal-1', attemptId: attempt.binding.attemptId });
        const playing = await read(server, players[1]);
        assert.equal(playing.tournament!.matches[0].status, 'playing');
        assert.deepEqual(playing.tournament!.matches[0].principalIds, ['alice', 'bob']);
        const roomResponse = await server.app.request(`/api/state/apps/game/workspaces/default/groups/${attempt.binding.roomRef.groupId}`, {
            headers: headers(players[0])
        });
        assert.equal(roomResponse.status, 200, await roomResponse.clone().text());
        const room = requireRecord(await roomResponse.json(), 'Tournament room');
        validateAuthoritativeGroupSnapshot(room);
        assert.deepEqual(room.members.map((member) => member.principalId).sort(), ['alice', 'bob']);
        assert.equal(JSON.stringify(playing).includes(players[1].sessionId), false);
        const changed = await server.app.request(`${base}/requests/create-tournament-request`, {
            method: 'POST',
            headers: headers(players[0]),
            body: JSON.stringify({ type: 'create', title: 'Changed cup' })
        });
        assert.equal(changed.status, 409);
    }
    finally {
        await server.stop();
    }
});

async function change(server: PGliteTracedRallarServer, session: AuthSession, request: TournamentRequest, requestId: string = crypto.randomUUID()) {
    const response = await server.app.request(`${base}/requests/${requestId}`, { method: 'POST', headers: headers(session), body: JSON.stringify(request) });
    assert.equal(response.status, 200, await response.clone().text());
    const result = decodeTournamentMutationResult(await response.json(), { ref, requestId });
    assert.equal(result.status, 'applied', result.code ?? 'Expected accepted tournament intent');
    return result;
}

async function read(server: PGliteTracedRallarServer, session: AuthSession) {
    const response = await server.app.request(base, { headers: headers(session) });
    assert.equal(response.status, 200, await response.clone().text());
    return decodeTournamentSnapshot(await response.json());
}

function headers(session: AuthSession): Record<string, string> {
    return { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId, 'content-type': 'application/json' };
}
