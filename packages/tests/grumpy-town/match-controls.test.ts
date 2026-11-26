import { describe, expect, it } from 'vitest';

import { TownMatchControls } from '../../../apps/grumpy-town/src/match/presentation/town-match-controls.ts';

describe('match input across a confirmation pause', () => {
    it('drops unconfirmed actions when a successor restores an older committed input position', () => {
        const controls = new TownMatchControls();
        expect(controls.sample({ x: 1, z: 0, dash: 1 }, 0, false).dash).toBe(1);
        controls.acceptKeyDown('KeyD', false, false);
        controls.rebase({ x: 1, z: 0, dash: 1 }, 0);
        expect(controls.acceptKeyDown('KeyD', true, false)).toBe(false);
        expect(controls.sample({ x: 0, z: 0, dash: 1 }, 0, false).dash).toBe(0);
        expect(controls.sample({ x: 0, z: 0, dash: 2 }, 0, false).dash).toBe(1);
    });
    it('discards paused presses without reusing a previously published dash identity', () => {
        const controls = new TownMatchControls();
        expect(controls.sample({ x: 1, z: 0, dash: 1 }, 0, false)).toEqual({ x: 1, z: 0, dash: 1 });
        expect(controls.sample({ x: 1, z: 0, dash: 1 }, 0, true)).toEqual({ x: 0, z: 0, dash: 1 });
        expect(controls.sample({ x: 1, z: 0, dash: 2 }, 0, true)).toEqual({ x: 0, z: 0, dash: 1 });
        expect(controls.sample({ x: 0, z: 0, dash: 2 }, 0, false).dash).toBe(1);
        expect(controls.sample({ x: 0, z: 0, dash: 3 }, 0, false).dash).toBe(2);
        expect(controls.sample({ x: 0, z: 0, dash: 3 }, 2, false).dash).toBe(2);
    });

    it('requires release and a fresh key press after a pause, including native auto-repeat', () => {
        const controls = new TownMatchControls();
        expect(controls.acceptKeyDown('KeyD', false, false)).toBe(true);
        controls.sample({ x: 1, z: 0, dash: 0 }, 0, true);
        expect(controls.acceptKeyDown('KeyD', true, false)).toBe(false);
        expect(controls.acceptKeyDown('KeyW', false, true)).toBe(false);
        expect(controls.acceptKeyDown('KeyW', true, false)).toBe(false);
        controls.releaseKey('KeyD');
        expect(controls.acceptKeyDown('KeyD', false, false)).toBe(true);
        expect(controls.acceptKeyDown('KeyD', true, false)).toBe(true);
        controls.clearKeys();
        expect(controls.acceptKeyDown('KeyD', true, false)).toBe(false);
        expect(controls.acceptKeyDown('Tab', false, true)).toBe(true);
    });
});
