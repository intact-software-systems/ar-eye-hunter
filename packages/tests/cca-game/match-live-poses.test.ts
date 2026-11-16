import { describe, expect, it } from 'vitest';

import { TownMatchLivePoses } from '../../../apps/cca-2d/src/match/match-live-poses.ts';
import { TOWN_MATCH_BUILD, TOWN_MATCH_PROTOCOL, type TownMatchFrame } from '../../../apps/cca-2d/src/match/match-protocol.ts';
import { createTownMatch } from '../../../apps/cca-2d/src/match/town-match.ts';

const initial = createTownMatch('round', [
    { id: 'alice', sessionId: 'alice-session', displayName: 'Alice' },
    { id: 'bob', sessionId: 'bob-session', displayName: 'Bob' }
]).right!;
const match = { ...initial, phase: 'playing' as const, tick: 30 };
const frame: TownMatchFrame = {
    protocol: TOWN_MATCH_PROTOCOL,
    build: TOWN_MATCH_BUILD,
    roomRef: { applicationId: 'cca-2d', workspaceId: 'default', groupId: 'town' },
    epoch: 1,
    matchId: 'round',
    sequence: 10,
    action: {
        kind: 'poses',
        tick: 36,
        players: [
            { id: 'alice', x: 1, z: -2, vx: 3.6, vz: 0, elapsed: 1.2 },
            { id: 'bob', x: -1, z: -2, vx: 0, vz: 0, elapsed: 1.2 }
        ]
    }
};

describe('fresh host poses independent of checkpoint agreement', () => {
    it('shows a newer host pose without changing confirmed positions or scores', () => {
        const poses = new TownMatchLivePoses();
        expect(poses.accept({ frame, match, now: 1000, transport: 'rtc' })).toBe(true);
        const sample = poses.resolve(match, 1100)!;
        expect(sample.players[0].x).toBe(1);
        expect(sample.tick).toBe(36);
        expect(sample.transport).toBe('rtc');
        expect(match.tick).toBe(30);
        expect(match.players[0].x).toBe(initial.players[0].x);
        expect(match.players[0].score).toBe(0);
    });

    it('rejects duplicates and backwards poses across RTC and WS', () => {
        const poses = new TownMatchLivePoses();
        poses.accept({ frame, match, now: 1000, transport: 'rtc' });
        expect(poses.accept({ frame, match, now: 1100, transport: 'ws' })).toBe(false);
        expect(poses.accept({ frame: { ...frame, sequence: 9 }, match, now: 1100, transport: 'ws' })).toBe(false);
        expect(poses.resolve(match, 1251)).toBeUndefined();
    });

    it('rejects unknown seats, duplicates, old matches and excessive simulation lead', () => {
        const poses = new TownMatchLivePoses();
        if (frame.action.kind !== 'poses') {
            throw new Error('Pose fixture required');
        }
        for (
            const invalid of [
                { ...frame, matchId: 'old' },
                { ...frame, action: { ...frame.action, tick: 29 } },
                { ...frame, action: { ...frame.action, tick: 200 } },
                { ...frame, action: { ...frame.action, players: [frame.action.players[0], frame.action.players[0]] } },
                { ...frame, action: { ...frame.action, players: [{ ...frame.action.players[0], id: 'intruder' }, frame.action.players[1]] } }
            ]
        ) {
            expect(poses.accept({ frame: invalid, match, now: 1000, transport: 'ws' })).toBe(false);
        }
    });

    it('drops stale observations on silence, a terminal phase, new match or explicit authority reset', () => {
        const poses = new TownMatchLivePoses();
        poses.accept({ frame, match, now: 1000, transport: 'ws' });
        expect(poses.resolve(match, 1251)).toBeUndefined();
        expect(poses.resolve(match, 999)).toBeUndefined();
        expect(poses.resolve({ ...match, phase: 'finished' }, 1100)).toBeUndefined();
        expect(poses.resolve({ ...match, matchId: 'next' }, 1100)).toBeUndefined();
        expect(poses.resolve({ ...match, tick: 37 }, 1100)).toBeUndefined();
        poses.clear();
        expect(poses.resolve(match, 1100)).toBeUndefined();
        expect(poses.accept({ frame: { ...frame, sequence: 1 }, match, now: 1100, transport: 'local' })).toBe(true);
    });
});
