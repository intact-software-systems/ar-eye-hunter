import { createTournamentResult } from '@shared-server/rallar-system/tournaments/tournament-result.ts';
import { decodeTournament } from '@shared/api/tournaments/decode-tournament.ts';
import type { Tournament, TournamentMatchBinding, TournamentMatchResult } from '@shared/api/tournaments/tournament-types.ts';
import { computeTournament, createTournament } from '@shared/tournaments/compute-tournament.ts';
import type { TournamentCommand } from '@shared/tournaments/tournament-command.ts';
import { describe, expect, it } from 'vitest';

const REF = { applicationId: 'game', workspaceId: 'default', tournamentId: 'cup' };
const START = 1000000;

function created(grace = 600000): Tournament {
    return createTournament({ ref: REF, title: 'Friday cup', organizerPrincipalId: 'host', rulesId: 'native', createdAtEpochMs: 1, noShowGraceMs: grace });
}

function act(state: Tournament, command: TournamentCommand, actorPrincipalId: string | null = 'host', nowEpochMs = START) {
    const decision = computeTournament({ state, command, actorPrincipalId, nowEpochMs, results: [] });
    expect(decodeTournament(decision.state)).toEqual(decision.state);
    return decision;
}

function bracket(grace = 600000): Tournament {
    let state = created(grace);
    for (const name of ['alice', 'bob', 'charlie', 'dana']) {
        const decision = act(state, { type: 'register' }, name, 10);
        expect(decision.refusal).toBeNull();
        state = decision.state;
    }
    const launched = act(state, { type: 'launch' });
    expect(launched.refusal).toBeNull();
    return launched.state;
}

function schedule(state: Tournament, slot: TournamentMatchBinding['slot'] = 'semifinal-1', attemptId = 'attempt-1'): Tournament {
    const decision = act(state, { type: 'schedule', slot, attemptId, roomId: `room-${attemptId}`, gameId: `game-${attemptId}`, scheduledAtEpochMs: START });
    expect(decision.refusal).toBeNull();
    return decision.state;
}

function playing(state: Tournament, slot: TournamentMatchBinding['slot'], attemptId: string): Tournament {
    let next = schedule(state, slot, attemptId);
    const match = next.matches.find((candidate) => candidate.slot === slot)!;
    for (const principalId of match.principalIds!) {
        const checked = act(next, { type: 'check-in', slot, attemptId }, principalId);
        expect(checked.refusal).toBeNull();
        next = checked.state;
    }
    const started = act(next, { type: 'start', slot, attemptId });
    expect(started.refusal).toBeNull();
    return started.state;
}

function result(state: Tournament, slot: TournamentMatchBinding['slot'], scores: readonly [number, number]): TournamentMatchResult {
    const attempt = state.matches.find((match) => match.slot === slot)!.attempt!;
    return createTournamentResult({
        binding: attempt.binding,
        authority: { kind: 'server', id: 'game-owner', epoch: 1 },
        startedAtEpochMs: attempt.startedAtEpochMs!,
        finishedAtEpochMs: START + 1000,
        scores
    });
}

function reconcile(state: Tournament, results: readonly TournamentMatchResult[], nowEpochMs = START + 1000) {
    const decision = computeTournament({ state, command: { type: 'reconcile' }, actorPrincipalId: null, nowEpochMs, results });
    expect(decodeTournament(decision.state)).toEqual(decision.state);
    return decision.state;
}

