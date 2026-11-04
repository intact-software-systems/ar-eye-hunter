import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';

import { type RelicSceneRuntime } from './relic-scene-runtime.ts';
import { clamp, smoothstep } from './relic-scene-space.ts';

interface SpawnPulseEffectInput {
    readonly runtime: RelicSceneRuntime;
    readonly id: string;
    readonly position: Vector3;
    readonly material: PBRMaterial;
    readonly durationMs: number;
    readonly maxScale: number;
}

interface SpawnBurstEffectInput {
    readonly runtime: RelicSceneRuntime;
    readonly id: string;
    readonly position: Vector3;
    readonly material: PBRMaterial;
    readonly durationMs: number;
}

interface SpawnBeamEffectInput {
    readonly runtime: RelicSceneRuntime;
    readonly from: Vector3;
    readonly to: Vector3;
    readonly material: PBRMaterial;
    readonly durationMs: number;
}

export interface SceneEffect {
    id: string;
    startedAtMs: number;
    durationMs: number;
    meshes: Mesh[];
    update(progress: number): void;
    dispose(): void;
}

export function updateSceneEffects(runtime: RelicSceneRuntime): void {
    const now = performance.now();
    for (let index = runtime.effects.length - 1; index >= 0; index -= 1) {
        const effect = runtime.effects[index];
        const progress = clamp((now - effect.startedAtMs) / Math.max(1, effect.durationMs), 0, 1);
        effect.update(progress);
        if (progress >= 1) {
            effect.dispose();
            runtime.effects.splice(index, 1);
        }
    }
}

export function spawnPulseEffect(
    { runtime, id, position, material, durationMs, maxScale }: SpawnPulseEffectInput
): void {
    const ring = MeshBuilder.CreateTorus(
        `${id}-pulse`,
        { diameter: 1, thickness: 0.055, tessellation: 48 },
        runtime.scene
    );
    ring.position.set(position.x, 0.34, position.z);
    ring.rotation.x = Math.PI / 2;
    ring.material = material;
    runtime.effects.push({
        id,
        startedAtMs: performance.now(),
        durationMs,
        meshes: [ring],
        update(progress) {
            const scale = 0.2 + maxScale * smoothstep(progress);
            ring.scaling.set(scale, scale, scale);
            ring.position.y = 0.34 + progress * 0.18;
            ring.setEnabled(progress < 0.96);
        },
        dispose() {
            ring.dispose();
        }
    });
}

export function spawnBurstEffect({ runtime, id, position, material, durationMs }: SpawnBurstEffectInput): void {
    const core = MeshBuilder.CreateSphere(`${id}-core`, { diameter: 0.32, segments: 12 }, runtime.scene);
    core.position.copyFrom(position);
    core.material = material;
    const shardA = MeshBuilder.CreateBox(`${id}-shard-a`, { width: 0.08, height: 0.72, depth: 0.08 }, runtime.scene);
    shardA.position.copyFrom(position.add(new Vector3(0.34, 0, 0.12)));
    shardA.material = material;
    const shardB = MeshBuilder.CreateBox(`${id}-shard-b`, { width: 0.08, height: 0.58, depth: 0.08 }, runtime.scene);
    shardB.position.copyFrom(position.add(new Vector3(-0.28, 0.04, -0.22)));
    shardB.material = material;
    const meshes = [core, shardA, shardB];
    runtime.effects.push({
        id,
        startedAtMs: performance.now(),
        durationMs,
        meshes,
        update(progress) {
            const eased = smoothstep(progress);
            core.scaling.setAll(1 + eased * 2.2);
            shardA.rotation.y += 0.12;
            shardB.rotation.y -= 0.1;
            shardA.position.y = position.y + eased * 1.1;
            shardB.position.y = position.y + eased * 0.88;
            for (const mesh of meshes) {
                mesh.setEnabled(progress < 0.94);
            }
        },
        dispose() {
            for (const mesh of meshes) {
                mesh.dispose();
            }
        }
    });
}

export function spawnBeamEffect({ runtime, from, to, material, durationMs }: SpawnBeamEffectInput): void {
    const delta = to.subtract(from);
    const length = Math.max(0.1, Math.sqrt(delta.x * delta.x + delta.z * delta.z));
    const beam = MeshBuilder.CreateBox(
        `review-beam-${runtime.effects.length}`,
        { width: length, height: 0.08, depth: 0.16 },
        runtime.scene
    );
    beam.position.set((from.x + to.x) / 2, 0.4, (from.z + to.z) / 2);
    beam.rotation.y = -Math.atan2(delta.z, delta.x);
    beam.material = material;
    runtime.effects.push({
        id: `beam-${runtime.effects.length}`,
        startedAtMs: performance.now(),
        durationMs,
        meshes: [beam],
        update(progress) {
            const eased = smoothstep(progress);
            beam.scaling.z = 1 + Math.sin(eased * Math.PI) * 1.6;
            beam.position.y = 0.4 + Math.sin(eased * Math.PI) * 0.18;
            beam.setEnabled(progress < 0.96);
        },
        dispose() {
            beam.dispose();
        }
    });
}
