import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { ArenaPickupState, EyeTargetState } from '../arena-contracts.ts';
import type { PickupAvatar, TargetAvatar } from './arena-scene-contracts.ts';
import { createEyeBeamWindup } from './arena-scene-effects.ts';
import { hashString, vector3 } from './arena-scene-geometry.ts';
import type { ArenaSceneRuntime } from './arena-scene-runtime.ts';
import { ARENA_SCENE_THEME } from './arena-scene-theme.ts';
import { createArenaBillboard, createMatrixMaterial } from './arena-world-view.ts';

const MATRIX_TARGET_LABELS = [
    'Terms Accepted Eye',
    'Privacy Policy Witness',
    'Compliance Orb',
    'Unpaid Intern Swarm',
    'Mandatory Fun Sensor',
    'Cookie Consent Retina',
    'Productivity Gazer',
    'User Research Victim'
] as const;
export function syncTargetAvatars(runtime: ArenaSceneRuntime, nowEpochMs: number): void {
    const targetIds = new Set(runtime.arenaState.targets.map((target) => target.id));
    for (const target of runtime.arenaState.targets) {
        const avatar = getOrCreateTargetAvatar(runtime.scene, runtime.targets, target);
        const hostile = isHostileEye(target);
        const dangerPulse = hostile ? 1 + Math.sin(nowEpochMs / 92 + target.phase) * 0.12 : 1;
        avatar.root.position = vector3(target.position);
        avatar.root.position.y += Math.sin(nowEpochMs / 440 + target.phase) * 0.26;
        avatar.root.rotation.y += (hostile ? 0.026 : 0.014) + target.velocity[0] * 0.002;
        const healthScale = 0.55 + target.health / Math.max(1, target.maxHealth) * 0.45;
        avatar.iris.scaling.set(healthScale * dangerPulse, healthScale, healthScale);
        avatar.ring.scaling.set(
            (hostile ? 1.28 : 1.08) + Math.sin(nowEpochMs / 180 + target.phase) * 0.08,
            (hostile ? 0.86 : 1.08) + Math.cos(nowEpochMs / 220 + target.phase) * 0.08,
            1.08
        );
        avatar.halo.scaling.set(
            (hostile ? 1.7 : 1.28) + Math.sin(nowEpochMs / 160 + target.phase) * 0.12,
            (hostile ? 0.92 : 1.28) + Math.cos(nowEpochMs / 210 + target.phase) * 0.12,
            1.28
        );
        avatar.halo.rotation.z -= hostile ? 0.046 : 0.018;
        avatar.shardA.rotation.y += hostile ? 0.065 : 0.035;
        avatar.shardB.rotation.x -= hostile ? 0.052 : 0.028;
        avatar.shardA.scaling.y = hostile ? 1.45 + Math.sin(nowEpochMs / 105) * 0.08 : 1;
        avatar.shardB.scaling.y = hostile ? 1.35 + Math.cos(nowEpochMs / 120) * 0.08 : 1;
        avatar.coreMaterial.emissiveColor = Color3.FromHexString(
            hostile ? ARENA_SCENE_THEME.danger : target.color
        ).scale(hostile ? 1.05 : 0.64);
        avatar.pupilMaterial.emissiveColor = Color3.FromHexString(
            hostile ? ARENA_SCENE_THEME.magenta : ARENA_SCENE_THEME.cyan
        ).scale(hostile ? 0.82 : 0.26);
        avatar.ringMaterial.emissiveColor = target.rarity === 'bounty'
            ? Color3.FromHexString(ARENA_SCENE_THEME.amber).scale(1.05)
            : hostile
            ? Color3.FromHexString(ARENA_SCENE_THEME.magenta).scale(1.18)
            : Color3.FromHexString(target.color).scale(1.0);
        updateTargetLabel(avatar.labelTexture, target);
    }

    for (const [targetId, avatar] of runtime.targets) {
        if (targetIds.has(targetId)) {
            continue;
        }
        avatar.root.dispose();
        avatar.labelTexture.dispose();
        runtime.targets.delete(targetId);
    }
}

export function syncEyeAttackCues(runtime: ArenaSceneRuntime, nowEpochMs: number): void {
    const activeCueIds = new Set(runtime.arenaState.attacks.map((cue) => cue.id));
    for (const cue of runtime.arenaState.attacks) {
        if (runtime.attackCueIds.has(cue.id)) {
            continue;
        }
        runtime.attackCueIds.add(cue.id);
        createEyeBeamWindup(runtime, cue, nowEpochMs);
    }

    for (const cueId of [...runtime.attackCueIds]) {
        if (!activeCueIds.has(cueId)) {
            runtime.attackCueIds.delete(cueId);
        }
    }
}

