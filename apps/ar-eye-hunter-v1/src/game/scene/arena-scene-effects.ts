import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type {
    ArenaEvent,
    EyeAttackCue,
    Vec3Tuple
} from '../arena-contracts.ts';
import type { TransientEffect } from './arena-scene-contracts.ts';
import { clamp, vector3 } from './arena-scene-geometry.ts';
import type { ArenaSceneRuntime } from './arena-scene-runtime.ts';
import { ARENA_SCENE_THEME } from './arena-scene-theme.ts';
import {
    createArenaBillboard,
    createMatrixMaterial,
    drawMatrixPanel
} from './arena-world-view.ts';
const EVENT_ACCENTS: Partial<Record<ArenaEvent['kind'], string>> = {
    'overdrive-window': ARENA_SCENE_THEME.amber,
    'eye-attack-hit': ARENA_SCENE_THEME.danger,
    'eye-attack-windup': ARENA_SCENE_THEME.danger,
    'boss-eye': ARENA_SCENE_THEME.danger,
    'eye-attack-dodged': ARENA_SCENE_THEME.cyan,
    'wave-complete': ARENA_SCENE_THEME.amber,
    'wave-start': ARENA_SCENE_THEME.magenta,
    'hazard-burst': ARENA_SCENE_THEME.danger,
    'arena-shift': ARENA_SCENE_THEME.magenta
};

const MAX_TRANSIENT_EFFECTS = 48;

export function createEyeBeamWindup(
    runtime: ArenaSceneRuntime,
    cue: EyeAttackCue,
    nowEpochMs: number
): void {
    const { scene } = runtime;
    const { beam, reticle, warning, material, aimPoint } = createEyeBeamMeshes(runtime, cue);
    const duration = Math.max(360, cue.expiresAtEpochMs - nowEpochMs + 220);
    const windupMs = Math.max(160, cue.firesAtEpochMs - nowEpochMs);
    const { label, labelTexture, labelMaterial } = createArenaBillboard({
        scene,
        name: `eye-attack-label-${cue.id}`,
        textureSize: { width: 512, height: 128 },
        size: { width: 2.75, height: 0.7 },
        position: [aimPoint.x, aimPoint.y + 1.45, aimPoint.z]
    });
    drawMatrixPanel({
        texture: labelTexture,
        title: 'LASER AUDIT',
        detail: 'please remain billable',
        accent: ARENA_SCENE_THEME.danger
    });

    addTransientEffect(runtime, {
        startedAtMs: runtime.clock.nowMonotonicMs(),
        durationMs: duration,
        meshes: [beam, reticle, warning, label],
        materials: [material, labelMaterial],
        textures: [labelTexture],
        update: (ageMs, progress) => {
            const windupProgress = clamp(ageMs / windupMs, 0, 1);
            const pulse = 1 + Math.sin(ageMs / 38) * 0.08 + windupProgress * 0.34;
            beam.scaling.x = pulse;
            beam.scaling.y = 0.45 + windupProgress * 1.7;
            beam.visibility = Math.max(0, 0.72 - progress * 0.62);
            reticle.scaling.set(pulse, pulse, pulse);
            reticle.rotation.z += 0.075 + windupProgress * 0.045;
            warning.scaling.set(1 + windupProgress * 0.85, 1 + windupProgress * 0.85, 1);
            warning.rotation.z -= 0.12;
            material.alpha = Math.max(0, 0.56 - progress * 0.48);
            label.position.y += Math.sin(ageMs / 64) * 0.002;
            labelMaterial.alpha = Math.max(0, 1 - Math.max(0, ageMs - windupMs) / 320);
        }
    });
}
interface EyeBeamMeshes {
    readonly beam: Mesh;
    readonly reticle: Mesh;
    readonly warning: Mesh;
    readonly material: StandardMaterial;
    readonly aimPoint: Vector3;
}
function createEyeBeamMeshes(runtime: ArenaSceneRuntime, cue: EyeAttackCue): EyeBeamMeshes {
    const scene = runtime.scene;
    const origin = vector3(cue.origin);
    const aimPoint = vector3(cue.aimPoint);
    const midpoint = Vector3.Center(origin, aimPoint);
    const length = Vector3.Distance(origin, aimPoint);
    const material = createMatrixMaterial({
        scene: scene,
        name: `eye-attack-beam-mat-${cue.id}`,
        diffuseHex: ARENA_SCENE_THEME.danger,
        emissiveHex: ARENA_SCENE_THEME.magenta,
        emissiveScale: 1,
        alpha: 0.52
    });

    const beam = MeshBuilder.CreateBox(`eye-attack-beam-${cue.id}`, {
        width: Math.max(0.12, cue.coneRadians * 0.55),
        height: 0.12,
        depth: length
    }, scene);
    beam.position = midpoint;
    beam.lookAt(aimPoint);
    beam.material = material;

    const reticle = MeshBuilder.CreateTorus(`eye-attack-reticle-${cue.id}`, {
        diameter: 1.65,
        thickness: 0.045,
        tessellation: 52
    }, scene);
    reticle.position = aimPoint.clone();
    reticle.position.y = Math.max(0.12, reticle.position.y - 0.75);
    reticle.rotation.x = Math.PI / 2;
    reticle.material = material;

    const warning = MeshBuilder.CreateTorus(`eye-attack-warning-${cue.id}`, {
        diameter: 0.76,
        thickness: 0.035,
        tessellation: 28
    }, scene);
    warning.position = aimPoint.clone();
    warning.position.y += 0.72;
    warning.billboardMode = Mesh.BILLBOARDMODE_ALL;
    warning.material = material;

    return { beam, reticle, warning, material, aimPoint };
}