describe('four-player tournament policy', () => {
    it('registers explicitly, seeds by registration order, and limits capacity to four accounts', () => {
        const initial = created();
        expect(initial.entrants).toEqual([]);
        const state = bracket();
        expect(state.matches.map((match) => match.principalIds)).toEqual([['alice', 'bob'], ['charlie', 'dana'], null]);
        expect(act(state, { type: 'register' }, 'eve').refusal).toBe('registration-closed');
        expect(act(created(), { type: 'launch' }).refusal).toBe('four-entrants-required');
    });

    it('replays registration without changing its seed and frees a withdrawn registration seat', () => {
        const initial = act(created(), { type: 'register' }, 'alice').state;
        expect(act(initial, { type: 'register' }, 'alice').state).toEqual(initial);
        const left = act(initial, { type: 'withdraw' }, 'alice').state;
        expect(left.entrants).toEqual([]);
    });

    it('requires the organizer, both exact-attempt check-ins and the scheduled start time', () => {
        let state = schedule(bracket());
        expect(act(state, { type: 'start', slot: 'semifinal-1', attemptId: 'attempt-1' }).refusal).toBe('both-check-ins-required');
        expect(act(state, { type: 'check-in', slot: 'semifinal-1', attemptId: 'old' }, 'alice').refusal).toBe('stale-attempt');
        expect(act(state, { type: 'check-in', slot: 'semifinal-1', attemptId: 'attempt-1' }, 'eve').refusal).toBe('not-a-competitor');
        for (const principalId of ['alice', 'bob']) {
            state = act(state, { type: 'check-in', slot: 'semifinal-1', attemptId: 'attempt-1' }, principalId, START - 1).state;
        }
        expect(act(state, { type: 'start', slot: 'semifinal-1', attemptId: 'attempt-1' }, 'alice').refusal).toBe('organizer-required');
        expect(act(state, { type: 'start', slot: 'semifinal-1', attemptId: 'attempt-1' }, 'host', START - 1).refusal).toBe('before-start');
    });

    it('advances only one checked-in opponent at the exact configurable grace deadline', () => {
        let state = schedule(bracket());
        state = act(state, { type: 'check-in', slot: 'semifinal-1', attemptId: 'attempt-1' }, 'bob').state;
        expect(reconcile(state, [], START + 599999).matches[0].status).toBe('scheduled');
        const elapsed = reconcile(state, [], START + 600000);
        expect(elapsed.matches[0].resolution).toMatchObject({ reason: 'no-show', winnerPrincipalId: 'bob', resultId: null });
        expect(act(state, { type: 'check-in', slot: 'semifinal-1', attemptId: 'attempt-1' }, 'alice', START + 600000).refusal).toBe('match-resolved');
    });

    it('leaves neither checked in unresolved and clears check-ins when the organizer reschedules', () => {
        const elapsed = reconcile(schedule(bracket()), [], START + 600000);
        expect(elapsed.matches[0].status).toBe('unresolved');
        expect(elapsed.matches[0].resolution).toBeNull();
        const rescheduled = act(
            elapsed,
            { type: 'schedule', slot: 'semifinal-1', attemptId: 'new', roomId: 'new-room', gameId: 'new-game', scheduledAtEpochMs: START + 700000 },
            'host',
            START + 600000
        );
        expect(rescheduled.refusal).toBeNull();
        expect(rescheduled.state.matches[0].attempt?.checkedInPrincipalIds).toEqual([]);
        expect(act(rescheduled.state, { type: 'check-in', slot: 'semifinal-1', attemptId: 'attempt-1' }, 'alice').refusal).toBe('stale-attempt');
    });

    it('keeps two checked-in players waiting for an explicit start after the grace deadline', () => {
        let state = schedule(bracket());
        for (const principalId of ['alice', 'bob']) {
            state = act(state, { type: 'check-in', slot: 'semifinal-1', attemptId: 'attempt-1' }, principalId).state;
        }
        expect(reconcile(state, [], START + 600001).matches[0].status).toBe('scheduled');
    });

    it('requires a replay for tied native scores and ignores the old result after rescheduling', () => {
        const state = playing(bracket(), 'semifinal-1', 'tie');
        const tiedResult = result(state, 'semifinal-1', [8, 8]);
        const tied = reconcile(state, [tiedResult]);
        expect(tied.matches[0].status).toBe('tied');
        expect(tied.matches[0].resolution).toBeNull();
        const replay = schedule(tied, 'semifinal-1', 'replay');
        expect(reconcile(replay, [tiedResult])).toEqual(replay);
    });

    it('plays both semifinals and a final and accepts a final result only once', () => {
        let state = playing(bracket(), 'semifinal-1', 'first');
        state = reconcile(state, [result(state, 'semifinal-1', [20, 5])]);
        state = playing(state, 'semifinal-2', 'second');
        state = reconcile(state, [result(state, 'semifinal-2', [3, 12])]);
        expect(state.matches[2].principalIds).toEqual(['alice', 'dana']);
        state = playing(state, 'final', 'final');
        const final = result(state, 'final', [9, 17]);
        const completed = reconcile(state, [final]);
        expect(completed.status).toBe('complete');
        expect(completed.championPrincipalId).toBe('dana');
        expect(reconcile(completed, [final])).toEqual(completed);
    });

    it('makes withdrawal explicit and never treats a missing connection as withdrawal', () => {
        const state = playing(bracket(), 'semifinal-1', 'first');
        expect(reconcile(state, [], START + 999999).matches[0].status).toBe('playing');
        const left = act(state, { type: 'withdraw' }, 'alice').state;
        expect(left.matches[0].resolution).toBeNull();
        expect(reconcile(left, [], START + 600000).matches[0].resolution).toMatchObject({ reason: 'withdrawal', winnerPrincipalId: 'bob' });
    });

    it('cancels active attempts and refuses late results without inventing a champion', () => {
        const state = playing(bracket(), 'semifinal-1', 'first');
        const late = result(state, 'semifinal-1', [9, 1]);
        const cancelled = act(state, { type: 'cancel' }).state;
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.championPrincipalId).toBeNull();
        expect(reconcile(cancelled, [late])).toEqual(cancelled);
    });
    it('does not award a withdrawal to an unchecked opponent or advance when both entrants withdraw', () => {
        const scheduled = schedule(bracket());
        const first = act(scheduled, { type: 'withdraw' }, 'alice').state;
        expect(reconcile(first, [], START + 600000).matches[0].resolution).toBeNull();
        const both = act(first, { type: 'withdraw' }, 'bob').state;
        expect(reconcile(both, [], START + 600000).matches[0].resolution).toBeNull();
        expect(both.championPrincipalId).toBeNull();
        expect(act(first, { type: 'check-in', slot: 'semifinal-1', attemptId: 'attempt-1' }, 'alice').refusal).toBe('entrant-withdrawn');
    });

    it('lets the remaining opponent check in before a withdrawn match deadline', () => {
        const left = act(schedule(bracket()), { type: 'withdraw' }, 'alice').state;
        const checked = act(left, { type: 'check-in', slot: 'semifinal-1', attemptId: 'attempt-1' }, 'bob');
        expect(checked.refusal).toBeNull();
        expect(reconcile(checked.state, [], START + 600000).matches[0].resolution).toMatchObject({ reason: 'withdrawal', winnerPrincipalId: 'bob' });
    });
    it('uses the configured grace instead of a hard-coded ten-minute deadline', () => {
        let state = schedule(bracket(2000));
        state = act(state, { type: 'check-in', slot: 'semifinal-1', attemptId: 'attempt-1' }, 'alice').state;
        expect(reconcile(state, [], START + 1999).matches[0].resolution).toBeNull();
        expect(reconcile(state, [], START + 2000).matches[0].resolution?.winnerPrincipalId).toBe('alice');
    });

    it.each([0, -1, Infinity, 1.5])('rejects invalid no-show grace %s', (grace) => {
        expect(() => created(grace)).toThrow();
    });
});