export function syncPickupAvatars(runtime: ArenaSceneRuntime, nowEpochMs: number): void {
    const visiblePickups = runtime.arenaState.pickups.filter((pickup) =>
        !pickup.pickedBySessionId && pickup.expiresAtEpochMs > nowEpochMs
    );
    const visibleIds = new Set(visiblePickups.map((pickup) => pickup.id));

    for (const pickup of visiblePickups) {
        const avatar = getOrCreatePickupAvatar(runtime.scene, runtime.pickups, pickup);
        avatar.root.position = vector3(pickup.position);
        avatar.root.position.y += 0.2 + Math.sin(nowEpochMs / 280 + pickup.tier) * 0.12;
        avatar.root.rotation.y += 0.028 + pickup.tier * 0.004;
        avatar.ring.rotation.z -= 0.04;
        const pulse = 1 + Math.sin(nowEpochMs / 180) * 0.04;
        avatar.core.scaling.set(pulse, pulse, pulse);
        updatePickupLabel(avatar.labelTexture, pickup);
    }

    for (const [pickupId, avatar] of runtime.pickups) {
        if (visibleIds.has(pickupId)) {
            continue;
        }
        avatar.root.dispose();
        avatar.labelTexture.dispose();
        runtime.pickups.delete(pickupId);
        runtime.sentPickupIds.delete(pickupId);
    }
}

function getOrCreatePickupAvatar(
    scene: Scene,
    pickups: Map<string, PickupAvatar>,
    pickup: ArenaPickupState
): PickupAvatar {
    const existing = pickups.get(pickup.id);
    if (existing) {
        return existing;
    }

    const root = new TransformNode(`pickup-root-${pickup.id}`, scene);
    root.position = vector3(pickup.position);

    const accent = pickup.tier <= 0
        ? ARENA_SCENE_THEME.danger
        : pickup.tier >= 3
        ? ARENA_SCENE_THEME.amber
        : ARENA_SCENE_THEME.cyan;
    const material = createMatrixMaterial({
        scene: scene,
        name: `pickup-mat-${pickup.id}`,
        diffuseHex: ARENA_SCENE_THEME.glass,
        emissiveHex: accent,
        emissiveScale: 0.92,
        alpha: 0.86
    });

    const core = MeshBuilder.CreateBox(`pickup-core-${pickup.id}`, {
        width: 0.72,
        height: 0.72,
        depth: 0.72
    }, scene);
    core.parent = root;
    core.rotation.set(0.4, 0.2, 0.8);
    core.material = material;

    const ring = MeshBuilder.CreateTorus(`pickup-ring-${pickup.id}`, {
        diameter: 1.55,
        thickness: 0.04,
        tessellation: 36
    }, scene);
    ring.parent = root;
    ring.rotation.x = Math.PI / 2;
    ring.material = material;

    const { label, labelTexture } = createArenaBillboard({
        scene,
        name: `pickup-label-${pickup.id}`,
        textureSize: { width: 640, height: 160 },
        size: { width: 2.6, height: 0.64 },
        parent: root,
        position: [0, 1.08, 0]
    });
    updatePickupLabel(labelTexture, pickup);

    const avatar = { root, core, ring, label, material, labelTexture };
    pickups.set(pickup.id, avatar);
    return avatar;
}