interface CreateTracerInput {
    readonly runtime: ArenaSceneRuntime;
    readonly origin: Vector3;
    readonly direction: Vector3;
    readonly color: string;
    readonly hit: boolean;
}

export function createTracer({ runtime, origin, direction, color, hit }: CreateTracerInput): void {
    const scene = runtime.scene;
    const length = hit ? 42 : 28;
    const end = origin.add(direction.normalize().scale(length));
    const tracer = MeshBuilder.CreateLines(`shot-tracer-${runtime.clock.nowEpochMs()}-${runtime.createdEffectCount}`, {
        points: [
            origin,
            end
        ]
    }, scene);
    tracer.color = Color3.FromHexString(hit ? ARENA_SCENE_THEME.amber : color);

    const packetMaterial = createMatrixMaterial({
        scene: scene,
        name: `shot-packet-mat-${runtime.clock.nowEpochMs()}-${runtime.createdEffectCount}`,
        diffuseHex: hit ? ARENA_SCENE_THEME.amber : ARENA_SCENE_THEME.cyan,
        emissiveHex: hit ? ARENA_SCENE_THEME.amber : ARENA_SCENE_THEME.cyan,
        emissiveScale: 1,
        alpha: 0.9
    });
    const packet = MeshBuilder.CreateBox(`shot-packet-${runtime.clock.nowEpochMs()}-${runtime.createdEffectCount}`, {
        width: 0.1,
        height: 0.1,
        depth: 0.8
    }, scene);
    packet.position = Vector3.Center(origin, end);
    packet.lookAt(end);
    packet.material = packetMaterial;

    addTransientEffect(runtime, {
        startedAtMs: runtime.clock.nowMonotonicMs(),
        durationMs: hit ? 150 : 95,
        meshes: [tracer, packet],
        materials: [packetMaterial],
        update: (ageMs, progress) => {
            packet.scaling.z = 1 + progress * 2.4;
            packetMaterial.alpha = Math.max(0, 0.9 - progress * 0.9);
            tracer.visibility = Math.max(0, 1 - ageMs / (hit ? 150 : 95));
        }
    });
}

interface CreateImpactInput {
    readonly runtime: ArenaSceneRuntime;
    readonly point: Vector3;
    readonly color: string;
    readonly combo: number;
}

