import { describe, expect, it } from 'vitest';

import { TownMatchPeerPresentation } from '../../../apps/cca-2d/src/match/match-peer-presentation.ts';
import { createTownMatch } from '../../../apps/cca-2d/src/match/town-match.ts';

describe('remote player presentation', () => {
    const match = createTownMatch('round', [{ id: 'bob', sessionId: 'bob-session', displayName: 'Bob' }]).right!;
    const player = { ...match.players[0], x: 0, z: -2, vx: 3, vz: 0 };
    const frame = {
        player, town: match.town, matchId: 'round', inputGeneration: 1,
        enabled: true, tick: 0, nowEpochMs: 1000
    };

    it('renders intermediate positions between sparse confirmations without changing match truth', () => {
        const presentation = new TownMatchPeerPresentation();
        presentation.advance(frame);
        const next = { ...frame, tick: 6, nowEpochMs: 1200, player: { ...player, x: 0.6, elapsed: 0.2 } };
        const first = presentation.advance(next);
        const second = presentation.advance({ ...next, nowEpochMs: 1250 });
        expect(first.x).toBeGreaterThanOrEqual(next.player.x - player.vx * 0.05 - 0.00001);
        expect(second.x).toBeCloseTo(next.player.x);
        expect(second.x).toBeGreaterThan(first.x);
        expect(next.player.x).toBe(0.6);
        expect(match.players[0].score).toBe(0);
    });

    it('settles at a received stop within 50 ms without predicting beyond it', () => {
        const presentation = new TownMatchPeerPresentation();
        presentation.advance(frame);
        const stopped = {
            ...frame, tick: 6, nowEpochMs: 1200,
            player: { ...player, x: 0.6, vx: 0, elapsed: 0.2 }
        };
        presentation.advance(stopped);
        expect(presentation.advance({ ...stopped, nowEpochMs: 1250 }).x).toBeCloseTo(0.6);
        expect(presentation.advance({ ...stopped, nowEpochMs: 1400 }).x).toBeCloseTo(0.6);
    });

    it('caps velocity extrapolation and holds that endpoint instead of snapping backwards during silence', () => {
        const presentation = new TownMatchPeerPresentation();
        presentation.advance(frame);
        const end = presentation.advance({ ...frame, nowEpochMs: 1250 });
        expect(end.x).toBeCloseTo(0.3);
        for (const nowEpochMs of [1300, 1400, 1500]) {
            expect(presentation.advance({ ...frame, nowEpochMs }).x).toBeCloseTo(end.x);
        }
    });

    it('snaps immediately to confirmed freezes, recovery and new authority or rounds', () => {
        for (const reset of [
            { enabled: false }, { inputGeneration: 2 }, { matchId: 'next' },
            { player: { ...player, frozenUntil: 10 } }
        ]) {
            const presentation = new TownMatchPeerPresentation();
            presentation.advance(frame);
            expect(presentation.advance({ ...frame, nowEpochMs: 1250 }).x).toBeGreaterThan(player.x);
            const stopped = presentation.advance({ ...frame, ...reset, nowEpochMs: 1251 });
            expect(stopped.x).toBe(player.x);
        }
    });

    it('does not extrapolate through the town boundary', () => {
        const presentation = new TownMatchPeerPresentation();
        const edge = { ...frame, player: { ...player, x: 23.9, z: -22, vx: 10 } };
        presentation.advance(edge);
        expect(presentation.advance({ ...edge, nowEpochMs: 1250 }).x).toBeLessThanOrEqual(24);
    });

    it('stops a predicted dash at a solid stall and drops history after a suspended frame', () => {
        const presentation = new TownMatchPeerPresentation();
        const stall = { ...frame, player: { ...player, x: 5, z: 1.4, vx: 0, vz: 10 } };
        presentation.advance(stall);
        expect(presentation.advance({ ...stall, nowEpochMs: 1250 }).z).toBeCloseTo(1.42);
        expect(presentation.advance({ ...stall, nowEpochMs: 2000 }).z).toBe(1.4);
    });
});
