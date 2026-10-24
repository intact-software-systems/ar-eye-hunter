import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { avatarAccentForPalette } from '../avatarProfile.ts';
import type {
    PlayerArenaState,
    PlayerPose,
    RemotePlayer,
    RemoteShot
} from '../types.ts';
import type { RemoteAvatar } from './arena-scene-contracts.ts';
import { createImpact, createTracer } from './arena-scene-effects.ts';
import { clamp, vector3 } from './arena-scene-geometry.ts';
import type { ArenaSceneRuntime } from './arena-scene-runtime.ts';
import { ARENA_SCENE_THEME } from './arena-scene-theme.ts';
import { createMatrixMaterial } from './arena-world-view.ts';

export function syncRemoteAvatars(
    runtime: ArenaSceneRuntime,
    remotePlayers: ReadonlyMap<string, RemotePlayer>
): void {
    syncRemoteMotionSamples(runtime, remotePlayers);
    const estimates = runtime.motionBuffer.sampleAll(runtime.clock.nowEpochMs());

    for (const [sessionId, remote] of remotePlayers) {
        const estimate = estimates.get(sessionId);
        const pose = estimate?.metadata ?? remote.pose;
        const avatar = getOrCreateAvatar(runtime, sessionId, pose);
        const position = estimate?.position ?? remote.pose.position;
        const rotation = estimate?.rotation ?? remote.pose.rotation;

        avatar.root.position = vector3(position);
        avatar.root.rotation.y = rotation[1];
        const profile = pose.avatarProfile;
        const accentColor = profile
            ? avatarAccentForPalette(profile.glowPalette)
            : pose.color;
        avatar.material.diffuseColor = Color3.FromHexString(pose.color);
        avatar.material.emissiveColor = Color3.FromHexString(pose.color).scale(0.28);
        avatar.accentMaterial.emissiveColor = Color3.FromHexString(accentColor).scale(0.78);
        avatar.accentMaterial.diffuseColor = Color3.FromHexString(accentColor).scale(0.44);
        avatar.trail.setEnabled(profile?.trailStyle !== 'none');
        avatar.trail.visibility = profile?.trailStyle === 'spark-leak' ? 0.48 : 0.32;
        avatar.decal.rotation.z += profile?.decal === 'bug-bounty' ? 0.035 : 0.018;
        avatar.visor.scaling.x = profile?.visorExpression === 'angry-v' ? 1.18 : 1;
        avatar.ring.rotation.y += 0.025;
        const vitals = pose.vitals;
        if (vitals) {
            const healthRatio = clamp(vitals.health / Math.max(1, vitals.maxHealth), 0, 1);
            avatar.health.scaling.x = Math.max(0.02, healthRatio);
            avatar.health.position.x = -0.55 + healthRatio * 0.55;
            const healthMaterial = avatar.healthMaterial;
            if (healthMaterial) {
                healthMaterial.emissiveColor = Color3.FromHexString(
                    healthRatio <= 0.28 ? ARENA_SCENE_THEME.danger : ARENA_SCENE_THEME.acid
                ).scale(0.86);
            }
            avatar.root.setEnabled(!(vitals.deadUntilEpochMs && vitals.deadUntilEpochMs > runtime.clock.nowEpochMs()));
        }
        updateLabel({
            texture: avatar.labelTexture,
            username: pose.username,
            score: pose.score,
            combo: pose.combo ?? 0,
            color: pose.color,
            vitals: pose.vitals,
            weaponKind: pose.loadout?.weaponKind,
            profile: profile
        });
    }

    removeDepartedPeerAvatars(runtime, remotePlayers);
}

function removeDepartedPeerAvatars(runtime: ArenaSceneRuntime, remotePlayers: ReadonlyMap<string, RemotePlayer>): void {
    for (const [sessionId, avatar] of runtime.avatars) {
        if (remotePlayers.has(sessionId)) {
            continue;
        }
        avatar.root.dispose();
        avatar.labelTexture.dispose();
        runtime.motionBuffer.remove(sessionId);
        runtime.motionSampleKeys.delete(sessionId);
        runtime.avatars.delete(sessionId);
    }
}