export function createImpact(input: CreateImpactInput): void {
    const { runtime } = input;
    const { burst, ring, ripple, shards, material } = createImpactMeshes(input);
    addTransientEffect(runtime, {
        startedAtMs: runtime.clock.nowMonotonicMs(),
        durationMs: 320,
        meshes: [burst, ring, ripple, ...shards],
        materials: [material],
        update: (age) => {
            const scale = 1 + age / 70;
            burst.scaling.set(scale, scale, scale);
            ring.scaling.set(scale * 1.7, scale * 1.7, scale * 1.7);
            ripple.scaling.set(scale * 2.2, scale * 2.2, scale * 2.2);
            ring.rotation.y += 0.08;
            ripple.rotation.z += 0.05;
            for (const [index, shard] of shards.entries()) {
                shard.position.x += Math.sin(index * 1.7) * 0.012;
                shard.position.y += 0.018;
                shard.position.z += Math.cos(index * 1.3) * 0.012;
                shard.rotation.y += 0.16;
            }
            material.alpha = Math.max(0, 1 - age / 320);
        }
    });
}
interface ImpactMeshes {
    readonly burst: Mesh;
    readonly ring: Mesh;
    readonly ripple: Mesh;
    readonly shards: readonly Mesh[];
    readonly material: StandardMaterial;
}
function createImpactMeshes(input: CreateImpactInput): ImpactMeshes {
    const { runtime, point, color, combo } = input;
    const scene = runtime.scene;
    const material = createMatrixMaterial({
        scene: scene,
        name: `impact-mat-${runtime.clock.nowEpochMs()}`,
        diffuseHex: color,
        emissiveHex: color,
        emissiveScale: 1,
        alpha: 0.92
    });

    const burst = MeshBuilder.CreateSphere(`impact-${runtime.clock.nowEpochMs()}`, {
        diameter: 0.24 + Math.min(combo, 12) * 0.025,
        segments: 12
    }, scene);
    burst.position = point.clone();
    burst.material = material;

    const ring = MeshBuilder.CreateTorus(`impact-ring-${runtime.clock.nowEpochMs()}`, {
        diameter: 0.62,
        thickness: 0.025,
        tessellation: 28
    }, scene);
    ring.position = point.clone();
    ring.material = material;

    const ripple = MeshBuilder.CreateTorus(`impact-ripple-${runtime.clock.nowEpochMs()}`, {
        diameter: 1.05,
        thickness: 0.018,
        tessellation: 44
    }, scene);
    ripple.position = point.clone();
    ripple.rotation.x = Math.PI / 2;
    ripple.material = material;

    const shards = createImpactShards(input, material);
    return { burst, ring, ripple, shards, material };
}
function createImpactShards(input: CreateImpactInput, material: StandardMaterial): readonly Mesh[] {
    const { runtime, point, combo } = input;
    const scene = runtime.scene;
    const shards: Mesh[] = [];
    for (let i = 0; i < Math.min(9, 4 + combo); i += 1) {
        const shard = MeshBuilder.CreateBox(`impact-code-shard-${runtime.clock.nowEpochMs()}-${i}`, {
            width: 0.045,
            height: 0.22 + i * 0.015,
            depth: 0.045
        }, scene);
        shard.position = point.add(
            new Vector3(
                Math.sin(i * 2.11) * 0.18,
                Math.cos(i * 1.37) * 0.12,
                Math.cos(i * 1.91) * 0.18
            )
        );
        shard.rotation.set(i * 0.2, i * 0.45, i * 0.31);
        shard.material = material;
        shards.push(shard);
    }

    return shards;
}

export function createScanPulse(runtime: ArenaSceneRuntime, position: Vec3Tuple, color: string): void {
    const scene = runtime.scene;
    const material = createMatrixMaterial({
        scene: scene,
        name: `scan-pulse-mat-${runtime.clock.nowEpochMs()}`,
        diffuseHex: color,
        emissiveHex: color,
        emissiveScale: 0.95,
        alpha: 0.55
    });

    const ring = MeshBuilder.CreateTorus(`scan-pulse-${runtime.clock.nowEpochMs()}`, {
        diameter: 1.2,
        thickness: 0.035,
        tessellation: 48
    }, scene);
    ring.position = vector3(position);
    ring.position.y = 0.12;
    ring.rotation.x = Math.PI / 2;
    ring.material = material;

    const column = MeshBuilder.CreateCylinder(`scan-column-${runtime.clock.nowEpochMs()}`, {
        height: 6.2,
        diameter: 0.52,
        tessellation: 24
    }, scene);
    column.position = vector3(position);
    column.position.y = 3.1;
    column.material = material;

    addTransientEffect(runtime, {
        startedAtMs: runtime.clock.nowMonotonicMs(),
        durationMs: 560,
        meshes: [ring, column],
        materials: [material],
        update: (age) => {
            const scale = 1 + age / 42;
            ring.scaling.set(scale, scale, scale);
            column.scaling.x = 1 + age / 260;
            column.scaling.z = 1 + age / 260;
            column.rotation.y += 0.08;
            material.alpha = Math.max(0, 0.55 - age / 560);
        }
    });
}

