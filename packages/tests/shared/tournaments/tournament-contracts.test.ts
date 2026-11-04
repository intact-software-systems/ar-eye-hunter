import { decodeTournament } from '@shared/api/tournaments/decode-tournament.ts';
import { decodeTournamentRequest } from '@shared/api/tournaments/tournament-request.ts';
import { computeTournament, createTournament } from '@shared/tournaments/compute-tournament.ts';
import type { TournamentCommand } from '@shared/tournaments/tournament-command.ts';
import { describe, expect, it } from 'vitest';

describe('tournament public contracts', () => {
    it('round-trips canonical registration and scheduled bracket states', () => {
        for (const state of [registration(), scheduled()]) {
            expect(decodeTournament(JSON.parse(JSON.stringify(state)))).toEqual(state);
        }
    });
    it.each([
        { type: 'create', title: 'Friday cup' },
        { type: 'register' },
        { type: 'withdraw' },
        { type: 'launch' },
        { type: 'cancel' },
        { type: 'schedule', slot: 'semifinal-1', scheduledAtEpochMs: 1000 },
        { type: 'check-in', slot: 'final', attemptId: 'attempt' },
        { type: 'start', slot: 'semifinal-2', attemptId: 'attempt' }
    ])('decodes only the public intent %j', (request) => {
        expect(decodeTournamentRequest(request)).toEqual(request);
    });
    it.each([
        { type: 'reconcile' },
        { type: 'register', principalId: 'other-account' },
        { type: 'create', title: 'Friday cup', rulesId: 'client-selected' },
        { type: 'schedule', slot: 'final', scheduledAtEpochMs: 1000, roomId: 'substituted-room' },
        { type: 'start', slot: 'final', attemptId: 'attempt', scores: [100, 0] },
        { type: 'schedule', slot: 'final', scheduledAtEpochMs: -1 }
    ])('rejects private authority in public intent %j', (request) => {
        expect(() => decodeTournamentRequest(request)).toThrow();
    });
    it('rejects missing fields, duplicate entrants and a substituted attempt scope', () => {
        const state = scheduled();
        const { championPrincipalId: _champion, ...missing } = state;
        expect(() => decodeTournament(missing)).toThrow();
        expect(() => decodeTournament({ ...state, entrants: [state.entrants[0], ...state.entrants.slice(0, 3)] })).toThrow();
        const match = state.matches[0];
        expect(() =>
            decodeTournament({
                ...state,
                matches: [{
                    ...match,
                    attempt: {
                        ...match.attempt,
                        binding: { ...match.attempt!.binding, tournamentRef: { ...state.ref, tournamentId: 'another-cup' } }
                    }
                }, ...state.matches.slice(1)]
            })
        ).toThrow();
    });
    it('rejects fabricated advancement, repeated check-ins and a champion without a final result', () => {
        const state = scheduled();
        expect(() => decodeTournament({ ...state, championPrincipalId: 'alice', status: 'complete' })).toThrow();
        expect(() =>
            decodeTournament({
                ...state,
                matches: state.matches.map((match) =>
                    match.slot === 'final'
                        ? {
                            ...match,
                            principalIds: ['alice', 'charlie'],
                            status: 'ready'
                        }
                        : match
                )
            })
        ).toThrow();
        const match = state.matches[0];
        expect(() =>
            decodeTournament({
                ...state,
                matches: [{ ...match, attempt: { ...match.attempt, checkedInPrincipalIds: ['alice', 'alice'] } }, ...state.matches.slice(1)]
            })
        ).toThrow();
    });
});

function registration() {
    return createTournament({
        ref: { applicationId: 'game', workspaceId: 'default', tournamentId: 'cup' },
        title: 'Friday cup',
        organizerPrincipalId: 'host',
        rulesId: 'native',
        createdAtEpochMs: 1,
        noShowGraceMs: 600000
    });
}

function scheduled() {
    let state = registration();
    for (const actorPrincipalId of ['alice', 'bob', 'charlie', 'dana']) {
        state = computeTournament({ state, actorPrincipalId, command: { type: 'register' }, nowEpochMs: 2, results: [] }).state;
    }
    const commands: readonly TournamentCommand[] = [
        { type: 'launch' },
        { type: 'schedule', slot: 'semifinal-1', attemptId: 'attempt', roomId: 'room', gameId: 'game', scheduledAtEpochMs: 1000 }
    ];
    for (const command of commands) {
        state = computeTournament({ state, actorPrincipalId: 'host', command, nowEpochMs: 3, results: [] }).state;
    }
    return state;
}
