import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';

import { type RelicCharacter, type RelicPlayer, type RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import { findRelicCharacter } from '@relic-hunters/mod.ts';

import { RELIC_NEON_THEME } from '../neonTheme.ts';
import { facilityRoomPosition } from '../relic-scene-model.ts';
import {
    attachNeonMesh,
    createEmissiveMaterial,
    createLabelMaterial,
    type FacilityMaterials
} from './relic-materials.ts';
import { type RelicSceneRuntime } from './relic-scene-runtime.ts';
import { AVATAR_Y } from './relic-scene-space.ts';

export interface AvatarBundle {
    playerId: string;
    root: TransformNode;
    parts: Mesh[];
    ring: Mesh;
    label: Mesh;
    labelTexture: DynamicTexture;
    materials: readonly StandardMaterial[];
    trail: Mesh;
    target: Vector3;
    lastPosition: Vector3;
    lastMovedAtMs: number;
}

export interface FirstPersonRig {
    root: TransformNode;
}

export function createFirstPersonRig(
    scene: Scene,
    camera: UniversalCamera,
    materials: FacilityMaterials
): FirstPersonRig {
    const root = new TransformNode('neon-visor-rig', scene);
    root.parent = camera;
    root.position.set(0, 0, 0);
    root.setEnabled(false);
    const leftHand = attachNeonMesh(
        root,
        MeshBuilder.CreateBox('neon-visor-left-hand', { width: 0.22, height: 0.16, depth: 0.54 }, scene),
        materials.magenta
    );
    leftHand.position.set(-0.46, -0.44, 1.08);
    leftHand.rotation.set(0.18, -0.32, 0.28);

    const rightHand = attachNeonMesh(
        root,
        MeshBuilder.CreateBox('neon-visor-right-hand', { width: 0.24, height: 0.16, depth: 0.62 }, scene),
        materials.cyan
    );
    rightHand.position.set(0.42, -0.48, 1.02);
    rightHand.rotation.set(0.18, 0.28, -0.22);

    const blade = attachNeonMesh(
        root,
        MeshBuilder.CreateBox('neon-visor-katana-edge', { width: 0.045, height: 0.055, depth: 1.36 }, scene),
        materials.white
    );
    blade.position.set(0.64, -0.36, 1.55);
    blade.rotation.set(0.08, -0.35, 0.08);

    const scanner = attachNeonMesh(
        root,
        MeshBuilder.CreateBox('neon-visor-compliance-scanner', { width: 0.34, height: 0.12, depth: 0.34 }, scene),
        materials.amber
    );
    scanner.position.set(-0.66, -0.36, 1.32);
    scanner.rotation.set(0.12, 0.3, -0.16);

    return { root };
}

export function syncAvatars(runtime: RelicSceneRuntime, snapshot: RelicPublicSnapshot): void {
    const activePlayerIds = new Set(snapshot.players.map((player) => player.playerId));
    for (const [playerId, avatar] of runtime.avatars.entries()) {
        if (!activePlayerIds.has(playerId)) {
            disposeAvatar(avatar);
            runtime.avatars.delete(playerId);
        }
    }

    for (const player of snapshot.players) {
        if (!runtime.avatars.has(player.playerId)) {
            runtime.avatars.set(player.playerId, createAvatarBundle(runtime, player));
        }
        const avatar = runtime.avatars.get(player.playerId)!;
        updateAvatarLabel(avatar, findRelicCharacter(player.characterId), player);
        avatar.target.copyFrom(computeSnapshotPlayerPosition(snapshot, player));
        if (player.escaped || player.defeated) {
            avatar.root.setEnabled(false);
        }
        else {
            avatar.root.setEnabled(true);
        }
    }

    const localPlayer = snapshot.players.find((player) => player.playerId === runtime.localPlayerId.value);
    if (localPlayer && runtime.roamRoomId.value !== localPlayer.roomId) {
        runtime.roamRoomId.value = localPlayer.roomId;
        runtime.roamOffset.set(0, 0, 0);
        runtime.motion.buffer.remove(localPlayer.playerId);
        runtime.motion.kinematics.remove(localPlayer.playerId);
    }
}

interface AvatarConstruction {
    readonly runtime: RelicSceneRuntime;
    readonly player: RelicPlayer;
    readonly character: RelicCharacter;
    readonly root: TransformNode;
    readonly accentMaterial: StandardMaterial;
    readonly visorMaterial: StandardMaterial;
    readonly armorMaterial: PBRMaterial;
}

interface AvatarLabel {
    readonly label: Mesh;
    readonly labelTexture: DynamicTexture;
    readonly material: StandardMaterial;
}

interface AvatarAccessories extends AvatarLabel {
    readonly ring: Mesh;
    readonly trail: Mesh;
    readonly parts: Mesh[];
}

function createAvatarBundle(runtime: RelicSceneRuntime, player: RelicPlayer): AvatarBundle {
    const character = findRelicCharacter(player.characterId);
    const root = new TransformNode(`neon-ronin-${player.playerId}`, runtime.scene);
    const accent = character.colors.accent;
    const accentMaterial = createEmissiveMaterial({
        scene: runtime.scene,
        name: `ronin-${player.playerId}-accent`,
        diffuse: '#06111f',
        emissive: accent,
        emissiveScale: 1.2
    });
    const visorMaterial = createEmissiveMaterial({
        scene: runtime.scene,
        name: `ronin-${player.playerId}-visor`,
        diffuse: '#041018',
        emissive: RELIC_NEON_THEME.cyanSoft,
        emissiveScale: 1.4
    });
    const armorMaterial = runtime.materials.avatarCore;
    const construction: AvatarConstruction = {
        runtime,
        player,
        character,
        root,
        accentMaterial,
        visorMaterial,
        armorMaterial
    };
    const accessories = createAvatarAccessories(construction);
    const parts = [...createAvatarBody(construction), ...createAvatarLimbs(construction), ...accessories.parts];
    const target = computeSnapshotPlayerPosition(runtime.snapshot.value, player);
    root.position.copyFrom(target);
    return {
        playerId: player.playerId,
        root,
        parts,
        ring: accessories.ring,
        trail: accessories.trail,
        label: accessories.label,
        labelTexture: accessories.labelTexture,
        materials: [accentMaterial, visorMaterial, accessories.material],
        target,
        lastPosition: target.clone(),
        lastMovedAtMs: performance.now()
    };
}

function createAvatarBody(
    { runtime, player, root, accentMaterial, visorMaterial, armorMaterial }: AvatarConstruction
): Mesh[] {
    const torso = attachNeonMesh(
        root,
        MeshBuilder.CreateBox(
            `ronin-${player.playerId}-torso`,
            { width: 0.82, height: 1.18, depth: 0.42 },
            runtime.scene
        ),
        armorMaterial
    );
    torso.position.y = 0.92;

    const chestTrim = attachNeonMesh(
        root,
        MeshBuilder.CreateBox(
            `ronin-${player.playerId}-chest-trim`,
            { width: 0.9, height: 0.08, depth: 0.46 },
            runtime.scene
        ),
        accentMaterial
    );
    chestTrim.position.y = 1.22;

    const head = attachNeonMesh(
        root,
        MeshBuilder.CreateSphere(
            `ronin-${player.playerId}-helmet`,
            { diameterX: 0.62, diameterY: 0.5, diameterZ: 0.58, segments: 14 },
            runtime.scene
        ),
        armorMaterial
    );
    head.position.y = 1.72;

    const visor = attachNeonMesh(
        root,
        MeshBuilder.CreateBox(
            `ronin-${player.playerId}-visor`,
            { width: 0.58, height: 0.08, depth: 0.06 },
            runtime.scene
        ),
        visorMaterial
    );
    visor.position.set(0, 1.72, -0.3);

    return [torso, chestTrim, head, visor];
}

function createAvatarLimbs({ runtime, player, root, accentMaterial, armorMaterial }: AvatarConstruction): Mesh[] {
    const parts: Mesh[] = [];
    for (const side of [-1, 1]) {
        const shoulder = attachNeonMesh(
            root,
            MeshBuilder.CreateBox(
                `ronin-${player.playerId}-shoulder-${side}`,
                { width: 0.28, height: 0.22, depth: 0.42 },
                runtime.scene
            ),
            accentMaterial
        );
        shoulder.position.set(side * 0.58, 1.33, 0);

        const arm = attachNeonMesh(
            root,
            MeshBuilder.CreateBox(
                `ronin-${player.playerId}-arm-${side}`,
                { width: 0.16, height: 0.76, depth: 0.18 },
                runtime.scene
            ),
            armorMaterial
        );
        arm.position.set(side * 0.64, 0.86, 0);

        const leg = attachNeonMesh(
            root,
            MeshBuilder.CreateBox(
                `ronin-${player.playerId}-leg-${side}`,
                { width: 0.22, height: 0.72, depth: 0.24 },
                runtime.scene
            ),
            armorMaterial
        );
        leg.position.set(side * 0.22, 0.22, 0);

        const blade = attachNeonMesh(
            root,
            MeshBuilder.CreateBox(
                `ronin-${player.playerId}-blade-${side}`,
                { width: 0.06, height: 1.15, depth: 0.08 },
                runtime.scene
            ),
            accentMaterial
        );
        blade.position.set(side * 0.82, 0.76, 0.24);
        blade.rotation.z = side * 0.24;
        parts.push(shoulder, arm, leg, blade);
    }

    return parts;
}

function createAvatarAccessories(construction: AvatarConstruction): AvatarAccessories {
    const { runtime, player, root, accentMaterial } = construction;
    const ring = attachNeonMesh(
        root,
        MeshBuilder.CreateTorus(
            `ronin-${player.playerId}-floor-ring`,
            { diameter: 1.62, thickness: 0.045, tessellation: 36 },
            runtime.scene
        ),
        accentMaterial
    );
    ring.position.y = 0.045;
    ring.rotation.x = Math.PI / 2;

    const trail = attachNeonMesh(
        root,
        MeshBuilder.CreateBox(
            `ronin-${player.playerId}-motion-trail`,
            { width: 0.34, height: 0.06, depth: 1.4 },
            runtime.scene
        ),
        accentMaterial
    );
    trail.position.set(0, 0.18, 0.74);
    trail.setEnabled(false);

    return { ...createAvatarLabel(construction), ring, trail, parts: [ring, trail] };
}

function createAvatarLabel({ runtime, player, character, root }: AvatarConstruction): AvatarLabel {
    const labelTexture = new DynamicTexture(
        `ronin-${player.playerId}-label-texture`,
        { width: 512, height: 128 },
        runtime.scene,
        false
    );
    const label = MeshBuilder.CreatePlane(
        `ronin-${player.playerId}-label`,
        { width: 2.3, height: 0.58 },
        runtime.scene
    );
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.parent = root;
    label.position.y = 2.25;
    const material = createLabelMaterial(runtime.scene, `ronin-${player.playerId}-label-material`, labelTexture);
    label.material = material;
    updateAvatarLabel({ labelTexture }, character, player);

    return { label, labelTexture, material };
}

function computeSnapshotPlayerPosition(
    snapshot: RelicPublicSnapshot | undefined,
    player: RelicPlayer
): Vector3 {
    const room = snapshot?.map.find((candidate) => candidate.id === player.roomId);
    if (!snapshot || !room) {
        return new Vector3(0, AVATAR_Y, 0);
    }
    const world = facilityRoomPosition(room);
    const sameRoomIndex = snapshot.players
        .filter((candidate) => candidate.roomId === player.roomId && !candidate.escaped && !candidate.defeated)
        .findIndex((candidate) => candidate.playerId === player.playerId);
    const angle = (sameRoomIndex / 4) * Math.PI * 2;
    const radius = sameRoomIndex <= 0 ? 0 : 0.72;
    return new Vector3(
        world.x + Math.cos(angle) * radius,
        AVATAR_Y,
        world.z + Math.sin(angle) * radius
    );
}

function updateAvatarLabel(
    avatar: Pick<AvatarBundle, 'labelTexture'>,
    character: RelicCharacter,
    player: RelicPlayer
): void {
    const drawing = avatar.labelTexture.getContext();
    drawing.clearRect(0, 0, 512, 128);
    drawing.fillStyle = 'rgba(5, 12, 22, 0.78)';
    drawing.fillRect(0, 0, 512, 128);
    drawing.strokeStyle = character.colors.accent;
    drawing.lineWidth = 5;
    drawing.strokeRect(4, 4, 504, 120);
    drawing.fillStyle = '#eefcff';
    drawing.font = '700 34px monospace';
    drawing.fillText(player.username.slice(0, 18), 22, 50);
    drawing.fillStyle = '#9eeaff';
    drawing.font = '600 24px monospace';
    drawing.fillText(character.role.toUpperCase(), 22, 91);
    avatar.labelTexture.update();
}

function disposeAvatar(avatar: AvatarBundle): void {
    avatar.root.dispose();
    avatar.labelTexture.dispose();
    for (const material of avatar.materials) {
        material.dispose();
    }
}
