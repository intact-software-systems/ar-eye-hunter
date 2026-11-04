import { createRelicGame, isRelicSnapshot, toPublicRelicSnapshot } from '@relic-hunters/mod.ts';
import { relicPlayerId } from '@relic-hunters/src/relic-tournament-participation.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { expect, it } from 'vitest';

const binding: TournamentMatchBinding = {
    tournamentRef: { applicationId: 'rallar-server', workspaceId: 'default', tournamentId: 'cup' },
    slot: 'semifinal-1',
    attemptId: 'attempt',
    gameId: 'room',
    roomRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'room' },
    rulesId: 'relic-native-10-rounds-v1',
    principalIds: ['alice', 'bob']
};

it('exposes authoritative tournament participation without changing the persisted game format', () => {
    const game = createRelicGame('room', 'room', 1000);
    const casual = toPublicRelicSnapshot(game);
    const tournament = toPublicRelicSnapshot(game, { binding, status: 'playing' });
    expect(casual.tournament).toBeNull();
    expect(tournament.tournament).toEqual({ binding, status: 'playing' });
    expect(game).not.toHaveProperty('tournament');
    expect(isRelicSnapshot(tournament)).toBe(true);
    expect(isRelicSnapshot({ ...tournament, tournament: { binding: { ...binding, gameId: 'other' }, status: 'playing' } })).toBe(false);
    const { tournament: omitted, ...incomplete } = tournament;
    expect(omitted).toEqual({ binding, status: 'playing' });
    expect(isRelicSnapshot(incomplete)).toBe(false);
});

it('keeps a tournament hunter across sessions while casual hunters remain session-owned', () => {
    const actor = { clientId: 'alice', sessionId: 'old-session' };
    expect(relicPlayerId(binding, actor)).toBe('alice');
    expect(relicPlayerId(binding, { ...actor, sessionId: 'new-session' })).toBe('alice');
    expect(relicPlayerId(null, actor)).toBe('old-session');
});