export function createArenaEventEffect(runtime: ArenaSceneRuntime, event: ArenaEvent): void {
    const scene = runtime.scene;
    const color = EVENT_ACCENTS[event.kind] ?? ARENA_SCENE_THEME.acid;
    const material = createMatrixMaterial({
        scene: scene,
        name: `event-mat-${event.id}`,
        diffuseHex: color,
        emissiveHex: color,
        emissiveScale: 0.92,
        alpha: 0.42
    });

    const ring = MeshBuilder.CreateTorus(`event-ring-${event.id}`, {
        diameter: (event.radius ?? 6) * 2,
        thickness: 0.065,
        tessellation: 64
    }, scene);
    ring.position = vector3(event.position ?? [0, 0.16, 0]);
    ring.rotation.x = Math.PI / 2;
    ring.material = material;

    const position = event.position ?? [0, 0.16, 0];
    const { label, labelTexture, labelMaterial } = createArenaBillboard({
        scene,
        name: `event-label-${event.id}`,
        textureSize: { width: 768, height: 256 },
        size: { width: 4.5, height: 1.5 },
        position: [position[0], position[1] + 2.35, position[2]]
    });
    drawMatrixPanel({
        texture: labelTexture,
        title: event.kind.toUpperCase(),
        detail: getArenaEventJoke(event.kind),
        accent: color
    });

    const duration = Math.min(900, Math.max(360, event.durationMs ?? 700));
    addTransientEffect(runtime, {
        startedAtMs: runtime.clock.nowMonotonicMs(),
        durationMs: duration + 240,
        meshes: [ring, label],
        materials: [material, labelMaterial],
        textures: [labelTexture],
        update: (age) => {
            const pulse = 1 + Math.sin(age / 48) * 0.025 + age / duration * 0.22;
            ring.scaling.set(pulse, pulse, pulse);
            ring.rotation.z += 0.018;
            label.position.y += Math.sin(age / 80) * 0.002;
            material.alpha = Math.max(0, 0.42 - age / duration);
            labelMaterial.alpha = Math.max(0, 1 - Math.max(0, age - duration) / 240);
        }
    });
}

function addTransientEffect(runtime: ArenaSceneRuntime, effect: TransientEffect): void {
    while (runtime.transientEffects.length >= MAX_TRANSIENT_EFFECTS) {
        const oldest = runtime.transientEffects.shift();
        if (oldest) {
            disposeTransientEffect(oldest);
        }
    }
    runtime.transientEffects.push(effect);
    runtime.createdEffectCount += 1;
}

export function updateTransientEffects(runtime: ArenaSceneRuntime): void {
    const now = runtime.clock.nowMonotonicMs();
    runtime.transientEffects = runtime.transientEffects.filter((effect) => {
        const age = now - effect.startedAtMs;
        const progress = clamp(age / effect.durationMs, 0, 1);
        effect.update?.(age, progress);
        if (age < effect.durationMs) {
            return true;
        }
        disposeTransientEffect(effect);
        return false;
    });
}

function disposeTransientEffect(effect: TransientEffect): void {
    for (const mesh of effect.meshes) {
        mesh.dispose();
    }
    for (const material of effect.materials) {
        material.dispose();
    }
    for (const texture of effect.textures ?? []) {
        texture.dispose();
    }
}

function getArenaEventJoke(kind: ArenaEvent['kind']): string {
    if (kind === 'wave-start') {
        return 'compliance lasers armed';
    }
    if (kind === 'wave-complete') {
        return 'HR regrets your survival';
    }
    if (kind === 'eye-attack-windup') {
        return 'laser audit is charging';
    }
    if (kind === 'eye-attack-hit') {
        return 'feedback delivered with menace';
    }
    if (kind === 'eye-attack-dodged') {
        return 'audit evaded; paperwork angry';
    }
    if (kind === 'boss-eye') {
        return 'performance review entered the arena';
    }
    if (kind === 'overdrive-window') {
        return 'approved overtime for your trigger finger';
    }
    if (kind === 'hazard-burst') {
        return 'workplace safety is in beta';
    }
    if (kind === 'arena-shift') {
        return 'floor plan updated without consent';
    }
    if (kind === 'combo-bounty') {
        return 'metrics adore your violence';
    }
    if (kind === 'reward-drop') {
        return 'loyalty program got nervous';
    }
    return 'the director has opinions';
}

export function createTouchAimPulse(runtime: ArenaSceneRuntime, world: Vec3Tuple): void {
    const material = createMatrixMaterial({
        scene: runtime.scene,
        name: `touch-aim-assist-${runtime.clock.nowMonotonicMs()}`,
        diffuseHex: ARENA_SCENE_THEME.acid,
        emissiveHex: ARENA_SCENE_THEME.cyan,
        emissiveScale: 1,
        alpha: 0.72
    });
    const ring = MeshBuilder.CreateTorus(`touch-aim-ring-${runtime.clock.nowMonotonicMs()}`, {
        diameter: 1.15,
        thickness: 0.035,
        tessellation: 36
    }, runtime.scene);
    ring.position = vector3(world);
    ring.position.y += 0.12;
    ring.billboardMode = Mesh.BILLBOARDMODE_ALL;
    ring.material = material;
    addTransientEffect(runtime, {
        startedAtMs: runtime.clock.nowMonotonicMs(),
        durationMs: 360,
        meshes: [ring],
        materials: [material],
        update: (_age, progress) => {
            const scale = 1 + progress * 0.9;
            ring.scaling.set(scale, scale, scale);
            material.alpha = Math.max(0, 0.72 - progress * 0.72);
        }
    });
}
