import { describe, expect, it } from 'vitest';

import {
    FALLBACK_ARENA_LAYOUT,
    blocksShot,
    validateArenaLayoutSpec,
} from '../../../apps/ar-eye-hunter-v1/src/game/arenaLayout.ts';
import {
    applyArenaEvent,
    createInitialArenaState,
    createInitialCombatState,
    createInitialLoadoutState,
    createInitialVitalsState,
    createInitialPlayerState,
    resolvePickupIntent,
    resolvePlayerHitIntent,
    resolveShot,
    spawnWeaponPickup,
    stepArenaDirectorState,
    stepLocalPlayer,
    upsertPlayerPose,
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

    it('uses the doubled arena bounds for FPS movement', () => {
        const now = 20_000;
        const player = {
            ...createInitialPlayerState(now),
            position: [39.5, 1.72, 39.5] as Vec3Tuple,
            yaw: Math.PI / 4,
        };

        const next = stepLocalPlayer(player, {
            moveX: 1,
            moveZ: 1,
            sprint: true,
            dash: true,
            slide: false,
            jump: false,
            fire: false,
            altFire: false,
            overdrive: false,
            pause: false,
        }, 500, now, 40);

        expect(Math.abs(next.position[0])).toBeLessThanOrEqual(40);
        expect(Math.abs(next.position[2])).toBeLessThanOrEqual(40);
    });

    it('validates PvP hits, eliminations, kill/death scoring, and respawn', () => {
        const now = 30_000;
        const base = createInitialArenaState(999, now);
        const attackerVitals = createInitialVitalsState();
        const targetVitals = createInitialVitalsState();
        const stateWithPlayers = upsertPlayerPose(
            upsertPlayerPose(base, {
                sessionId: 'attacker',
                username: 'attacker',
                color: '#00e5ff',
                position: [0, 1.72, 0],
                rotation: [0, 0, 0],
                vitals: attackerVitals,
                loadout: { ...createInitialLoadoutState(), weaponKind: 'rail-lance', tier: 3 },
                seq: 1,
                sentAtEpochMs: now,
            }, now),
            {
                sessionId: 'target',
                username: 'target',
                color: '#ff3df2',
                position: [0, 1.72, 9],
                rotation: [0, Math.PI, 0],
                vitals: targetVitals,
                loadout: createInitialLoadoutState(),
                seq: 1,
                sentAtEpochMs: now,
            },
            now,
        );

        const first = resolvePlayerHitIntent(stateWithPlayers, {
            shot: {
                sessionId: 'attacker',
                username: 'attacker',
                color: '#00e5ff',
                origin: [0, 1.72, 0],
                direction: [0, 0, 1],
                weaponKind: 'rail-lance',
                seq: 1,
                sentAtEpochMs: now,
            },
            targetSessionId: 'target',
            predictedImpact: [0, 1.72, 9],
            sentAtEpochMs: now,
        }, now);
        expect(first.accepted).toBe(true);
        if (!first.accepted) {
            return;
        }
        expect(first.acceptedHit.target.vitals.health).toBeLessThan(100);
        expect(first.acceptedHit.eliminated).toBe(false);

        const second = resolvePlayerHitIntent(first.state, {
            shot: {
                sessionId: 'attacker',
                username: 'attacker',
                color: '#00e5ff',
                origin: [0, 1.72, 0],
                direction: [0, 0, 1],
                weaponKind: 'rail-lance',
                overdrive: true,
                seq: 2,
                sentAtEpochMs: now + 200,
            },
            targetSessionId: 'target',
            predictedImpact: [0, 1.72, 9],
            sentAtEpochMs: now + 200,
        }, now + 200);

        expect(second.accepted).toBe(true);
        if (!second.accepted) {
            return;
        }
        expect(second.acceptedHit.eliminated).toBe(true);
        expect(second.acceptedHit.target.vitals.deaths).toBe(1);
        expect(second.acceptedHit.attacker.vitals.kills).toBe(1);

        const blockedWhileDead = resolvePlayerHitIntent(second.state, {
            shot: {
                sessionId: 'attacker',
                username: 'attacker',
                color: '#00e5ff',
                origin: [0, 1.72, 0],
                direction: [0, 0, 1],
                weaponKind: 'rail-lance',
                seq: 3,
                sentAtEpochMs: now + 300,
            },
            targetSessionId: 'target',
            predictedImpact: [0, 1.72, 9],
            sentAtEpochMs: now + 300,
        }, now + 300);
        expect(blockedWhileDead.accepted).toBe(false);

        const respawned = stepArenaDirectorState(second.state, now + 2_200);
        const target = respawned.players.find((player) => player.sessionId === 'target');
        expect(target?.vitals.health).toBe(target?.vitals.maxHealth);
        expect(target?.vitals.respawnedAtEpochMs).toBeGreaterThan(now);
    });

    it('spawns, expires, and accepts automatic weapon pickups with replacement loadouts', () => {
        const now = 40_000;
        const withPickup = spawnWeaponPickup(createInitialArenaState(44, now), now, 'audit-pea-shooter');
        const pickup = withPickup.pickups[0];
        const withPlayer = upsertPlayerPose(withPickup, {
            sessionId: 'picker',
            username: 'picker',
            color: '#49ff86',
            position: pickup.position,
            rotation: [0, 0, 0],
            vitals: createInitialVitalsState(),
            loadout: { ...createInitialLoadoutState(), weaponKind: 'rail-lance', tier: 3 },
            seq: 1,
            sentAtEpochMs: now,
        }, now);

        const accepted = resolvePickupIntent(withPlayer, {
            pickupId: pickup.id,
            sessionId: 'picker',
            position: pickup.position,
            seq: 1,
            sentAtEpochMs: now + 50,
        }, now + 50);

        expect(accepted.accepted).toBe(true);
        if (!accepted.accepted) {
            return;
        }
        expect(accepted.acceptedPickup.player.loadout.weaponKind).toBe('audit-pea-shooter');
        expect(accepted.acceptedPickup.pickup.pickedBySessionId).toBe('picker');

        const duplicate = resolvePickupIntent(accepted.state, {
            pickupId: pickup.id,
            sessionId: 'picker',
            position: pickup.position,
            seq: 2,
            sentAtEpochMs: now + 60,
        }, now + 60);
        expect(duplicate.accepted).toBe(false);
    });

    it('validates AI-style arena layouts and blocks shots against cover props', () => {
        const validation = validateArenaLayoutSpec({
            id: 'oversized-ai-box',
            revision: 2,
            name: 'AI tried to rent a continent',
            halfSize: 500,
            theme: {
                base: '#000000',
                grid: '#49ff86',
                accent: '#00e5ff',
                warning: '#ff3df2',
                reward: '#ffe66d',
            },
            spawnPoints: [
                [-45, 1.72, -45],
                [45, 1.72, 45],
            ],
            pickupAnchors: [
                { id: 'a', position: [0, 1, 0] },
                { id: 'b', position: [10, 1, 0] },
                { id: 'c', position: [-10, 1, 0] },
            ],
            props: [{
                id: 'cover',
                kind: 'cover',
                position: [0, 1, 4],
                size: [4, 3, 2],
                blocksShots: true,
            }],
            signs: [],
        });

        expect(validation.ok).toBe(true);
        expect(validation.layout.halfSize).toBe(52);
        expect(validation.layout.spawnPoints[0][0]).toBeGreaterThanOrEqual(-52);
        expect(blocksShot(validation.layout, [0, 1.72, 0], [0, 1.72, 8])).toBe(true);

        const fallback = validateArenaLayoutSpec({
            halfSize: 40,
            spawnPoints: [[0, 1.72, 0]],
            pickupAnchors: [],
        });
        expect(fallback.ok).toBe(false);
        expect(fallback.layout.id).toBe(FALLBACK_ARENA_LAYOUT.id);
    });

    it('materializes accepted AI weapon-drop events as bounded pickups', () => {
        const now = 50_000;
        const state = createInitialArenaState(77, now);
        const dropped = applyArenaEvent(state, {
            id: 'ai-drop-1',
            kind: 'weapon-drop',
            position: [6, 1.05, 6],
            startsAtEpochMs: now,
            expiresAtEpochMs: now + 8_000,
            revision: state.revision + 1,
            source: 'ai',
            headline: 'Mandatory fun crate inbound',
        });

        expect(dropped.pickups).toHaveLength(1);
        expect(dropped.pickups[0].id).toContain('ai-drop-1');
        expect(dropped.pickups[0].position).toEqual([6, 1.05, 6]);
    });
});