function syncRemoteMotionSamples(
    runtime: ArenaSceneRuntime,
    remotePlayers: ReadonlyMap<string, RemotePlayer>
): void {
    for (const [sessionId, remote] of remotePlayers) {
        const sampleKey = `${remote.pose.seq}:${remote.lastSeenEpochMs}`;
        if (runtime.motionSampleKeys.get(sessionId) === sampleKey) {
            continue;
        }

        runtime.motionBuffer.push({
            entityId: sessionId,
            observedAtEpochMs: remote.lastSeenEpochMs,
            position: remote.pose.position,
            rotation: remote.pose.rotation,
            velocity: remote.pose.velocity,
            angularVelocity: remote.pose.angularVelocity,
            seq: remote.pose.seq,
            metadata: remote.pose
        });
        runtime.motionSampleKeys.set(sessionId, sampleKey);
    }

    runtime.motionBuffer.prune(runtime.clock.nowEpochMs());
}

export function syncRemoteShots(runtime: ArenaSceneRuntime, remoteShots: readonly RemoteShot[]): void {
    for (const remoteShot of remoteShots) {
        if (runtime.remoteShotIds.has(remoteShot.id)) {
            continue;
        }

        runtime.remoteShotIds.add(remoteShot.id);
        const shot = remoteShot.accepted?.shot ?? remoteShot.shot;
        createTracer({
            runtime: runtime,
            origin: vector3(shot.origin),
            direction: vector3(shot.direction),
            color: shot.color,
            hit: !!remoteShot.accepted?.hit
        });
        if (remoteShot.accepted?.hit) {
            createImpact({
                runtime: runtime,
                point: vector3(remoteShot.accepted.impact),
                color: ARENA_SCENE_THEME.magenta,
                combo: remoteShot.accepted.combo
            });
        }
    }
}

function getOrCreateAvatar(runtime: ArenaSceneRuntime, sessionId: string, pose: PlayerPose): RemoteAvatar {
    const { scene, avatars } = runtime;
    const existing = avatars.get(sessionId);
    if (existing) {
        return existing;
    }
    const assembly = createPeerAvatarAssembly(scene, sessionId, pose);
    createPeerArms(assembly);
    createPeerExpression(assembly);
    const avatar = {
        root: assembly.root,
        material: assembly.material,
        accentMaterial: assembly.accentMaterial,
        ...createPeerBody(assembly),
        ...createPeerHead(assembly),
        ...createPeerShoulders(assembly),
        ...createPeerAccessories(assembly),
        ...createPeerLabels(assembly)
    };
    avatars.set(sessionId, avatar);
    return avatar;
}
interface PeerAvatarAssembly {
    readonly scene: Scene;
    readonly sessionId: string;
    readonly pose: PlayerPose;
    readonly root: TransformNode;
    readonly material: StandardMaterial;
    readonly accentMaterial: StandardMaterial;
    readonly accentColor: string;
    readonly bodyScale: { readonly height: number; readonly width: number; readonly depth: number; };
    readonly torsoBoost: number;
}
function createPeerAvatarAssembly(scene: Scene, sessionId: string, pose: PlayerPose): PeerAvatarAssembly {
    const root = new TransformNode(`remote-${sessionId}`, scene);
    root.position = vector3(pose.position);
    const profile = pose.avatarProfile;
    const accentColor = profile
        ? avatarAccentForPalette(profile.glowPalette)
        : pose.color;
    const bodyScale = profile?.robotFrame === 'reaper'
        ? { height: 1.92, width: 0.62, depth: 0.46 }
        : profile?.robotFrame === 'warden'
        ? { height: 1.86, width: 0.84, depth: 0.58 }
        : profile?.robotFrame === 'bulwark'
        ? { height: 1.78, width: 0.92, depth: 0.64 }
        : { height: 1.9, width: 0.76, depth: 0.54 };
    const torsoBoost = profile?.torsoMass === 'titan'
        ? 1.18
        : profile?.torsoMass === 'heavy'
        ? 1.08
        : 1;

    const material = new StandardMaterial(`remote-mat-${sessionId}`, scene);
    material.diffuseColor = Color3.FromHexString(pose.color);
    material.emissiveColor = Color3.FromHexString(pose.color).scale(0.28);
    material.specularColor = Color3.FromHexString(ARENA_SCENE_THEME.white).scale(0.22);

    const accentMaterial = createMatrixMaterial({
        scene: scene,
        name: `remote-accent-${sessionId}`,
        diffuseHex: accentColor,
        emissiveHex: accentColor,
        emissiveScale: 0.78,
        alpha: 0.78
    });

    return { scene, sessionId, pose, root, material, accentMaterial, accentColor, bodyScale, torsoBoost };
}

