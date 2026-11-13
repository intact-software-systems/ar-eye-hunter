import { test } from 'bun:test';

import { requireApiAuthSession } from '@api-v1/src/services/request-auth-service.ts';
import { issueTracedTestSession, preparePGliteTracedRallarServer, waitFor } from '@api-v1/test/db/pglite-traced-rallar-test-runtime.ts';
import { decodeArenaTournamentSnapshot, type ArenaTournamentSnapshot } from '@ar-eye-hunter/arena-tournament-snapshot.ts';
import { ARENA_TOURNAMENT_SNAPSHOT_SENDER, decodeArenaTournamentFrame } from '@ar-eye-hunter/arena-tournament-stream.ts';
import { AR_EYE_TOURNAMENT_DATA_BINDING } from '@ar-eye-hunter/server/arena-tournament-room.ts';
import { AppTopics, type AuthSession } from '@shared/api/api-config.ts';
import { decodeTournamentMutationResult } from '@shared/api/tournaments/tournament-mutation-result.ts';
import type { TournamentRequest } from '@shared/api/tournaments/tournament-request.ts';
import { decodeTournamentSnapshot } from '@shared/api/tournaments/tournament-snapshot.ts';
import assert from 'node:assert/strict';
import { registerArenaTournamentRoutes } from '../src/arena-tournament-routes.ts';
import { ARENA_TOURNAMENT_GAME_PROFILE, createArenaTournamentServices } from '../src/create-arena-tournament-services.ts';

test('committed bracket start reaches the native arena through the embedded durable worker', async () => {
    const server = await preparePGliteTracedRallarServer({
        group: { roomOwnedAppDataBindings: [{ ...AR_EYE_TOURNAMENT_DATA_BINDING }] },
        tournaments: { profiles: [{ ...ARENA_TOURNAMENT_GAME_PROFILE, noShowGraceMs: 600000 }] }
    });
    server.rallar.ws.defineTopic({
        topicId: AppTopics.serverRoomSnapshot,
        scope: 'room',
        fanout: 'live-only',
        participation: 'server',
        serverProducerIds: [ARENA_TOURNAMENT_SNAPSHOT_SENDER]
    });
    const published: ArenaTournamentSnapshot[] = [];
    const services = createArenaTournamentServices({
        database: server.sql,
        groups: server.rallar.runtime.groupsRepository,
        sessions: server.rallar.runtime.authSessionRepository,
        appInbox: server.rallar.appInbox,
        ws: {
            publish: async (input) => {
                const receipt = await server.rallar.ws.publish(input);
                published.push(await decodeArenaTournamentFrame(JSON.parse(input.message.payload.resource)));
                return receipt;
            }
        },
        registerStop: (stop) => server.rallar.runtime.backgroundTasks.register(stop),
        outbox: server.rallar.runtime.outboxQueueReader,
        bindings: [AR_EYE_TOURNAMENT_DATA_BINDING],
        serviceId: 'arena-integration',
        nowEpochMs: Date.now
    });
    registerArenaTournamentRoutes(server.app, {
        ...services,
        nowEpochMs: Date.now,
        requireSession: (request) => requireApiAuthSession(request, server.rallar.runtime.authSessionRepository)
    });
    server.rallar.mountRest(server.app);
    server.rallar.start();
    try {
        const players: AuthSession[] = [];
        for (const name of ['alice', 'bob', 'charlie', 'dana']) {
            players.push(await issueTracedTestSession(server.rallar.runtime, name));
        }
        const ref = { ...ARENA_TOURNAMENT_GAME_PROFILE.scope, tournamentId: 'native-cup' };
        const base = `/api/tournaments/apps/${ref.applicationId}/workspaces/${ref.workspaceId}/tournaments/${ref.tournamentId}`;
        const change = async (session: AuthSession, request: TournamentRequest) => {
            const requestId = crypto.randomUUID();
            const response = await server.app.request(`${base}/requests/${requestId}`, {
                method: 'POST',
                headers: headers(session),
                body: JSON.stringify(request)
            });
            assert.equal(response.status, 200, await response.clone().text());
            assert.equal(decodeTournamentMutationResult(await response.json(), { ref, requestId }).status, 'applied');
        };
        await change(players[0], { type: 'create', title: 'Server room cup' });
        for (const player of players) {
            await change(player, { type: 'register' });
        }
        await change(players[0], { type: 'launch' });
        const scheduledAtEpochMs = Date.now() + 1000;
        await change(players[0], { type: 'schedule', slot: 'semifinal-1', scheduledAtEpochMs });
        const response = await server.app.request(base, { headers: headers(players[0]) });
        const attempt = decodeTournamentSnapshot(await response.json()).tournament!.matches[0].attempt!;
        for (const player of players.slice(0, 2)) {
            await change(player, { type: 'check-in', slot: 'semifinal-1', attemptId: attempt.binding.attemptId });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, scheduledAtEpochMs - Date.now())));
        await change(players[0], { type: 'start', slot: 'semifinal-1', attemptId: attempt.binding.attemptId });
        const arenaPath = `/api/ar-eye/rooms/${attempt.binding.roomRef.groupId}/tournament`;
        const arena = await waitFor('native tournament arena', async () => {
            const response = await server.app.request(arenaPath, { headers: headers(players[0]) });
            assert.equal(response.status, 200, await response.clone().text());
            const value = await response.json();
            if (value === null) {
                return undefined;
            }
            const snapshot = decodeArenaTournamentSnapshot(value);
            return snapshot.state === null ? undefined : snapshot;
        });
        assert.deepEqual(arena.binding, attempt.binding);
        assert.equal(arena.state!.arena.match?.status, 'active');
        assert.equal((await server.app.request(arenaPath, { headers: headers(players[2]) })).status, 403);
        await change(players[0], { type: 'cancel' });
        const terminal = await waitFor('durable native cancellation', async () => published.find((frame) => frame.status === 'cancelled'));
        assert.deepEqual(terminal.binding, attempt.binding);
        assert.ok(terminal.attemptRevision > arena.attemptRevision);
    }
    finally {
        await server.stop();
    }
});

function headers(session: AuthSession): Record<string, string> {
    return { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId, 'content-type': 'application/json' };
}
