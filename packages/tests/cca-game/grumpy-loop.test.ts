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
import { createCleanCoat } from '../../../apps/cca-2d/src/town/soiling.ts';

function advance(state: PracticeState, seconds: number): PracticeState {
    for (let tick = 0; tick < seconds * 60; tick++) {
        state = computePracticeTick(state, { x: 0, z: 0, dash: state.consumedDash }, 1 / 60);
    }
    return state;
}

describe('grumpy town chase and rescue loop', () => {
    it('a fresh spill buys safety from its owner but a tidy neighbour witnesses it', () => {
        const state = computePracticeTick({ ...createPracticeState(), x: 5, z: 1.35 }, { x: 0, z: 1, dash: 1 }, 1 / 60);
        expect(state.town.npcs[0].mode).toBe('cleaning');
        expect(state.town.npcs[1].mode).toBe('chasing');
        expect(state.town.score).toBe(10);
        expect(state.town.heat).toBe(1);
        const later = advance({ ...state, x: 20, z: -20, vx: 0, vz: 0, dashTime: 0 }, 20);
        expect(later.town.npcs[0].mode).toBe('watching');
        expect(later.town.fruit).toHaveLength(0);
    });
    it('repeated hits on an already tipped stall do not farm points', () => {
        let state = computePracticeTick({ ...createPracticeState(), x: 5, z: 1.35 }, { x: 0, z: 1, dash: 1 }, 1 / 60);
        state = computePracticeTick({ ...state, cooldown: 0 }, { x: 0, z: 1, dash: 2 }, 1 / 60);
        expect(state.town.score).toBe(10);
    });
    it('watching does not punish harmless walking, and a chase expires out of sight', () => {
        const walking = advance({ ...createPracticeState(), x: 5, z: 0 }, 5);
        expect(walking.town.npcs.every((npc) => npc.mode === 'watching')).toBe(true);
        const start = computePracticeTick(walking, { x: 1, z: 0, dash: 1 }, 1 / 60);
        const escaped = advance({ ...start, x: 22, z: -22, vx: 0, vz: 0, dashTime: 0 }, 12);
        expect(escaped.town.npcs.every((npc) => npc.mode === 'watching')).toBe(true);
    });
    it('freezing blocks movement and dash, then automatically releases with protection', () => {
        const initial = createPracticeState();
        const frozen = { ...initial, frozenUntil: 6, town: { ...initial.town, companion: { ...initial.town.companion, x: -22, z: 22, frozenUntil: 20 } } };
        const held = computePracticeTick(frozen, { x: 1, z: 0, dash: 1 }, 1 / 60);
        expect(held.x).toBe(0);
        expect(held.pranks).toBe(0);
        const thawed = advance(held, 6.2);
        expect(thawed.frozenUntil).toBe(0);
        expect(thawed.shieldUntil).toBeGreaterThan(thawed.elapsed);
    });
    it('standing beside a frozen companion rescues once without a separate action', () => {
        const initial = createPracticeState();
        const state = { ...initial, town: { ...initial.town, companion: { ...initial.town.companion, x: 0.5, z: -2, frozenUntil: 6 } } };
        const rescued = advance(state, 1.2);
        expect(rescued.town.companion.frozenUntil).toBe(0);
        expect(rescued.town.rescues).toBe(1);
        expect(advance(rescued, 2).town.rescues).toBe(1);
    });
    it('dashing into the fountain creates a bounded spray and a repair job', () => {
        const state = computePracticeTick({ ...createPracticeState(), x: 0, z: 6.35 }, { x: 0, z: 1, dash: 1 }, 1 / 60);
        expect(state.town.fountain.broken).toBe(true);
        expect(state.town.score).toBe(10);
        expect(state.town.npcs[0].mode).toBe('cleaning');
        const repaired = advance({ ...state, x: 22, z: -22, vx: 0, vz: 0, dashTime: 0 }, 15);
        expect(repaired.town.fountain.broken).toBe(false);
    });
    it('the parcel cart rolls, stops within its route and is eventually retrieved', () => {
        const state = computePracticeTick({ ...createPracticeState(), x: -3, z: -7.9 }, { x: 0, z: 1, dash: 1 }, 1 / 60);
        expect(state.town.cart.loose).toBe(true);
        const moving = advance({ ...state, x: 22, z: -22, vx: 0, vz: 0, dashTime: 0 }, 1);
        expect(moving.town.cart.x).toBeGreaterThan(state.town.cart.x);
        const restored = advance(moving, 15);
        expect(restored.town.cart.loose).toBe(false);
        expect(restored.town.cart.x).toBe(-3);
    });
});

describe('raid fairness', () => {
    it('a warned shot can be dodged, freezes on a hit and does not remove points', () => {
        const initial = createPracticeState();
        const state: PracticeState = {
            ...initial,
            town: {
                ...initial.town,
                score: 20,
                companion: { ...initial.town.companion, x: -20, z: -20 },
                raid: {
                    ...initial.town.raid,
                    phase: 'active',
                    until: 20,
                    guards: [{ ...createCleanCoat(), id: 0, x: 0, z: -4, mode: 'patrol', target: 'player', aim: { x: 0, z: -2 }, until: 0 }]
                }
            }
        };
        const warned = advance(state, 0.1);
        expect(warned.town.raid.guards[0].mode).toBe('warning');
        const hit = advance(warned, 1);
        expect(hit.frozenUntil).toBeGreaterThan(hit.elapsed);
        expect(hit.town.score).toBe(20);
        expect(hit.town.zaps).toHaveLength(1);
        const dodged = advance({ ...warned, x: 3 }, 1);
        expect(dodged.frozenUntil).toBe(0);
    });
    it('a nearby companion thaws the player before the automatic timeout', () => {
        const initial = createPracticeState();
        const state = { ...initial, frozenUntil: 6, town: { ...initial.town, companion: { ...initial.town.companion, x: 0.5, z: -2 } } };
        const rescued = advance(state, 1.2);
        expect(rescued.frozenUntil).toBe(0);
        expect(rescued.shieldUntil).toBeGreaterThan(rescued.elapsed);
        expect(rescued.town.score).toBe(0);
    });
    it('a stall blocks witness and zap lines, and recently repaired props cannot farm points', () => {
        const initial = createPracticeState();
        const hidden = computePracticeTick({ ...initial, x: 5, z: 5, power: 'zapper' }, { x: 0, z: -1, dash: 1 }, 1 / 60);
        expect(hidden.town.npcs[0].mode).toBe('watching');
        expect(hidden.town.npcs[0].miniUntil).toBe(0);
        const protectedReward = { ...initial, x: 0, z: 6.35, town: { ...initial.town, fountain: { ...initial.town.fountain, rewardAt: 30 } } };
        const repeated = computePracticeTick(protectedReward, { x: 0, z: 1, dash: 1 }, 1 / 60);
        expect(repeated.town.fountain.broken).toBe(true);
        expect(repeated.town.score).toBe(0);
    });
});

describe('companion routes', () => {
    it('gets around a stall instead of oscillating at its corner and can rescue behind it', () => {
        const initial = createPracticeState();
        const arrived = advance({ ...initial, x: 8.5, z: 7.5 }, 12);
        expect(Math.hypot(arrived.town.companion.x - 6, arrived.town.companion.z - 6)).toBeLessThan(0.4);
        const rescued = advance({ ...arrived, frozenUntil: arrived.elapsed + 6 }, 3);
        expect(rescued.frozenUntil).toBe(0);
        expect(rescued.shieldUntil).toBeGreaterThan(rescued.elapsed);
    });
});
