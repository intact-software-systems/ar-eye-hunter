import { computeTournamentStorage, TournamentRepository } from '@shared-server/rallar-system/tournaments/tournament-repository.ts';
import { writeTournamentGame } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { computeTournamentResultPublication } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { createTournamentResult } from '@shared-server/rallar-system/tournaments/tournament-result.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { writeRuntimeStateConditionalBatch } from '@shared-server/runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import { computeTournament, createTournament } from '@shared/tournaments/compute-tournament.ts';
import type { TournamentCommand } from '@shared/tournaments/tournament-command.ts';
import { describe, expect, it } from 'vitest';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const REF = { applicationId: 'game', workspaceId: 'default', tournamentId: 'cup' };

describe('tournament bracket persistence', () => {
    it('admits only one of two contenders for the last registration seat', async () => {
        const game = await fixture();
        try {
            for (const actor of ['alice', 'bob', 'charlie']) {
                await change(game, { type: 'register' }, actor);
            }
            const before = await game.repository.read(REF);
            const contenders = ['dana', 'eve'].map((actor) =>
                computeTournamentStorage(before, {
                    ...before.record!,
                    tournament: computeTournament({
                        state: before.record!.tournament,
                        command: { type: 'register' },
                        actorPrincipalId: actor,
                        nowEpochMs: 1000,
                        results: []
                    }).state
                })
            );
            await game.storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, contenders[0]));
            await expect(game.storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, contenders[1]))).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
            const current = await game.repository.read(REF);
            expect(current.record!.tournament.entrants.map((entrant) => entrant.principalId)).toEqual(['alice', 'bob', 'charlie', 'dana']);
            expect(
                computeTournament({ state: current.record!.tournament, command: { type: 'register' }, actorPrincipalId: 'eve', nowEpochMs: 1000, results: [] })
                    .refusal
            ).toBe('tournament-full');
        }
        finally {
            await game.storage.close();
        }
    });

    it('atomically revokes an old attempt on rescheduling and preserves exact check-in consent privately', async () => {
        const game = await fixture();
        try {
            await prepareBracket(game);
            await change(game, {
                type: 'schedule',
                slot: 'semifinal-1',
                attemptId: 'first',
                roomId: 'first-room',
                gameId: 'first-room',
                scheduledAtEpochMs: 1000
            });
            let before = await game.repository.read(REF);
            expect(before.attempts[0].attempt?.status).toBe('scheduled');
            const first = before.attempts[0].binding;
            await checkIn(game, 'alice');
            await checkIn(game, 'bob');
            await change(game, { type: 'start', slot: 'semifinal-1', attemptId: 'first' });
            before = await game.repository.read(REF);
            const result = createTournamentResult({
                binding: first,
                authority: { kind: 'server', id: 'game-owner', epoch: 1 },
                startedAtEpochMs: 1000,
                finishedAtEpochMs: 2000,
                scores: [10, 0]
            });
            const completion = computeTournamentResultPublication(before.attempts[0], result, Date.now());
            expect(completion.kind).toBe('publish');
            await change(game, {
                type: 'schedule',
                slot: 'semifinal-1',
                attemptId: 'second',
                roomId: 'second-room',
                gameId: 'second-room',
                scheduledAtEpochMs: 2000
            });
            if (completion.kind !== 'publish') {
                throw new Error('Expected prepared final result');
            }
            await expect(game.storage.sql.begin((transaction) => writeTournamentGame(transaction, completion.write))).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
            const after = await game.repository.read(REF);
            expect(after.record!.checkIns).toEqual([]);
            expect(after.attempts[0].binding.attemptId).toBe('second');
            expect(after.attempts[0].attempt?.status).toBe('scheduled');
        }
        finally {
            await game.storage.close();
        }
    });

    it('rejects a private consent whose account or attempt differs from the public check-in', async () => {
        const game = await fixture();
        try {
            await prepareBracket(game);
            await change(game, {
                type: 'schedule',
                slot: 'semifinal-1',
                attemptId: 'first',
                roomId: 'first-room',
                gameId: 'first-room',
                scheduledAtEpochMs: 1000
            });
            const before = await game.repository.read(REF);
            expect(() =>
                computeTournamentStorage(before, {
                    ...before.record!,
                    checkIns: [{ slot: 'semifinal-1', attemptId: 'first', actor: { principalId: 'eve', sessionId: 'eve-session', issuedAtEpochMs: 1 } }]
                })
            ).toThrow();
        }
        finally {
            await game.storage.close();
        }
    });
});

async function fixture() {
    const storage = await createResourceInboxTestStorage('tournament_bracket', 4);
    const runtime = new PSqlRuntimeStateRepository(storage.sql);
    const repository = new TournamentRepository(runtime);
    const initial = createTournament({
        ref: REF,
        title: 'Friday cup',
        organizerPrincipalId: 'host',
        rulesId: 'native',
        createdAtEpochMs: 1,
        noShowGraceMs: 600000
    });
    const before = await repository.read(REF);
    await storage.sql.begin((transaction) =>
        writeRuntimeStateConditionalBatch(transaction, computeTournamentStorage(before, { tournament: initial, checkIns: [] }))
    );
    return { storage, runtime, repository };
}

async function change(game: Awaited<ReturnType<typeof fixture>>, command: TournamentCommand, actorPrincipalId = 'host') {
    const before = await game.repository.read(REF);
    const decision = computeTournament({
        state: before.record!.tournament,
        command,
        actorPrincipalId,
        nowEpochMs: 1000,
        results: before.attempts.flatMap((attempt) => attempt.result === null ? [] : [attempt.result])
    });
    expect(decision.refusal).toBeNull();
    const record = {
        tournament: decision.state,
        checkIns: before.record!.checkIns.filter((consent) =>
            decision.state.matches.some((match) => match.slot === consent.slot && match.attempt?.binding.attemptId === consent.attemptId)
        )
    };
    await game.storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, computeTournamentStorage(before, record)));
}

async function prepareBracket(game: Awaited<ReturnType<typeof fixture>>) {
    for (const actor of ['alice', 'bob', 'charlie', 'dana']) {
        await change(game, { type: 'register' }, actor);
    }
    await change(game, { type: 'launch' });
}

async function checkIn(game: Awaited<ReturnType<typeof fixture>>, principalId: string) {
    const before = await game.repository.read(REF);
    const command: TournamentCommand = { type: 'check-in', slot: 'semifinal-1', attemptId: 'first' };
    const tournament = computeTournament({ state: before.record!.tournament, command, actorPrincipalId: principalId, nowEpochMs: 1000, results: [] }).state;
    const record = {
        tournament,
        checkIns: [...before.record!.checkIns, {
            slot: command.slot,
            attemptId: command.attemptId,
            actor: { principalId, sessionId: principalId + '-session', issuedAtEpochMs: 1 }
        }]
    };
    await game.storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, computeTournamentStorage(before, record)));
}
