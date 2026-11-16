import { describe, expect, it } from 'vitest';

import { TownMatchPresentation } from '../../../apps/cca-2d/src/match/match-presentation.ts';
import { createPracticePlayer } from '../../../apps/cca-2d/src/practice-rules.ts';
import { createTownState } from '../../../apps/cca-2d/src/town/state.ts';

describe('local match presentation', () => {
    const town = createTownState();
    const player = { ...createPracticePlayer(), x: 0, z: -2 };
    const frame = {
        player, town, matchId: 'round', inputGeneration: 1, enabled: true,
        controls: { x: 1, z: 0, dash: 0 }, seconds: 1 / 60
    };

    it('shows movement and a single dash before confirmation without mutating match truth', () => {
        const presentation = new TownMatchPresentation();
        const moved = presentation.advance(frame);
        expect(moved.x).toBeGreaterThan(player.x);
        const dashed = presentation.advance({ ...frame, controls: { x: 1, z: 0, dash: 1 } });
        expect(dashed.vx).toBe(10);
        expect(dashed.clouds).toHaveLength(1);
        expect(presentation.advance({ ...frame, controls: { x: 1, z: 0, dash: 1 } }).clouds).toHaveLength(1);
        expect(player.x).toBe(0);
        expect(player.consumedDash).toBe(0);
        expect(player.clouds).toEqual([]);
    });

    it('bounds prediction during a delayed checkpoint and reconciles to a newer host position', () => {
        const presentation = new TownMatchPresentation();
        let shown = player;
        for (let tick = 0; tick < 120; tick++) {
            shown = presentation.advance(frame);
        }
        expect(shown.elapsed).toBeLessThanOrEqual(0.3);
        expect(presentation.advance(frame).x).toBe(shown.x);
        const confirmed = { ...player, x: -4, elapsed: 0.4 };
        const reconciled = presentation.advance({ ...frame, player: confirmed });
        expect(reconciled.x).toBeGreaterThan(-4);
        expect(reconciled.x).toBeLessThan(-3.9);
    });

    it('replays only the presentation interval newer than a confirmation, with no duplicate confirmed dash', () => {
        const presentation = new TownMatchPresentation();
        const controls = { x: 1, z: 0, dash: 1 };
        presentation.advance({ ...frame, controls });
        presentation.advance({ ...frame, controls });
        const confirmed = {
            ...player, x: 0.1, elapsed: 1 / 60, consumedDash: 1, cooldown: 3,
            vx: 10, dashTime: 0.2, pranks: 1,
            clouds: [{ id: 1, x: 0, z: -2, age: 0 }]
        };
        const shown = presentation.advance({ ...frame, controls, player: confirmed });
        expect(shown.clouds).toHaveLength(1);
        expect(shown.pranks).toBe(1);
        expect(shown.elapsed).toBeCloseTo(3 / 60);
    });

    it('immediately accepts freezes and never predicts their release or shared interactions', () => {
        const presentation = new TownMatchPresentation();
        presentation.advance(frame);
        const frozen = { ...player, frozenUntil: 0.01 };
        for (let tick = 0; tick < 30; tick++) {
            expect(presentation.advance({ ...frame, player: frozen })).toEqual(frozen);
        }
    });

    it('discards speculative movement on recovery, authority changes and new rounds', () => {
        for (const reset of [{ enabled: false }, { inputGeneration: 2 }, { matchId: 'rematch' }]) {
            const presentation = new TownMatchPresentation();
            presentation.advance({ ...frame, controls: { x: 1, z: 0, dash: 1 } });
            const shown = presentation.advance({
                ...frame, ...reset, controls: { x: 0, z: 0, dash: 0 }, seconds: 0
            });
            expect(shown).toEqual(player);
        }
    });
});
