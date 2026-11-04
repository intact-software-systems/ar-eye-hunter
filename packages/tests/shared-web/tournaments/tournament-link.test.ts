import { readTournamentLink, toTournamentLink } from '@shared-web/browser/tournaments/tournament-link.ts';
import { expect, it } from 'vitest';

it('round-trips an exact scoped bracket preview and rejects other games, duplicate or unknown fields', () => {
    const scope = { applicationId: 'game', workspaceId: 'default' };
    const ref = { ...scope, tournamentId: 'cup' };
    const link = new URL(toTournamentLink('https://game.example/#rallar-room?old', ref));
    expect(readTournamentLink(link.hash, scope)).toEqual(ref);
    expect(readTournamentLink(link.hash, { ...scope, applicationId: 'other' })).toBeNull();
    expect(readTournamentLink(`${link.hash}&tournamentId=other`, scope)).toBeNull();
    expect(readTournamentLink(`${link.hash}&register=true`, scope)).toBeNull();
    expect(readTournamentLink('#rallar-room?groupId=cup', scope)).toBeNull();
});
