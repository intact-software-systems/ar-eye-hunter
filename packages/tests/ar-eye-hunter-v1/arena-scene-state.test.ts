import {
    describe,
    expect,
    it
} from 'vitest';

import { ArenaSceneState } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-scene-state.ts';
import {
    createInitialArenaState,
    spawnWeaponPickup,
    toArenaSnapshot
} from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';
import type { ArenaSnapshot } from '../../../apps/ar-eye-hunter-v1/src/game/types.ts';

const initial = createInitialArenaState(44, 1_000);
const peer: ArenaSceneState.Authority = { roomId: 'arena', sessionId: 'host', epoch: 1, local: false, fresh: true, freshUntilEpochMs: 120_000 };
const director: ArenaSceneState.Authority = { ...peer, local: true };

function observation(snapshot: ArenaSnapshot | undefined, authority = peer): ArenaSceneState.Observation {
    return { snapshot, authority };
}

function activeSnapshot(): ArenaSnapshot {
    return {
        ...toArenaSnapshot(initial, 'arena', 2_000),
        match: {
            matchId: 'match',
            status: 'active',
            durationMs: 60_000,
            directorSessionId: 'host',
            startedAtEpochMs: 2_000,
            endsAtEpochMs: 62_000,
            baseline: {}
        }
    };
}

describe('scene authority and prediction', () => {
    it('reconciles an accepted match despite a higher predicted revision and never completes it as a peer', () => {
        const scene = new ArenaSceneState(initial);
        scene.reconcile(observation(undefined));
        scene.setPrediction({ ...initial, revision: 100 });
        scene.reconcile(observation(activeSnapshot()));
        scene.advance(100_000);
        expect(scene.getSimulation().match?.status).toBe('active');
        expect(scene.getSimulation().revision).toBe(1);
        expect(scene.canPublish(62_001)).toBe(false);
    });

    it('applies same-revision accepted players without resetting director pickup scheduling', () => {
        const scene = new ArenaSceneState(initial);
        const snapshot = toArenaSnapshot(initial, 'arena', 1_000);
        scene.reconcile(observation(snapshot, director));
        const scheduled = scene.getSimulation().nextPickupAtEpochMs;
        const player = {
            sessionId: 'guest',
            username: 'bob',
            color: '#fff',
            score: 0,
            position: [1, 2, 3] as const,
            rotation: [0, 0, 0] as const,
            vitals: { health: 100, maxHealth: 100, kills: 0, deaths: 0 },
            loadout: { weaponKind: 'pulse-rifle' as const, tier: 1 },
            seq: 1,
            updatedAtEpochMs: 2_000
        };
        scene.reconcile(observation({ ...snapshot, sentAtEpochMs: 2_000, players: [player] }, director));
        expect(scene.getSimulation().players.map((value) => value.username)).toEqual(['bob']);
        expect(scene.getSimulation().nextPickupAtEpochMs).toBe(scheduled);
    });

    it('does not apply snapshot-represented events or local publication echoes twice', () => {
        const dropped = spawnWeaponPickup(initial, 2_000);
        const snapshot = toArenaSnapshot(dropped, 'arena', 2_000);
        const scene = new ArenaSceneState(initial);
        scene.reconcile(observation(snapshot, director));
        for (const event of snapshot.events) {
            scene.applyEvent(event);
        }
        expect(scene.getSimulation().revision).toBe(snapshot.revision);
        expect(scene.getSimulation().pickups).toHaveLength(1);
        const published = toArenaSnapshot(scene.getSimulation(), 'arena', 4_000);
        scene.setPublishedSnapshot(published);
        const scheduled = scene.getSimulation().nextPickupAtEpochMs;
        scene.reconcile(observation(published, director));
        expect(scene.getSimulation().nextPickupAtEpochMs).toBe(scheduled);
    });

    it('rebases a newly appointed director on canonical state instead of speculative history', () => {
        const scene = new ArenaSceneState(initial);
        const snapshot = activeSnapshot();
        scene.reconcile(observation(snapshot));
        scene.setPrediction({ ...scene.getSimulation(), revision: 100, match: undefined });
        scene.reconcile(observation(snapshot, { ...director, sessionId: 'guest', epoch: 2 }));
        scene.advance(62_001);
        expect(scene.getSimulation().match?.status).toBe('complete');
        expect(scene.getSimulation().revision).toBeLessThan(100);
    });

    it('keeps a selected room frozen without fresh authority even when local prediction changes', () => {
        const scene = new ArenaSceneState(initial);
        scene.reconcile(observation(activeSnapshot(), { ...director, fresh: false }));
        scene.advance(62_001);
        expect(scene.getSimulation().match?.status).toBe('active');
        expect(scene.canPublish(62_001)).toBe(false);
    });

    it('stops shared decisions when the observed director heartbeat expires between renders', () => {
        const scene = new ArenaSceneState(initial);
        scene.reconcile(observation(activeSnapshot(), { ...director, freshUntilEpochMs: 3_000 }));
        scene.advance(62_001);
        expect(scene.getSimulation().match?.status).toBe('active');
    });

    it('runs an isolated preview only when there is no selected room', () => {
        const scene = new ArenaSceneState(initial);
        scene.reconcile(
            observation(undefined, { roomId: undefined, sessionId: undefined, epoch: undefined, local: false, fresh: false, freshUntilEpochMs: 0 })
        );
        scene.advance(60_000);
        expect(scene.getSimulation().wave.phase).toBe('active');
        expect(scene.canPublish(62_001)).toBe(false);
    });
});
