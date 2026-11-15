import {
    describe,
    expect,
    it
} from 'vitest';
import {
    computePracticeTick,
    createPracticeState,
    type PracticeState
} from '../../../apps/cca-2d/src/practice-rules.ts';

function advance(state: PracticeState, seconds: number): PracticeState {
    for (let tick = 0; tick < seconds * 60; tick++) {
        state = computePracticeTick(state, { x: 0, z: 0, dash: state.consumedDash }, 1 / 60);
    }
    return state;
}

describe('grumpy town pranks', () => {
    it('only a dash tips a stall, with one bounded spill per stocked display', () => {
        const start = { ...createPracticeState(), x: 5, z: 1.35 };
        const walked = computePracticeTick(start, { x: 0, z: 1, dash: 0 }, 1 / 60);
        expect(walked.town.spills).toBe(0);
        let dashed = computePracticeTick(start, { x: 0, z: 1, dash: 1 }, 1 / 60);
        expect(dashed.town.spills).toBe(1);
        expect(dashed.town.fruit).toHaveLength(6);
        expect(start.town.fruit).toHaveLength(0);
        dashed = advance(dashed, 0.3);
        expect(dashed.town.spills).toBe(1);
        expect(dashed.town.npcs[0].mode).toBe('cleaning');
    });
    it('scattered fruit causes slipping off the ice, and the owner eventually cleans and restocks', () => {
        let state = computePracticeTick({ ...createPracticeState(), x: 5, z: 1.35 }, { x: 0, z: 1, dash: 1 }, 1 / 60);
        const fruit = state.town.fruit[0];
        state = computePracticeTick({ ...state, x: fruit.x, z: fruit.z, vx: 3, dashTime: 0 }, { x: 0, z: 0, dash: 1 }, 1 / 60);
        expect(state.slipping).toBe(true);
        state = advance({ ...state, x: 0, z: -15 }, 35);
        expect(state.town.fruit).toHaveLength(0);
        expect(state.town.shops[0].tipped).toBe(false);
        expect(state.town.npcs[0].mode).toBe('watching');
        expect(state.town.cleaned).toBeGreaterThan(0);
    });
    it('a tidy owner aims at a fixed spot; escaping dodges the three-point penalty', () => {
        const initial = createPracticeState();
        const start = computePracticeTick({ ...initial, x: 5, z: 0, town: { ...initial.town, score: 20 } }, { x: 1, z: 0, dash: 1 }, 1 / 60);
        const warned = advance({ ...start, vx: 0, vz: 0, dashTime: 0 }, 0.9);
        expect(warned.town.npcs[0].mode).toBe('warning');
        const hit = advance(warned, 1);
        expect(hit.town.score).toBe(17);
        expect(hit.shieldUntil).toBeGreaterThan(hit.elapsed);
        const escaped = advance({ ...warned, x: 0, z: -10 }, 1);
        expect(escaped.town.score).toBe(20);
    });
    it('powder pickup loads one dash, makes an owner dizzy and leaves a temporary puke patch', () => {
        let state = computePracticeTick({ ...createPracticeState(), x: -9, z: -11.5 }, { x: 0, z: 0, dash: 0 }, 1 / 60);
        expect(state.power).toBe('powder');
        state = computePracticeTick({ ...state, x: -9, z: -11 }, { x: 1, z: 0, dash: 1 }, 1 / 60);
        expect(state.power).toBe('fart');
        expect(state.town.patches.some((patch) => patch.kind === 'powder')).toBe(true);
        expect(state.town.npcs[2].dizzyUntil).toBeGreaterThan(state.elapsed);
        state = advance({ ...state, x: 0, z: -15 }, 3);
        expect(state.town.patches.some((patch) => patch.kind === 'puke')).toBe(true);
        state = advance(state, 20);
        expect(state.town.patches).toHaveLength(0);
    });
    it('zapper pickup shrinks characters in front and wears off', () => {
        let state = computePracticeTick({ ...createPracticeState(), x: 9, z: -11.5 }, { x: 0, z: 0, dash: 0 }, 1 / 60);
        expect(state.power).toBe('zapper');
        state = computePracticeTick(state, { x: 0, z: 1, dash: 1 }, 1 / 60);
        expect(state.town.npcs[3].miniUntil).toBeGreaterThan(state.elapsed);
        expect(state.power).toBe('fart');
        state = advance({ ...state, x: 0, z: -15 }, 8);
        expect(state.town.npcs[3].miniUntil).toBeLessThan(state.elapsed);
    });
    it('a fart upsets a nearby owner without requiring a damaged stall', () => {
        const state = computePracticeTick({ ...createPracticeState(), x: 5, z: 0 }, { x: 1, z: 0, dash: 1 }, 1 / 60);
        expect(state.town.spills).toBe(0);
        expect(state.town.npcs[0].mode).toBe('chasing');
        expect(state.town.npcs[1].mode).toBe('chasing');
    });
    it('powder also affects the player, slows movement and recovers without repeated sickness', () => {
        let state = computePracticeTick({ ...createPracticeState(), power: 'powder' }, { x: 1, z: 0, dash: 1 }, 1 / 60);
        const cloud = state.town.patches[0];
        state = advance({ ...state, x: cloud.x, z: cloud.z, vx: 0, vz: 0, dashTime: 0 }, 0.6);
        expect(state.dizzyUntil).toBeGreaterThan(state.elapsed);
        state = advance(state, 3);
        expect(state.town.patches.filter((patch) => patch.kind === 'puke')).toHaveLength(1);
        state = advance(state, 15);
        expect(state.dizzyUntil).toBeLessThan(state.elapsed);
        expect(state.town.patches.filter((patch) => patch.kind === 'powder' || patch.kind === 'puke')).toHaveLength(0);
    });
    it('aim-assisted zaps visibly connect to each character they shrink', () => {
        const state = computePracticeTick({ ...createPracticeState(), x: 1, z: -4, power: 'zapper' }, { x: 0, z: 1, dash: 1 }, 1 / 60);
        const target = state.town.npcs[0];
        expect(target.miniUntil).toBeGreaterThan(state.elapsed);
        expect(state.town.zaps.some((zap) => Math.hypot(zap.target.x - target.x, zap.target.z - target.z) < 0.1)).toBe(true);
    });
});
