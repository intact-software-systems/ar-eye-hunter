import { createRelicGame, RELIC_PROTOCOL_VERSION, type RelicCommand } from '@relic-hunters/mod.ts';
import { RelicGameMutationService } from '@relic-hunters/server/relic-game-mutation-service.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { TOURNAMENT_ATTEMPTS_NAMESPACE } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';
import { createTestAuthSession } from '../shared-server/rallar-system/group-state/group-state-test-runtime.ts';
import { connectGameSession, prepareGameWrite } from './relic-game-database-fixture.ts';
import { createTournamentGameFixture } from './relic-tournament-database-fixture.ts';

describe('Relic tournament authority', () => {
    it('requires the committed native start before public initialization or gameplay', async () => {
        const game = await createTournamentGameFixture();
        try {
            const proposal = createRelicGame(game.ref.groupId, game.ref.groupId, game.nowEpochMs);
            const prepared = await prepareGameWrite(game, game.command, proposal);
            expect(game.service.needsInitialState(prepared.read)).toBe(false);
            expect(prepared.computed.result).toMatchObject({ status: 'refused', code: 'tournament-start-pending' });
            expect(prepared.computed.save).toBeNull();
        }
        finally {
            await game.storage.close();
        }
    });

    it('publishes the actual native final scores atomically and refuses a second game in that attempt', async () => {
        const game = await tournamentFixture();
        try {
            await move(game, game.owner, { kind: 'join-expedition' });
            await move(game, game.guest, { kind: 'join-expedition' });
            for (let round = 0; round < 10; round++) {
                const before = await game.service.readCurrentSnapshot(game.command, 'relic-test');
                if (before?.phase === 'finished') {
                    break;
                }
                for (const session of [game.owner, game.guest]) {
                    const hunter = before?.players.find((player) => player.playerId === session.clientId);
                    if (hunter && !hunter.defeated && !hunter.escaped) {
                        await move(game, session, { kind: 'submit-action', action: { kind: 'search' } });
                    }
                }
                await move(game, game.owner, { kind: 'continue-review' });
            }
            const finished = await game.service.readCurrentSnapshot(game.command, 'relic-test');
            expect(finished?.phase).toBe('finished');
            const stored = await game.tournaments.read(game.binding);
            expect(stored.attempt?.status).toBe('finished');
            expect(stored.result?.standings).toHaveLength(2);
            for (const hunter of finished!.players) {
                expect(stored.result?.standings.find((row) => row.principalId === hunter.playerId)?.metrics.points).toBe(hunter.score);
            }
            const replay = await prepareGameWrite(game, { ...game.command, requestId: 'finished-ensure' }, null);
            expect(replay.computed.result.status).toBe('initialized');
            await game.storage.sql.begin((transaction) => game.service.write(transaction, replay.computed));
            expect((await game.tournaments.read(game.binding)).result).toEqual(stored.result);
            const restart = await prepareMove(game, game.owner, { kind: 'start-expedition' });
            expect(restart.computed.result).toMatchObject({ status: 'refused', code: 'tournament-settings-frozen' });
        }
        finally {
            await game.storage.close();
        }
    }, 15000);

    it('keeps one hunter per account across a new session and freezes match settings', async () => {
        const game = await tournamentFixture();
        try {
            await move(game, game.owner, { kind: 'join-expedition' });
            const replacement = { ...createTestAuthSession(game.owner.clientId), sessionId: 'owner-reconnected' };
            await connectGameSession(game, replacement);
            await move(game, replacement, { kind: 'join-expedition' });
            const snapshot = await game.service.readCurrentSnapshot(game.command, 'relic-test');
            expect(snapshot?.players.map((player) => player.playerId)).toEqual(game.binding.principalIds);
            expect(snapshot?.tournament).toEqual({ binding: game.binding, status: 'playing' });
            const reset = await prepareGameWrite(game, { ...game.command, operation: 'reset', requestId: 'reset-tournament' }, null);
            expect(reset.computed.result).toMatchObject({ status: 'refused', code: 'tournament-settings-frozen' });
            const change = await prepareMove(game, game.owner, { kind: 'set-round-limit', timeLimitMs: 180000 });
            expect(change.computed.result).toMatchObject({ status: 'refused', code: 'tournament-settings-frozen' });
        }
        finally {
            await game.storage.close();
        }
    });

    it.each(['authentication', 'presence'] as const)('refuses revoked %s observed while acquiring conditional authority', async (revoked) => {
        const game = await tournamentFixture();
        const sessions = new AuthSessionPersistence(game.runtime);
        try {
            const persistence = {
                async readSessionBySessionIdEntry(sessionId: string) {
                    if (revoked === 'authentication' && sessionId === game.owner.sessionId) {
                        await sessions.deleteSession(game.owner);
                    }
                    return await sessions.readSessionBySessionIdEntry(sessionId);
                }
            };
            const service = new RelicGameMutationService({
                groups: {
                    readSnapshotWithAuthorityGuard: (ref) => game.repository.readSnapshotWithAuthorityGuard(ref),
                    async readPresenceEntry(ref) {
                        if (revoked === 'presence' && ref.sessionId === game.owner.sessionId) {
                            const current = await game.repository.findPresenceEntry(ref);
                            if (current) {
                                await game.repository.deletePresence(ref, current.entry.revision);
                            }
                        }
                        return await game.repository.readPresenceEntry(ref);
                    }
                },
                sessions: persistence,
                data: game.data,
                tournaments: game.tournaments
            }, { now: () => game.nowEpochMs });
            const before = await game.data.read(game.ref);
            const attempt = await prepareGameWrite({ ...game, service }, {
                ...game.command,
                operation: 'command',
                requestId: 'revoked-during-read',
                move: {
                    protocolVersion: RELIC_PROTOCOL_VERSION,
                    gameId: game.ref.groupId,
                    username: game.owner.username,
                    kind: 'submit-action',
                    action: { kind: 'search' }
                }
            }, null);
            expect(attempt.computed.result).toMatchObject({ status: 'refused', httpStatus: revoked === 'authentication' ? 401 : 403 });
            await game.storage.sql.begin((transaction) => service.write(transaction, attempt.computed));
            expect(await game.data.read(game.ref)).toEqual(before);
            expect((await game.tournaments.read(game.binding)).result).toBeNull();
        }
        finally {
            await game.storage.close();
        }
    });

    it('rejects self-steal score inflation before a native save or result can be written', async () => {
        const game = await tournamentFixture();
        try {
            await move(game, game.owner, { kind: 'submit-action', action: { kind: 'search' } });
            await move(game, game.guest, { kind: 'submit-action', action: { kind: 'search' } });
            await move(game, game.owner, { kind: 'continue-review' });
            const snapshot = await game.service.readCurrentSnapshot(game.command, 'relic-test');
            expect(snapshot?.players.find((hunter) => hunter.playerId === game.owner.clientId)?.relicIds).toEqual(['visitor-badge']);
            const before = await game.data.read(game.ref);
            const attempted = await prepareGameWrite(game, {
                ...game.command,
                operation: 'command',
                requestId: 'steal-own-relic',
                move: {
                    protocolVersion: RELIC_PROTOCOL_VERSION,
                    gameId: game.ref.groupId,
                    username: game.owner.username,
                    kind: 'submit-action',
                    action: { kind: 'steal', targetPlayerId: game.owner.clientId }
                }
            }, null);
            expect(attempted.computed.result).toMatchObject({ status: 'refused', code: 'rule-refused', message: 'Steal requires a different hunter.' });
            await game.storage.sql.begin((transaction) => game.service.write(transaction, attempted.computed));
            expect(await game.data.read(game.ref)).toEqual(before);
            expect((await game.tournaments.read(game.binding)).result).toBeNull();
        }
        finally {
            await game.storage.close();
        }
    });

    it('publishes cancelled participation without changing scores, the save, or a result', async () => {
        const game = await tournamentFixture();
        try {
            const saved = await game.data.read(game.ref);
            await game.runtime.upsert(
                TOURNAMENT_ATTEMPTS_NAMESPACE,
                groupStateGroupStorageKey(game.ref),
                JSON.stringify({ binding: game.binding, status: 'cancelled', startedAtEpochMs: game.nowEpochMs }),
                NEVER_EXPIRE_AT_TIMESTAMP
            );
            const command: RelicGameMutationService.ClockCommand = {
                operation: 'tournament-clock',
                gameId: game.ref.groupId,
                requestId: 'cancel-notice',
                actor: null,
                authorization: 'tournament',
                move: null,
                clock: { phase: 'cancelled', round: 1, dueAtEpochMs: game.nowEpochMs }
            };
            const read = await game.service.read(game.service.capture(command, null, 'relic-test'));
            const attempt = { ...read, attemptCount: 1, traceId: 'cancel-notice' };
            const computed = game.service.compute(attempt);
            expect(computed.result.status).toBe('applied');
            expect(game.service.validate(attempt, computed)).toEqual([]);
            await game.storage.sql.begin((transaction) => game.service.write(transaction, computed));
            const rows = await game.storage.sql<readonly { resource: string; }[]>`
                select ri_resource as resource from resource_inbox where ri_topic_id = 'room.relic.snapshot'
            `;
            const messages = rows.map((row) => JSON.parse(row.resource));
            expect(messages.map((message) => JSON.parse(message.payload.resource).snapshot.tournament.status))
                .toContain('cancelled');
            expect(await game.data.read(game.ref)).toEqual(saved);
            expect((await game.tournaments.read(game.binding)).result).toBeNull();
        }
        finally {
            await game.storage.close();
        }
    });

    it('fences a native game write against cancellation of its exact tournament attempt', async () => {
        const game = await tournamentFixture();
        try {
            const joining = await prepareMove(game, game.owner, { kind: 'join-expedition' });
            await game.runtime.upsert(
                TOURNAMENT_ATTEMPTS_NAMESPACE,
                groupStateGroupStorageKey(game.ref),
                JSON.stringify({ binding: game.binding, status: 'cancelled', startedAtEpochMs: game.nowEpochMs }),
                NEVER_EXPIRE_AT_TIMESTAMP
            );
            await expect(game.storage.sql.begin((transaction) => game.service.write(transaction, joining.computed))).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
            expect((await game.service.readCurrentSnapshot(game.command, 'relic-test'))?.players.map((player) => player.playerId)).toEqual(
                game.binding.principalIds
            );
        }
        finally {
            await game.storage.close();
        }
    });
});

