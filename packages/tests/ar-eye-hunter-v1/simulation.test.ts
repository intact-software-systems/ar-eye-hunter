import { describe, expect, it } from 'vitest';

import {
    applyArenaEvent,
    createInitialArenaState,
    createInitialCombatState,
    createInitialPlayerState,
    resolveShot,
    stepLocalPlayer,
} from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';
import type {
    ArenaEvent,
    ShotIntent,
    Vec3Tuple,
} from '../../../apps/ar-eye-hunter-v1/src/game/types.ts';

describe('AR Eye Hunter simulation', () => {
    it('accelerates fast FPS movement and applies dash cooldowns', () => {
        const now = 1_000;
        const player = createInitialPlayerState(now);

        const next = stepLocalPlayer(player, {
            moveX: 0,
            moveZ: 1,
            sprint: true,
            dash: true,
            slide: false,
            jump: false,
            fire: false,
            altFire: false,
            overdrive: false,
            pause: false,
        }, 100, now);

        expect(next.position[2]).toBeGreaterThan(player.position[2]);
        expect(next.velocity[2]).toBeGreaterThan(10);
        expect(next.combat.dashReadyAtEpochMs).toBeGreaterThan(now);
        expect(next.combat.energy).toBeLessThan(player.combat.energy);
    });

    it('resolves target hits with score, combo, overdrive, and revision', () => {
        const now = 5_000;
        const state = createInitialArenaState(123, now);
        const target = state.targets[0];
        const origin: Vec3Tuple = [
            target.position[0],
            target.position[1],
            target.position[2] - 8,
        ];
        const shot: ShotIntent = {
            sessionId: 'alice',
            username: 'alice',
            color: '#00c2a8',
            origin,
            direction: [0, 0, 1],
            seq: 1,
            sentAtEpochMs: now,
        };

        const result = resolveShot(state, createInitialCombatState(), shot, now);

        expect(result.accepted.hit).toBe(true);
        expect(result.accepted.targetId).toBe(target.id);
        expect(result.combat.score).toBeGreaterThan(0);
        expect(result.combat.combo).toBe(1);
        expect(result.combat.overdrive).toBeGreaterThan(0);
        expect(result.state.revision).toBe(state.revision + 1);
    });

    it('keeps misses responsive without awarding score', () => {
        const now = 8_000;
        const state = createInitialArenaState(456, now);
        const shot: ShotIntent = {
            sessionId: 'alice',
            username: 'alice',
            color: '#00c2a8',
            origin: [0, 2, 0],
            direction: [0, 1, 0],
            seq: 1,
            sentAtEpochMs: now,
        };

        const result = resolveShot(state, createInitialCombatState(), shot, now);

        expect(result.accepted.hit).toBe(false);
        expect(result.combat.score).toBe(0);
        expect(result.state).toBe(state);
    });

    it('applies arena events to spawn and mutate targets', () => {
        const now = 10_000;
        const state = createInitialArenaState(789, now);
        const spawn: ArenaEvent = {
            id: 'event-1',
            kind: 'spawn-eye',
            position: [3, 4, 5],
            rarity: 'volatile',
            startsAtEpochMs: now,
            expiresAtEpochMs: now + 8_000,
            revision: state.revision + 1,
            source: 'ai',
        };

        const spawned = applyArenaEvent(state, spawn);
        const mutate: ArenaEvent = {
            id: 'event-2',
            kind: 'combo-bounty',
            targetId: spawned.targets[0].id,
            startsAtEpochMs: now + 100,
            expiresAtEpochMs: now + 9_000,
            revision: spawned.revision + 1,
            source: 'ai',
        };
        const mutated = applyArenaEvent(spawned, mutate);

        expect(spawned.targets.length).toBe(state.targets.length + 1);
        expect(spawned.activeEvent?.kind).toBe('spawn-eye');
        expect(mutated.targets[0].rarity).toBe('bounty');
        expect(mutated.events.map((event) => event.id)).toContain('event-2');
    });
});
