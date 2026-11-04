import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { type StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

import { type RelicDefinition, type RelicPublicSnapshot, type RelicRoom } from '@relic-hunters/mod.ts';

import { RELIC_NEON_THEME } from '../neonTheme.ts';
import { facilityRoomPosition } from '../relic-scene-model.ts';
import { attachNeonMesh, createLabelMaterial, writeWrappedText } from './relic-materials.ts';
import { type RelicSceneRuntime } from './relic-scene-runtime.ts';
import { hashText, ROOM_HALF_ROAM } from './relic-scene-space.ts';

export interface RelicBundle {
    relicId: string;
    roomId: string;
    root: TransformNode;
    parts: Mesh[];
    label: Mesh;
    labelTexture: DynamicTexture;
    labelMaterial: StandardMaterial;
    baseY: number;
}

export interface RelicPickupPrompt {
    readonly relicId: string;
    readonly name: string;
    readonly value: number;
}

export function syncRelics(runtime: RelicSceneRuntime, snapshot: RelicPublicSnapshot): void {
    const visibleRelics = snapshot.relics.filter((relic) => !relic.carriedBy && !relic.escapedBy);
    const visibleIds = new Set(visibleRelics.map((relic) => relic.id));
    for (const [relicId, bundle] of runtime.relics.entries()) {
        if (!visibleIds.has(relicId)) {
            bundle.root.dispose();
            bundle.labelTexture.dispose();
            bundle.labelMaterial.dispose();
            runtime.relics.delete(relicId);
        }
    }

    for (const relic of visibleRelics) {
        const room = snapshot.map.find((candidate) => candidate.id === relic.roomId);
        if (!room || room.collapsed) {
            continue;
        }
        let bundle = runtime.relics.get(relic.id);
        if (!bundle) {
            bundle = createRelicBundle(runtime, relic, room);
            runtime.relics.set(relic.id, bundle);
        }
        bundle.roomId = relic.roomId;
        for (const part of bundle.parts) {
            part.metadata = { relicId: relic.id, roomId: relic.roomId };
        }
        updateRelicLabel(bundle, relic);
        const roomPosition = facilityRoomPosition(room);
        const localOffset = computeRelicLocalOffset(relic);
        bundle.root.position.set(roomPosition.x + localOffset.x, bundle.baseY, roomPosition.z + localOffset.z);
        bundle.root.setEnabled(snapshot.phase === 'planning' || snapshot.phase === 'review');
    }
}

interface RelicLabel {
    readonly label: Mesh;
    readonly labelTexture: DynamicTexture;
    readonly labelMaterial: StandardMaterial;
}

function createRelicBundle(runtime: RelicSceneRuntime, relic: RelicDefinition, room: RelicRoom): RelicBundle {
    const root = new TransformNode(`facility-relic-${relic.id}`, runtime.scene);
    const accentMaterial = relic.value >= 7
        ? runtime.materials.magenta
        : relic.value >= 4
        ? runtime.materials.amber
        : room.kind === 'monster' || room.kind === 'trap'
        ? runtime.materials.danger
        : runtime.materials.cyan;
    const parts = createRelicParts({ runtime, root, accentMaterial, relic });
    for (const part of parts) {
        part.metadata = { relicId: relic.id, roomId: relic.roomId };
    }
    const label = createRelicLabel(runtime, root, relic);
    return { relicId: relic.id, roomId: relic.roomId, root, parts: [...parts, label.label], ...label, baseY: 0.68 };
}

interface RelicPartsInput {
    readonly runtime: RelicSceneRuntime;
    readonly root: TransformNode;
    readonly accentMaterial: PBRMaterial;
    readonly relic: RelicDefinition;
}

function createRelicParts({ runtime, root, accentMaterial, relic }: RelicPartsInput): Mesh[] {
    const pedestal = attachNeonMesh(
        root,
        MeshBuilder.CreateCylinder(
            `facility-relic-${relic.id}-pedestal`,
            { diameter: 1.0, height: 0.42, tessellation: 8 },
            runtime.scene
        ),
        runtime.materials.wall
    );
    pedestal.position.y = -0.2;

    const ring = attachNeonMesh(
        root,
        MeshBuilder.CreateTorus(
            `facility-relic-${relic.id}-pickup-ring`,
            { diameter: 1.34, thickness: 0.045, tessellation: 40 },
            runtime.scene
        ),
        accentMaterial
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.08;

    const core = attachNeonMesh(
        root,
        MeshBuilder.CreateSphere(
            `facility-relic-${relic.id}-core`,
            { diameter: 0.54 + Math.min(0.28, relic.value * 0.025), segments: 16 },
            runtime.scene
        ),
        accentMaterial
    );
    core.position.y = 0.5;

    const shard = attachNeonMesh(
        root,
        MeshBuilder.CreateBox(
            `facility-relic-${relic.id}-shard`,
            { width: 0.18, height: 0.98, depth: 0.18 },
            runtime.scene
        ),
        runtime.materials.white
    );
    shard.position.y = 0.78;
    shard.rotation.set(0.34, 0.44, 0.23);

    return [pedestal, ring, core, shard];
}

function createRelicLabel(runtime: RelicSceneRuntime, root: TransformNode, relic: RelicDefinition): RelicLabel {
    const labelTexture = new DynamicTexture(
        `facility-relic-${relic.id}-label-texture`,
        { width: 512, height: 160 },
        runtime.scene,
        false
    );
    const label = MeshBuilder.CreatePlane(
        `facility-relic-${relic.id}-label`,
        { width: 2.55, height: 0.8 },
        runtime.scene
    );
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.parent = root;
    label.position.y = 1.64;
    const labelMaterial = createLabelMaterial(runtime.scene, `facility-relic-${relic.id}-label-material`, labelTexture);
    label.material = labelMaterial;
    label.metadata = { relicId: relic.id, roomId: relic.roomId };
    updateRelicLabel({ labelTexture }, relic);

    return { label, labelTexture, labelMaterial };
}

function updateRelicLabel(
    bundle: Pick<RelicBundle, 'labelTexture'>,
    relic: Pick<RelicDefinition, 'name' | 'value'>
): void {
    const drawing = bundle.labelTexture.getContext();
    drawing.clearRect(0, 0, 512, 160);
    drawing.fillStyle = 'rgba(4, 9, 21, 0.88)';
    drawing.fillRect(0, 0, 512, 160);
    drawing.strokeStyle = relic.value >= 7
        ? RELIC_NEON_THEME.magenta
        : relic.value >= 4
        ? RELIC_NEON_THEME.amber
        : RELIC_NEON_THEME.cyan;
    drawing.lineWidth = 5;
    drawing.strokeRect(5, 5, 502, 150);
    drawing.fillStyle = '#f8fdff';
    drawing.font = '800 28px monospace';
    writeWrappedText({ drawing: drawing, text: relic.name, x: 22, y: 42, maxWidth: 468, lineHeight: 30 });
    drawing.fillStyle = '#ffe66d';
    drawing.font = '800 22px monospace';
    drawing.fillText(`${relic.value} PTS / DO NOT ENJOY`, 22, 134);
    bundle.labelTexture.update();
}

export interface RelicLocalOffset {
    readonly x: number;
    readonly z: number;
}

export function computeRelicLocalOffset(
    relic: Pick<RelicDefinition, 'id' | 'value'>
): RelicLocalOffset {
    const hash = hashText(relic.id);
    const angle = (hash % 360) * Math.PI / 180;
    const radius = Math.min(ROOM_HALF_ROAM - 0.9, 2.15 + (hash % 7) * 0.24 + Math.min(0.7, relic.value * 0.04));
    return {
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius
    };
}

export function updateRelicMeshes(runtime: RelicSceneRuntime): void {
    const snapshot = runtime.snapshot.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === runtime.localPlayerId.value);
    const localAvatar = localPlayer ? runtime.avatars.get(localPlayer.playerId) : undefined;
    let nearby: RelicPickupPrompt | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    const now = performance.now();

    for (const [relicId, bundle] of runtime.relics.entries()) {
        const relic = snapshot?.relics.find((candidate) => candidate.id === relicId);
        if (!snapshot || !relic || relic.carriedBy || relic.escapedBy) {
            continue;
        }
        const pulse = 1 + Math.sin(runtime.pulsePhase.value * 4.1 + hashText(relic.id) * 0.01) * 0.06;
        bundle.root.rotation.y += runtime.engine.getDeltaTime() / 1000 * (0.42 + relic.value * 0.012);
        bundle.root.position.y = bundle.baseY + Math.sin(now / 360 + relic.value) * 0.08;
        for (const part of bundle.parts) {
            if (part !== bundle.label) {
                part.scaling.setAll(pulse);
            }
        }
        if (
            snapshot.phase === 'planning' &&
            localPlayer &&
            localAvatar &&
            localPlayer.roomId === relic.roomId &&
            !localPlayer.escaped &&
            !localPlayer.defeated
        ) {
            const distance = Vector3.Distance(localAvatar.root.position, bundle.root.position);
            if (distance <= PICKUP_RADIUS && distance < nearestDistance) {
                nearestDistance = distance;
                nearby = {
                    relicId: relic.id,
                    name: relic.name,
                    value: relic.value
                };
            }
        }
    }

    if (runtime.nearbyRelic.value?.relicId !== nearby?.relicId) {
        runtime.nearbyRelic.value = nearby;
        runtime.onPickupPromptChange.value(nearby);
    }
}

const PICKUP_RADIUS = 1.55;

export function computeRelicCuePosition(snapshot: RelicPublicSnapshot, relicId: string): Vector3 | undefined {
    const relic = snapshot.relics.find((candidate) => candidate.id === relicId);
    const room = relic ? snapshot.map.find((candidate) => candidate.id === relic.roomId) : undefined;
    if (!relic || !room) {
        return undefined;
    }
    const base = facilityRoomPosition(room);
    const offset = computeRelicLocalOffset(relic);
    return new Vector3(base.x + offset.x, 0.6, base.z + offset.z);
}