function createPeerBody(assembly: PeerAvatarAssembly): Pick<RemoteAvatar, 'body'> {
    const { scene, sessionId, root, material, bodyScale, torsoBoost } = assembly;
    const body = MeshBuilder.CreateBox(`remote-body-${sessionId}`, {
        width: bodyScale.width * torsoBoost,
        height: bodyScale.height * 0.68,
        depth: bodyScale.depth * torsoBoost
    }, scene);
    body.parent = root;
    body.position.y = -0.78;
    body.material = material;

    const waist = MeshBuilder.CreateBox(`remote-waist-${sessionId}`, {
        width: bodyScale.width * 0.72,
        height: 0.22,
        depth: bodyScale.depth * 0.74
    }, scene);
    waist.parent = root;
    waist.position.y = -1.38;
    waist.material = material;

    return { body };
}

function createPeerHead(assembly: PeerAvatarAssembly): Pick<RemoteAvatar, 'visor'> {
    const { scene, sessionId, pose, root, material, accentColor, bodyScale } = assembly;
    const profile = pose.avatarProfile;
    const head = MeshBuilder.CreateBox(`remote-head-${sessionId}`, {
        width: bodyScale.width * 0.74,
        height: 0.42,
        depth: bodyScale.depth * 0.72
    }, scene);
    head.parent = root;
    head.position.set(0, 0.1, -0.02);
    head.material = material;

    const visorMaterial = new StandardMaterial(`remote-visor-mat-${sessionId}`, scene);
    visorMaterial.diffuseColor = Color3.FromHexString(ARENA_SCENE_THEME.void);
    visorMaterial.emissiveColor = Color3.FromHexString(accentColor).scale(0.68);

    const visor = MeshBuilder.CreateBox(`remote-visor-${sessionId}`, {
        width: profile?.visorExpression === 'angry-v' ? 0.64 : 0.52,
        height: profile?.faceplate === 'tax-mask' ? 0.22 : 0.13,
        depth: 0.08
    }, scene);
    visor.parent = root;
    visor.position.set(0, 0.13, -bodyScale.depth * 0.39);
    visor.rotation.z = profile?.visorExpression === 'grim-smirk' ? 0.05 : 0;
    visor.material = visorMaterial;

    return { visor };
}

function createPeerShoulders(assembly: PeerAvatarAssembly): Pick<RemoteAvatar, 'shoulderLeft' | 'shoulderRight'> {
    const { scene, sessionId, pose, root, material, accentMaterial, bodyScale } = assembly;
    const profile = pose.avatarProfile;
    const shoulderWidth = profile?.shoulderStyle === 'riot-shields'
        ? 0.56
        : profile?.shoulderStyle === 'spike-rack'
        ? 0.48
        : profile?.shoulderStyle === 'reactor-pauldrons'
        ? 0.5
        : 0.4;
    const shoulderLeft = MeshBuilder.CreateBox(`remote-shoulder-l-${sessionId}`, {
        width: shoulderWidth,
        height: 0.2,
        depth: 0.34
    }, scene);
    shoulderLeft.parent = root;
    shoulderLeft.position.set(-bodyScale.width * 0.68, -0.32, -0.02);
    shoulderLeft.rotation.z = profile?.shoulderStyle === 'spike-rack' ? -0.18 : 0;
    shoulderLeft.material = accentMaterial;

    const shoulderRight = MeshBuilder.CreateBox(`remote-shoulder-r-${sessionId}`, {
        width: shoulderWidth,
        height: 0.2,
        depth: 0.34
    }, scene);
    shoulderRight.parent = root;
    shoulderRight.position.set(bodyScale.width * 0.68, -0.32, -0.02);
    shoulderRight.rotation.z = profile?.shoulderStyle === 'spike-rack' ? 0.18 : 0;
    shoulderRight.material = accentMaterial;

    return { shoulderLeft, shoulderRight };
}