interface TargetViewAssembly {
    readonly scene: Scene;
    readonly target: EyeTargetState;
    readonly root: TransformNode;
    readonly hostile: boolean;
    readonly coreMaterial: StandardMaterial;
    readonly pupilMaterial: StandardMaterial;
    readonly ringMaterial: StandardMaterial;
    readonly shardMaterial: StandardMaterial;
}
function createTargetViewAssembly(scene: Scene, target: EyeTargetState): TargetViewAssembly {
    const root = new TransformNode(`target-root-${target.id}`, scene);
    root.position = vector3(target.position);
    const hostile = isHostileEye(target);
    const coreColor = hostile ? ARENA_SCENE_THEME.danger : target.color;

    const coreMaterial = new StandardMaterial(`target-core-${target.id}`, scene);
    coreMaterial.diffuseColor = Color3.FromHexString(coreColor);
    coreMaterial.emissiveColor = Color3.FromHexString(coreColor).scale(hostile ? 1.0 : 0.64);
    coreMaterial.specularColor = Color3.FromHexString(ARENA_SCENE_THEME.white).scale(0.35);

    const pupilMaterial = new StandardMaterial(`target-pupil-${target.id}`, scene);
    pupilMaterial.diffuseColor = Color3.FromHexString(ARENA_SCENE_THEME.void);
    pupilMaterial.emissiveColor = Color3.FromHexString(
        hostile ? ARENA_SCENE_THEME.magenta : ARENA_SCENE_THEME.cyan
    ).scale(hostile ? 0.82 : 0.26);

    const ringMaterial = new StandardMaterial(`target-ring-${target.id}`, scene);
    ringMaterial.diffuseColor = Color3.FromHexString(coreColor);
    ringMaterial.emissiveColor = Color3.FromHexString(coreColor).scale(hostile ? 1.15 : 0.9);
    ringMaterial.specularColor = Color3.FromHexString(ARENA_SCENE_THEME.white).scale(0.4);

    const shardMaterial = createMatrixMaterial({
        scene: scene,
        name: `target-code-shard-${target.id}`,
        diffuseHex: hostile ? ARENA_SCENE_THEME.magenta : ARENA_SCENE_THEME.cyan,
        emissiveHex: hostile ? ARENA_SCENE_THEME.magenta : ARENA_SCENE_THEME.cyan,
        emissiveScale: hostile ? 1.0 : 0.72,
        alpha: 0.78
    });

    return { scene, target, root, hostile, coreMaterial, pupilMaterial, ringMaterial, shardMaterial };
}
function getOrCreateTargetAvatar(
    scene: Scene,
    targets: Map<string, TargetAvatar>,
    target: EyeTargetState
): TargetAvatar {
    const existing = targets.get(target.id);
    if (existing) {
        return existing;
    }
    const assembly = createTargetViewAssembly(scene, target);
    const { root, coreMaterial, pupilMaterial, ringMaterial } = assembly;
    const { label, labelTexture, labelMaterial } = createArenaBillboard({
        scene,
        name: `target-label-${target.id}`,
        textureSize: { width: 768, height: 192 },
        size: { width: 3.2, height: 0.8 },
        parent: root,
        position: [0, target.radius * 1.75, 0]
    });
    updateTargetLabel(labelTexture, target);

    const avatar = {
        root,
        coreMaterial,
        pupilMaterial,
        ringMaterial,
        label,
        labelTexture,
        labelMaterial,
        ...createTargetEye(assembly),
        ...createTargetRings(assembly),
        ...createTargetShards(assembly)
    };
    targets.set(target.id, avatar);
    return avatar;
}

function createTargetEye(assembly: TargetViewAssembly): Pick<TargetAvatar, 'iris' | 'pupil'> {
    const { scene, target, root, hostile, coreMaterial, pupilMaterial } = assembly;
    const iris = MeshBuilder.CreateSphere(`eye-target-${target.id}`, {
        diameterX: target.radius * (hostile ? 3.25 : 2.4),
        diameterY: target.radius * (hostile ? 0.95 : 1.45),
        diameterZ: target.radius * (hostile ? 0.48 : 0.62),
        segments: 28
    }, scene);
    iris.parent = root;
    iris.material = coreMaterial;

    const pupil = MeshBuilder.CreateSphere(`eye-pupil-${target.id}`, {
        diameterX: target.radius * (hostile ? 1.1 : 0.74),
        diameterY: target.radius * (hostile ? 0.32 : 0.74),
        diameterZ: target.radius * 0.18,
        segments: 18
    }, scene);
    pupil.parent = root;
    pupil.position.z = -target.radius * 0.34;
    pupil.material = pupilMaterial;

    return { iris, pupil };
}

function createTargetRings(assembly: TargetViewAssembly): Pick<TargetAvatar, 'ring' | 'halo'> {
    const { scene, target, root, hostile, ringMaterial } = assembly;
    const ring = MeshBuilder.CreateTorus(`eye-ring-${target.id}`, {
        diameter: target.radius * (hostile ? 3.28 : 2.75),
        thickness: 0.035,
        tessellation: 32
    }, scene);
    ring.parent = root;
    ring.rotation.x = Math.PI / 2;
    ring.material = ringMaterial;

    const halo = MeshBuilder.CreateTorus(`eye-holo-halo-${target.id}`, {
        diameter: target.radius * (hostile ? 4.15 : 3.65),
        thickness: 0.018,
        tessellation: 42
    }, scene);
    halo.parent = root;
    halo.rotation.x = Math.PI / 2;
    halo.material = ringMaterial;

    return { ring, halo };
}

