import { describe, expect, it } from 'vitest';

import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';

import { computeRelicTerminalPresentationKey } from '../../src/game/scene/neon/compute-relic-terminal-presentation-key.ts';

const binding: TournamentMatchBinding = {
    tournamentRef: { applicationId: 'relic-hunters', workspaceId: 'test', tournamentId: 'cup' },
    slot: 'semifinal-1',
    attemptId: 'attempt',
    roomRef: { applicationId: 'relic-hunters', workspaceId: 'test', groupId: 'room' },
    gameId: 'game',
    rulesId: 'relic-native-10-rounds-v1',
    principalIds: ['alice', 'bob']
};

describe('native terminal scene content', () => {
    it('keeps casual completed games, opening state and native active spectators live', () => {
        expect(computeRelicTerminalPresentationKey(undefined)).toBeUndefined();
        expect(computeRelicTerminalPresentationKey(snapshot(null))).toBeUndefined();
        expect(computeRelicTerminalPresentationKey(snapshot('playing'))).toBeUndefined();
    });

    it.each(['finished', 'cancelled'] as const)('idles only authoritative native %s and ignores timestamp-only polls', (status) => {
        const terminal = snapshot(status);
        expect(computeRelicTerminalPresentationKey(terminal)).toBeTypeOf('string');
        expect(computeRelicTerminalPresentationKey({ ...terminal, updatedAtEpochMs: 999 }))
            .toBe(computeRelicTerminalPresentationKey(terminal));
    });

    it('redraws changed terminal content and distinguishes a replacement native room', () => {
        const terminal = snapshot('finished');
        const key = computeRelicTerminalPresentationKey(terminal);
        expect(computeRelicTerminalPresentationKey({ ...terminal, map: [{ ...terminal.map[0], collapsed: true }] }))
            .not.toBe(key);
        expect(computeRelicTerminalPresentationKey({ ...terminal, gameId: 'next-game', roomId: 'next-room' }))
            .not.toBe(key);
        expect(computeRelicTerminalPresentationKey(snapshot('cancelled'))).not.toBe(key);
    });
});

function snapshot(status: 'playing' | 'finished' | 'cancelled' | null): RelicPublicSnapshot {
    return {
        tournament: status === null ? null : { binding, status },
        protocolVersion: 1,
        gameId: 'game',
        roomId: 'room',
        phase: 'finished',
        round: 6,
        maxRounds: 10,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
        roundTimeLimitMs: 180000,
        map: [{ id: 'exit', name: 'Exit', kind: 'exit', x: 0, z: 0, neighbors: [] }],
        relics: [],
        roomInvestigations: [],
        players: [],
        submittedPlayerIds: [],
        events: [],
        winnerIds: []
    };
}