function createPeerArms(assembly: PeerAvatarAssembly): void {
    const { scene, sessionId, root, material, accentMaterial, bodyScale } = assembly;
    for (const side of [-1, 1] as const) {
        const arm = MeshBuilder.CreateBox(`remote-arm-${side < 0 ? 'l' : 'r'}-${sessionId}`, {
            width: 0.18,
            height: 0.82,
            depth: 0.22
        }, scene);
        arm.parent = root;
        arm.position.set(side * bodyScale.width * 0.74, -0.86, -0.02);
        arm.rotation.z = side * 0.08;
        arm.material = material;

        const forearm = MeshBuilder.CreateBox(`remote-forearm-${side < 0 ? 'l' : 'r'}-${sessionId}`, {
            width: 0.2,
            height: 0.42,
            depth: 0.26
        }, scene);
        forearm.parent = root;
        forearm.position.set(side * bodyScale.width * 0.8, -1.24, -0.08);
        forearm.material = accentMaterial;
    }
}

function createPeerExpression(assembly: PeerAvatarAssembly): void {
    const { scene, sessionId, pose, root, material, accentMaterial, bodyScale } = assembly;
    const profile = pose.avatarProfile;
    const browTilt = profile?.browShape === 'visor-scowl' || profile?.visorExpression === 'angry-v'
        ? 0.16
        : profile?.browShape === 'forked'
        ? 0.08
        : 0;
    for (const side of [-1, 1] as const) {
        const brow = MeshBuilder.CreateBox(`remote-brow-${side < 0 ? 'l' : 'r'}-${sessionId}`, {
            width: 0.26,
            height: 0.055,
            depth: 0.05
        }, scene);
        brow.parent = root;
        brow.position.set(side * 0.16, 0.28, -bodyScale.depth * 0.43);
        brow.rotation.z = side * -browTilt;
        brow.material = accentMaterial;
    }

    const mouth = MeshBuilder.CreateBox(`remote-mouth-${sessionId}`, {
        width: profile?.visorExpression === 'grim-smirk' ? 0.28 : 0.18,
        height: 0.035,
        depth: 0.045
    }, scene);
    mouth.parent = root;
    mouth.position.set(profile?.visorExpression === 'grim-smirk' ? 0.04 : 0, -0.08, -bodyScale.depth * 0.43);
    mouth.rotation.z = profile?.visorExpression === 'grim-smirk' ? -0.12 : 0;
    mouth.material = accentMaterial;
}

function createPeerAccessories(assembly: PeerAvatarAssembly): Pick<RemoteAvatar, 'trail' | 'decal' | 'ring'> {
    const { scene, sessionId, pose, root, material, accentMaterial } = assembly;
    const profile = pose.avatarProfile;
    const trail = MeshBuilder.CreatePlane(`remote-trail-${sessionId}`, {
        width: profile?.trailStyle === 'afterimage' ? 0.92 : 0.52,
        height: 1.28
    }, scene);
    trail.parent = root;
    trail.position.set(0, -0.62, 0.42);
    trail.rotation.x = Math.PI / 2;
    trail.material = accentMaterial;
    trail.setEnabled(profile?.trailStyle !== 'none');

    const decal = MeshBuilder.CreateBox(`remote-decal-${sessionId}`, {
        width: 0.2,
        height: 0.2,
        depth: 0.045
    }, scene);
    decal.parent = root;
    decal.position.set(0, -0.52, -0.34);
    decal.material = accentMaterial;

    const ring = MeshBuilder.CreateTorus(`remote-floor-ring-${sessionId}`, {
        diameter: 1.05,
        thickness: 0.025,
        tessellation: 32
    }, scene);
    ring.parent = root;
    ring.position.y = -1.55;
    ring.rotation.x = Math.PI / 2;
    ring.material = accentMaterial;

    return { trail, decal, ring };
}

