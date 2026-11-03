import { createTournamentResult, decodeTournamentResult } from '@shared-server/rallar-system/tournaments/tournament-result.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { describe, expect, it } from 'vitest';

const binding: TournamentMatchBinding = {
    tournamentRef: { applicationId: 'game', workspaceId: 'default', tournamentId: 'cup' },
    slot: 'semifinal-1',
    attemptId: 'attempt-1',
    roomRef: { applicationId: 'game', workspaceId: 'default', groupId: 'arena' },
    gameId: 'game-instance-1',
    rulesId: 'native-score-v1',
    principalIds: ['alice', 'bob']
};

function result(scores: readonly [number, number] = [100, 20]) {
    return createTournamentResult({
        binding,
        authority: { kind: 'server', id: 'game-owner', epoch: 1 },
        startedAtEpochMs: 1000,
        finishedAtEpochMs: 61000,
        scores
    });
}

describe('server-owned tournament result facts', () => {
    it('binds native scores to the two accounts and round-trips the immutable result', () => {
        const completed = result();
        expect(completed.summary).toEqual(binding);
        expect(completed.matchId).toBe(binding.gameId);
        expect(completed.roomRef).toEqual(binding.roomRef);
        expect(completed.trust).toBe('server-validated');
        expect(completed.standings).toEqual([
            { participantId: 'alice', principalId: 'alice', sessionIds: [], metrics: { points: 100 }, rank: 1, tieGroup: 1 },
            { participantId: 'bob', principalId: 'bob', sessionIds: [], metrics: { points: 20 }, rank: 2, tieGroup: 2 }
        ]);
        expect(decodeTournamentResult(JSON.parse(JSON.stringify(completed)), binding)).toEqual(completed);
        expect(result().idempotencyKey).toBe(completed.idempotencyKey);
    });

    it('preserves native-score ties and negative scores without a secondary tiebreaker', () => {
        expect(result([-5, -5]).standings.map((row) => row.rank)).toEqual([1, 1]);
        expect(result([5, 10]).standings.map((row) => row.principalId)).toEqual(['bob', 'alice']);
    });

    it.each([
        { tournamentRef: { ...binding.tournamentRef, applicationId: 'other' } },
        { tournamentRef: { ...binding.tournamentRef, workspaceId: 'other' } },
        { tournamentRef: { ...binding.tournamentRef, tournamentId: 'other' } },
        { slot: 'final' },
        { attemptId: 'old-attempt' },
        { roomRef: { ...binding.roomRef, groupId: 'other' } },
        { gameId: 'old-game' },
        { rulesId: 'other-rules' },
        { principalIds: ['alice', 'mallory'] },
        { principalIds: ['bob', 'alice'] }
    ])('rejects a result from a different binding: %j', (change) => {
        const completed = result();
        expect(() => decodeTournamentResult({ ...completed, summary: { ...binding, ...change } }, binding)).toThrow();
    });

    it.each([
        { trust: 'room-trusted' },
        { authority: { kind: 'browser-director', id: 'alice', epoch: 1 } },
        { authority: { kind: 'server', id: 'owner', epoch: -1 } },
        { matchId: 'other' },
        { protocol: 'other' },
        { resultId: 'other' },
        { idempotencyKey: 'other' },
        { startedAtEpochMs: 62000 },
        { finishedAtEpochMs: NaN },
        { winner: 'mallory' },
        { roomRef: { ...binding.roomRef, workspaceId: 'other' } }
    ])('fails closed on malformed stored result fields: %j', (change) => {
        expect(() => decodeTournamentResult({ ...result(), ...change }, binding)).toThrow();
    });

    it('rejects duplicate, missing and reordered standings, forged ranks and non-native metrics', () => {
        const completed = result();
        const first = completed.standings[0];
        const second = completed.standings[1];
        for (
            const standings of [
                [first],
                [first, first],
                [second, first],
                [{ ...first, principalId: 'mallory' }, second],
                [{ ...first, rank: 2 }, second],
                [first, { ...second, tieGroup: 1 }],
                [{ ...first, metrics: { points: Infinity } }, second],
                [{ ...first, metrics: { points: 100, kills: 1 } }, second],
                [{ ...first, sessionIds: ['client-session'] }, second]
            ]
        ) {
            expect(() => decodeTournamentResult({ ...completed, standings }, binding)).toThrow();
        }
    });

    it('rejects invalid producer inputs before preparing a durable fact', () => {
        for (const scores of [[NaN, 1], [Infinity, 1], [Number.MAX_SAFE_INTEGER + 1, 1], [1.5, 1]] as const) {
            expect(() => result(scores)).toThrow();
        }
        expect(() =>
            createTournamentResult({
                binding: { ...binding, principalIds: ['alice', 'alice'] },
                authority: { kind: 'server', id: 'owner', epoch: 1 },
                startedAtEpochMs: 1000,
                finishedAtEpochMs: 2000,
                scores: [1, 2]
            })
        ).toThrow();
    });
});