function createTargetShards(assembly: TargetViewAssembly): Pick<TargetAvatar, 'shardA' | 'shardB'> {
    const { scene, target, root, hostile, shardMaterial } = assembly;
    const shardA = MeshBuilder.CreateBox(`eye-shard-a-${target.id}`, {
        width: hostile ? target.radius * 2.7 : 0.08,
        height: hostile ? 0.07 : target.radius * 1.8,
        depth: 0.04
    }, scene);
    shardA.parent = root;
    shardA.position.set(
        hostile ? 0 : target.radius * 1.8,
        hostile ? target.radius * 0.44 : 0.18,
        -target.radius * 0.08
    );
    shardA.rotation.z = hostile ? 0.13 : 0.45;
    shardA.material = shardMaterial;

    const shardB = MeshBuilder.CreateBox(`eye-shard-b-${target.id}`, {
        width: hostile ? target.radius * 2.5 : 0.06,
        height: hostile ? 0.07 : target.radius * 1.45,
        depth: 0.04
    }, scene);
    shardB.parent = root;
    shardB.position.set(
        hostile ? 0 : -target.radius * 1.6,
        hostile ? -target.radius * 0.44 : -0.12,
        -target.radius * 0.06
    );
    shardB.rotation.z = hostile ? -0.13 : -0.5;
    shardB.material = shardMaterial;

    return { shardA, shardB };
}

function updateTargetLabel(texture: DynamicTexture, target: EyeTargetState): void {
    const label = getTargetLabel(target);
    const rarity = target.rarity.toUpperCase();
    const accent = target.rarity === 'bounty'
        ? ARENA_SCENE_THEME.amber
        : target.rarity === 'rift'
        ? ARENA_SCENE_THEME.magenta
        : target.rarity === 'volatile'
        ? ARENA_SCENE_THEME.danger
        : ARENA_SCENE_THEME.acid;
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 768, 192);
    ctx.fillStyle = 'rgba(0, 8, 7, 0.76)';
    ctx.fillRect(16, 24, 736, 132);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 6;
    ctx.strokeRect(16, 24, 736, 132);
    ctx.fillStyle = accent;
    ctx.font = '700 28px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(rarity, 40, 68);
    ctx.fillStyle = ARENA_SCENE_THEME.white;
    ctx.font = '700 36px system-ui, sans-serif';
    ctx.fillText(label, 40, 112);
    ctx.fillStyle = 'rgba(239, 255, 247, 0.74)';
    ctx.font = '500 22px system-ui, sans-serif';
    ctx.fillText(`hp ${Math.max(0, Math.ceil(target.health))}/${target.maxHealth}`, 40, 144);
    texture.update();
}

function updatePickupLabel(texture: DynamicTexture, pickup: ArenaPickupState): void {
    const accent = pickup.tier <= 0
        ? ARENA_SCENE_THEME.danger
        : pickup.tier >= 3
        ? ARENA_SCENE_THEME.amber
        : ARENA_SCENE_THEME.cyan;
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 640, 160);
    ctx.fillStyle = 'rgba(0, 8, 7, 0.78)';
    ctx.fillRect(14, 18, 612, 118);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.strokeRect(14, 18, 612, 118);
    ctx.fillStyle = accent;
    ctx.font = '700 25px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(pickup.tier <= 0 ? 'DOWNGRADE' : `TIER ${pickup.tier}`, 34, 58);
    ctx.fillStyle = ARENA_SCENE_THEME.white;
    ctx.font = '700 32px system-ui, sans-serif';
    ctx.fillText(pickup.label.slice(0, 24), 34, 98);
    ctx.fillStyle = 'rgba(239, 255, 247, 0.72)';
    ctx.font = '500 19px system-ui, sans-serif';
    ctx.fillText('walk over to accept HR consequences', 34, 124);
    texture.update();
}

function getTargetLabel(target: EyeTargetState): string {
    if (target.threat?.kind === 'boss') {
        return 'Boss Eye Performance Review';
    }
    if (target.threat?.kind === 'beam-sentry') {
        return target.rarity === 'bounty'
            ? 'Bounty Compliance Laser Auditor'
            : 'Compliance Laser Auditor';
    }
    const base = MATRIX_TARGET_LABELS[Math.abs(hashString(target.id)) % MATRIX_TARGET_LABELS.length];
    return target.bountyUntilEpochMs ? `Bounty ${base}` : base;
}

export function isHostileEye(target: EyeTargetState): boolean {
    return target.threat?.kind === 'beam-sentry' || target.threat?.kind === 'boss';
}