function createPeerLabels(
    assembly: PeerAvatarAssembly
): Pick<RemoteAvatar, 'label' | 'labelTexture' | 'health' | 'healthMaterial'> {
    const { scene, sessionId, pose, root, material } = assembly;
    const profile = pose.avatarProfile;
    const labelTexture = new DynamicTexture(`label-texture-${sessionId}`, {
        width: 512,
        height: 128
    }, scene);
    labelTexture.hasAlpha = true;
    updateLabel({
        texture: labelTexture,
        username: pose.username,
        score: pose.score,
        combo: pose.combo ?? 0,
        color: pose.color,
        vitals: undefined,
        weaponKind: undefined,
        profile: profile
    });

    const labelMaterial = new StandardMaterial(`label-mat-${sessionId}`, scene);
    labelMaterial.diffuseTexture = labelTexture;
    labelMaterial.emissiveTexture = labelTexture;
    labelMaterial.opacityTexture = labelTexture;
    labelMaterial.backFaceCulling = false;

    const label = MeshBuilder.CreatePlane(`remote-label-${sessionId}`, {
        width: 2.35,
        height: 0.58
    }, scene);
    label.parent = root;
    label.position.y = 0.92;
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.material = labelMaterial;

    const healthMaterial = createMatrixMaterial({
        scene: scene,
        name: `remote-health-${sessionId}`,
        diffuseHex: ARENA_SCENE_THEME.acid,
        emissiveHex: ARENA_SCENE_THEME.acid,
        emissiveScale: 0.86,
        alpha: 0.92
    });
    const health = MeshBuilder.CreateBox(`remote-health-bar-${sessionId}`, {
        width: 1.1,
        height: 0.07,
        depth: 0.035
    }, scene);
    health.parent = root;
    health.position.set(0, 0.62, 0);
    health.material = healthMaterial;

    return { label, labelTexture, health, healthMaterial };
}

interface UpdateLabelInput {
    readonly texture: DynamicTexture;
    readonly username: string;
    readonly score: number;
    readonly combo: number;
    readonly color: string;
    readonly vitals?: PlayerArenaState['vitals'];
    readonly weaponKind?: string;
    readonly profile?: PlayerPose['avatarProfile'];
}

function updateLabel({ texture, username, score, combo, color, vitals, weaponKind, profile }: UpdateLabelInput): void {
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 512, 128);
    const accent = profile ? avatarAccentForPalette(profile.glowPalette) : color;
    const displayName = profile?.callsign || username;
    ctx.fillStyle = 'rgba(1, 8, 8, 0.82)';
    ctx.fillRect(10, 20, 492, 86);
    ctx.strokeStyle = ARENA_SCENE_THEME.cyan;
    ctx.globalAlpha = 0.34;
    ctx.lineWidth = 2;
    ctx.strokeRect(18, 28, 476, 70);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.strokeRect(10, 20, 492, 86);
    ctx.fillStyle = ARENA_SCENE_THEME.white;
    ctx.font = '600 34px system-ui, sans-serif';
    ctx.fillText(displayName.slice(0, 18), 34, 60);
    ctx.fillStyle = ARENA_SCENE_THEME.acid;
    ctx.font = '500 24px system-ui, sans-serif';
    const health = vitals ? ` hp ${Math.ceil(vitals.health)}` : '';
    const weapon = weaponKind ? ` ${weaponKind.replace('-', ' ')}` : '';
    const tag = profile ? ` ${profile.humourTag}` : '';
    ctx.fillText(`score ${score}  x${combo}${health}${weapon}${tag}`.slice(0, 42), 34, 92);
    texture.update();
}
