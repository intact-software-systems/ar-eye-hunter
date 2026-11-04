import { createInitialArenaState, spawnWeaponPickup } from '@ar-eye-hunter/simulation.ts';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { createRallarMotionBuffer } from '@shared/rallar-motion/mod.ts';
import { afterEach, expect, it, vi } from 'vitest';
import type { PlayerPose, RemotePlayer } from '../../../apps/ar-eye-hunter-v1/src/game/arena-contracts.ts';
import { syncRemoteAvatars } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-peer-view.ts';
import type { PickupAvatar, RemoteAvatar, TargetAvatar } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-scene-contracts.ts';
import { syncPickupAvatars, syncTargetAvatars } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-target-view.ts';

/** Only raster drawing is replaced; Babylon owns real mesh/material/texture lifetimes. */
class LabelCanvas {
    width = 1;
    height = 1;
    getContext() {
        return { clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn() };
    }
    remove(): void {}
}

afterEach(() => vi.unstubAllGlobals());

it.each(['targets', 'pickups', 'peers'] as const)('releases %s resources across repeated spawn and removal', (kind) => {
    vi.stubGlobal('OffscreenCanvas', LabelCanvas);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const runtime = {
        scene,
        arenaState: spawnWeaponPickup(createInitialArenaState(44, 1000), 1000),
        targets: new Map<string, TargetAvatar>(),
        pickups: new Map<string, PickupAvatar>(),
        sentPickupIds: new Set<string>(),
        avatars: new Map<string, RemoteAvatar>(),
        motionBuffer: createRallarMotionBuffer<PlayerPose>({ interpolationDelayMs: 75, maxExtrapolationMs: 130 }),
        motionSampleKeys: new Map<string, string>(),
        clock: { nowEpochMs: () => 1000, nowMonotonicMs: () => 1000 }
    };
    const populated = runtime.arenaState;
    const remote: RemotePlayer = {
        pose: { sessionId: 'peer', username: 'Peer', color: '#00ff00', position: [0, 0, 0], rotation: [0, 0, 0], score: 0, seq: 1, sentAtEpochMs: 1000 },
        lastSeenEpochMs: 1000
    };
    const baseline = resources(scene);
    try {
        for (let cycle = 0; cycle < 5; cycle++) {
            runtime.arenaState = populated;
            if (kind === 'targets') {
                syncTargetAvatars(runtime, 1000);
            }
            if (kind === 'pickups') {
                syncPickupAvatars(runtime, 1000);
            }
            if (kind === 'peers') {
                syncRemoteAvatars(runtime, new Map([['peer', remote]]));
            }
            expect(scene.materials.length).toBeGreaterThan(baseline.materials);
            runtime.arenaState = { ...populated, targets: [], pickups: [] };
            if (kind === 'targets') {
                syncTargetAvatars(runtime, 1000);
            }
            if (kind === 'pickups') {
                syncPickupAvatars(runtime, 1000);
            }
            if (kind === 'peers') {
                syncRemoteAvatars(runtime, new Map());
            }
            expect(resources(scene)).toEqual(baseline);
        }
    }
    finally {
        scene.dispose();
        engine.dispose();
    }
});

function resources(scene: Scene) {
    return { meshes: scene.meshes.length, nodes: scene.transformNodes.length, materials: scene.materials.length, textures: scene.textures.length };
}
