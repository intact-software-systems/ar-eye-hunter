import { beforeEach, describe, expect, it } from 'vitest';
import {
    computePracticePlayerTick,
    computePracticeTick,
    createPracticePlayer,
    createPracticeState
} from '../../../apps/cca-2d/src/practice-rules.ts';
import { TownRoutes } from '../../../apps/cca-2d/src/town/routes.ts';

let routes: TownRoutes;
beforeEach(() => {
    routes = new TownRoutes();
});

describe('cutout practice actions', () => {
    it('advances independent player controls without advancing or copying their shared town', () => {
        const town = createPracticeState().town;
        const before = structuredClone(town);
        const first = createPracticePlayer();
        const second = { ...createPracticePlayer(), x: 3, z: -2 };
        const moving = computePracticePlayerTick({ player: first, town, controls: { x: 1, z: 0, dash: 1 }, seconds: 1 / 30 });
        const idle = computePracticePlayerTick({ player: second, town, controls: { x: 0, z: 0, dash: 0 }, seconds: 1 / 30 });
        expect(moving.player.x).toBeGreaterThan(first.x);
        expect(moving.dash).toBe(true);
        expect(idle.player.x).toBe(second.x);
        expect(idle.dash).toBe(false);
        expect(moving.player.pranks).toBe(1);
        expect(idle.player.pranks).toBe(0);
        expect(moving.player.elapsed).toBeCloseTo(1 / 30);
        expect(idle.player.elapsed).toBeCloseTo(1 / 30);
        expect(moving.player).not.toHaveProperty('town');
        expect(town).toEqual(before);
    });
    it('normalizes diagonal movement without changing the input state', () => {
        const start = createPracticeState();
        const straight = computePracticeTick(start, { x: 1, z: 0, dash: 0 }, { seconds: 1 / 60, routes });
        const diagonal = computePracticeTick(start, { x: 1, z: 1, dash: 0 }, { seconds: 1 / 60, routes });
        expect(Math.hypot(diagonal.x - start.x, diagonal.z - start.z)).toBeCloseTo(straight.x - start.x);
        expect(start.x).toBe(0);
    });
    it('drops one cloud at departure and consumes a dash edge only once', () => {
        let state = createPracticeState();
        state = computePracticeTick(state, { x: 1, z: 0, dash: 1 }, { seconds: 1 / 60, routes });
        expect(state.clouds).toHaveLength(1);
        expect(state.clouds[0].x).toBe(0);
        expect(state.pranks).toBe(1);
        expect(state.x).toBeGreaterThan(0.1);
        for (let tick = 0; tick < 300; tick++) {
            state = computePracticeTick(state, { x: 0, z: 0, dash: 1 }, { seconds: 1 / 60, routes });
        }
        expect(state.pranks).toBe(1);
        expect(state.clouds).toHaveLength(0);
    });
    it('does not queue a dash pressed during cooldown', () => {
        let state = computePracticeTick(createPracticeState(), { x: 1, z: 0, dash: 1 }, { seconds: 1 / 60, routes });
        state = computePracticeTick(state, { x: 0, z: 0, dash: 2 }, { seconds: 1 / 60, routes });
        for (let tick = 0; tick < 260; tick++) {
            state = computePracticeTick(state, { x: 0, z: 0, dash: 2 }, { seconds: 1 / 60, routes });
        }
        expect(state.pranks).toBe(1);
        expect(computePracticeTick(state, { x: 0, z: 0, dash: 3 }, { seconds: 1 / 60, routes }).pranks).toBe(2);
    });
    it('retains momentum on ice and recovers after leaving the patch', () => {
        let state = { ...createPracticeState(), x: 0, z: 1, vz: 3 };
        state = computePracticeTick(state, { x: 0, z: 0, dash: 0 }, { seconds: 1 / 60, routes });
        expect(state.slipping).toBe(true);
        expect(state.vz).toBeGreaterThan(2);
        expect(state.slips).toBe(1);
        state = { ...state, z: 6 };
        for (let tick = 0; tick < 60; tick++) {
            state = computePracticeTick(state, { x: 0, z: 0, dash: 0 }, { seconds: 1 / 60, routes });
        }
        expect(state.slipping).toBe(false);
        expect(Math.abs(state.vz)).toBeLessThan(0.01);
        expect(state.slips).toBe(1);
    });
    it('stops a dash at a stall instead of tunnelling through it', () => {
        let state = { ...createPracticeState(), x: 2.8, z: 3 };
        for (let tick = 0; tick < 20; tick++) {
            state = computePracticeTick(state, { x: 1, z: 0, dash: 1 }, { seconds: 1 / 60, routes });
        }
        expect(state.x).toBeLessThanOrEqual(3.13);
    });
});