type TournamentMove =
    | { readonly kind: 'join-expedition' | 'start-expedition' | 'continue-review'; }
    | { readonly kind: 'set-round-limit'; readonly timeLimitMs: number; }
    | { readonly kind: 'submit-action'; readonly action: { readonly kind: 'search'; }; };

async function tournamentFixture() {
    const game = await createTournamentGameFixture();
    const ingress = game.service.capture(
        {
            operation: 'tournament-clock',
            gameId: game.ref.groupId,
            requestId: 'native-start',
            actor: null,
            authorization: 'tournament',
            move: null,
            clock: { phase: 'start', round: 1, dueAtEpochMs: game.nowEpochMs }
        },
        null,
        'relic-test'
    );
    const read = await game.service.read(ingress);
    const initial = game.service.compute({ ...read, attemptCount: 1, traceId: 'native-start' });
    expect(initial.result.status).toBe('applied');
    await game.storage.sql.begin((transaction) => game.service.write(transaction, initial));
    return game;
}

async function prepareMove(game: Awaited<ReturnType<typeof tournamentFixture>>, session: typeof game.owner, input: TournamentMove) {
    const command: RelicCommand = { ...input, protocolVersion: RELIC_PROTOCOL_VERSION, gameId: game.ref.groupId, username: session.username };
    return await prepareGameWrite(game, {
        ...game.command,
        operation: 'command',
        requestId: crypto.randomUUID(),
        move: command,
        actor: { clientId: session.clientId, sessionId: session.sessionId, issuedAtEpochMs: session.issuedAtEpochMs }
    }, null);
}

async function move(game: Awaited<ReturnType<typeof tournamentFixture>>, session: typeof game.owner, input: TournamentMove) {
    const prepared = await prepareMove(game, session, input);
    expect(prepared.computed.result).toMatchObject({ status: 'applied' });
    await game.storage.sql.begin((transaction) => game.service.write(transaction, prepared.computed));
}
