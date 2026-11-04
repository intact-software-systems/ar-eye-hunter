import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { type StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

import { type RelicPublicSnapshot, type RelicRoom } from '@relic-hunters/mod.ts';

import { relicNeonAccentForRoom } from '../neonTheme.ts';
import {
    blackHumourSignForRoom,
    facilityRoomCallsign,
    facilityRoomPosition
} from '../relic-scene-model.ts';
import { createRoomAccentMaterial, createTextMaterial } from './relic-materials.ts';
import { type RelicSceneRuntime } from './relic-scene-runtime.ts';
import { NEON_ROOM_GRID_SCALE, ROOM_FLOOR_SIZE } from './relic-scene-space.ts';

interface CreateRoomRailsInput {
    readonly runtime: RelicSceneRuntime;
    readonly room: RelicRoom;
    readonly root: TransformNode;
    readonly accent: PBRMaterial;
}

interface CreateRoomSignInput {
    readonly runtime: RelicSceneRuntime;
    readonly room: RelicRoom;
    readonly root: TransformNode;
    readonly accent: PBRMaterial;
}

export interface RoomBundle {
    roomId: string;
    root: TransformNode;
    floor: Mesh;
    accent: PBRMaterial;
    light: PointLight;
    signMaterial: StandardMaterial;
}

export function createWorldBase(runtime: RelicSceneRuntime): void {
    const { scene, materials } = runtime;
    const baseSize = 240;
    const base = MeshBuilder.CreateGround(
        'neon-dystopia-base-grid',
        { width: baseSize, height: baseSize, subdivisions: 2 },
        scene
    );
    base.position.y = -0.06;
    base.material = materials.floor;

    for (let index = -8; index <= 8; index += 1) {
        const xStrip = MeshBuilder.CreateBox(
            `base-grid-x-${index}`,
            { width: 0.035, height: 0.018, depth: baseSize },
            scene
        );
        xStrip.position.set(index * NEON_ROOM_GRID_SCALE, 0.02, 0);
        xStrip.material = index === 0 ? materials.magenta : materials.cyan;
        const zStrip = MeshBuilder.CreateBox(
            `base-grid-z-${index}`,
            { width: baseSize, height: 0.018, depth: 0.035 },
            scene
        );
        zStrip.position.set(0, 0.022, index * NEON_ROOM_GRID_SCALE);
        zStrip.material = index === 0 ? materials.magenta : materials.cyan;
    }
}

export function rebuildFacility(runtime: RelicSceneRuntime, snapshot: RelicPublicSnapshot): void {
    clearFacility(runtime);
    const roomById = new Map(snapshot.map.map((room) => [room.id, room]));

    for (const room of snapshot.map) {
        runtime.rooms.set(room.id, createRoomBundle(runtime, room));
    }

    const seenEdges = new Set<string>();
    for (const room of snapshot.map) {
        for (const neighborId of room.neighbors) {
            const neighbor = roomById.get(neighborId);
            if (!neighbor) {
                continue;
            }
            const key = [room.id, neighbor.id].sort().join(':');
            if (seenEdges.has(key)) {
                continue;
            }
            seenEdges.add(key);
            runtime.transientMeshes.push(...createCorridor(runtime, room, neighbor));
        }
    }
}

export function clearFacility(runtime: RelicSceneRuntime): void {
    for (const bundle of runtime.rooms.values()) {
        bundle.light.dispose();
        bundle.accent.dispose();
        bundle.signMaterial.dispose(false, true);
        bundle.root.dispose();
    }
    runtime.rooms.clear();
    runtime.mapKey.value = undefined;
    for (const mesh of runtime.transientMeshes) {
        mesh.dispose();
    }
    runtime.transientMeshes = [];
}

function createRoomBundle(runtime: RelicSceneRuntime, room: RelicRoom): RoomBundle {
    const { scene, materials } = runtime;
    const root = new TransformNode(`facility-room-${room.id}`, scene);
    const position = facilityRoomPosition(room);
    root.position.set(position.x, 0, position.z);

    const accent = createRoomAccentMaterial(scene, room);
    const skirt = MeshBuilder.CreateBox(
        `facility-room-${room.id}-skirt`,
        { width: ROOM_FLOOR_SIZE + 0.62, height: 0.7, depth: ROOM_FLOOR_SIZE + 0.62 },
        scene
    );
    skirt.position.y = -0.38;
    skirt.material = materials.wall;
    skirt.parent = root;

    const floor = MeshBuilder.CreateBox(
        `facility-room-${room.id}-floor`,
        { width: ROOM_FLOOR_SIZE, height: 0.24, depth: ROOM_FLOOR_SIZE },
        scene
    );
    floor.position.y = 0.08;
    floor.material = room.collapsed ? materials.danger : materials.floorPanel;
    floor.metadata = { roomId: room.id };
    floor.parent = root;

    const inset = MeshBuilder.CreateBox(
        `facility-room-${room.id}-inset`,
        { width: ROOM_FLOOR_SIZE - 1.2, height: 0.035, depth: ROOM_FLOOR_SIZE - 1.2 },
        scene
    );
    inset.position.y = 0.235;
    inset.material = accent;
    inset.metadata = { roomId: room.id };
    inset.parent = root;

    createRoomRails({ runtime: runtime, room: room, root: root, accent: accent });
    createHologlassWalls(runtime, room, root);
    const signMaterial = createRoomSign({ runtime: runtime, room: room, root: root, accent: accent });
    createSearchKiosk(runtime, room, root);
    const light = new PointLight(
        `facility-room-${room.id}-accent-light`,
        new Vector3(position.x, 3.2, position.z),
        scene
    );
    light.diffuse = Color3.FromHexString(relicNeonAccentForRoom(room).emissive);
    light.range = 18;
    light.intensity = room.collapsed ? 5 : room.unstable ? 10 : 7.4;

    return {
        roomId: room.id,
        root,
        floor,
        accent,
        light,
        signMaterial
    };
}

interface RoomStrip {
    readonly name: string;
    readonly width: number;
    readonly depth: number;
    readonly x: number;
    readonly z: number;
}

interface RoomStripInput {
    readonly runtime: RelicSceneRuntime;
    readonly room: RelicRoom;
    readonly root: TransformNode;
    readonly material: PBRMaterial;
    readonly height: number;
    readonly y: number;
    readonly strip: RoomStrip;
}

function createRoomRails({ runtime, room, root, accent }: CreateRoomRailsInput): void {
    const halfFloor = ROOM_FLOOR_SIZE / 2;
    const strips: readonly RoomStrip[] = [
        { name: 'rail-n', width: ROOM_FLOOR_SIZE, depth: 0.08, x: 0, z: -halfFloor },
        { name: 'rail-s', width: ROOM_FLOOR_SIZE, depth: 0.08, x: 0, z: halfFloor },
        { name: 'rail-e', width: 0.08, depth: ROOM_FLOOR_SIZE, x: halfFloor, z: 0 },
        { name: 'rail-w', width: 0.08, depth: ROOM_FLOOR_SIZE, x: -halfFloor, z: 0 }
    ];
    for (const strip of strips) {
        createRoomStrip({ runtime, room, root, material: accent, height: 0.07, y: 0.31, strip });
    }
}

function createHologlassWalls(runtime: RelicSceneRuntime, room: RelicRoom, root: TransformNode): void {
    const doorGap = 3.35;
    const length = Math.max(1.8, (ROOM_FLOOR_SIZE - doorGap) / 2 - 0.28);
    const offset = doorGap / 2 + length / 2 + 0.08;
    const halfFloor = ROOM_FLOOR_SIZE / 2;
    const strips: readonly RoomStrip[] = [
        { name: 'wall-n-left', width: length, depth: 0.08, x: -offset, z: -halfFloor },
        { name: 'wall-n-right', width: length, depth: 0.08, x: offset, z: -halfFloor },
        { name: 'wall-s-left', width: length, depth: 0.08, x: -offset, z: halfFloor },
        { name: 'wall-s-right', width: length, depth: 0.08, x: offset, z: halfFloor },
        { name: 'wall-e-top', width: 0.08, depth: length, x: halfFloor, z: -offset },
        { name: 'wall-e-bottom', width: 0.08, depth: length, x: halfFloor, z: offset },
        { name: 'wall-w-top', width: 0.08, depth: length, x: -halfFloor, z: -offset },
        { name: 'wall-w-bottom', width: 0.08, depth: length, x: -halfFloor, z: offset }
    ];
    for (const strip of strips) {
        createRoomStrip({ runtime, room, root, material: runtime.materials.glass, height: 2.45, y: 1.42, strip });
    }
    for (const [index, z] of [-doorGap, doorGap].entries()) {
        const rail = MeshBuilder.CreateBox(`facility-room-${room.id}-ceiling-rail-${index}`, {
            width: ROOM_FLOOR_SIZE - 0.6,
            height: 0.06,
            depth: 0.08
        }, runtime.scene);
        rail.position.set(0, 2.86, z);
        rail.material = runtime.materials.white;
        rail.parent = root;
    }
}

function createRoomStrip({ runtime, room, root, material, height, y, strip }: RoomStripInput): Mesh {
    const mesh = MeshBuilder.CreateBox(`facility-room-${room.id}-${strip.name}`, {
        width: strip.width,
        height,
        depth: strip.depth
    }, runtime.scene);
    mesh.position.set(strip.x, y, strip.z);
    mesh.material = material;
    mesh.metadata = { roomId: room.id };
    mesh.parent = root;
    return mesh;
}

function createRoomSign({ runtime, room, root, accent }: CreateRoomSignInput): StandardMaterial {
    const signBack = MeshBuilder.CreateBox(
        `facility-room-${room.id}-sign-back`,
        { width: 3.7, height: 1.04, depth: 0.08 },
        runtime.scene
    );
    signBack.position.set(0, 2.34, -ROOM_FLOOR_SIZE / 2 - 0.05);
    signBack.material = accent;
    signBack.metadata = { roomId: room.id };
    signBack.parent = root;

    const sign = MeshBuilder.CreatePlane(`facility-room-${room.id}-sign`, { width: 3.46, height: 0.82 }, runtime.scene);
    sign.position.set(0, 2.34, -ROOM_FLOOR_SIZE / 2 - 0.11);
    sign.rotation.y = Math.PI;
    const material = createTextMaterial(runtime.scene, `sign-${room.id}`, {
        title: facilityRoomCallsign(room),
        detail: blackHumourSignForRoom(room),
        accent: relicNeonAccentForRoom(room).emissive
    });
    sign.material = material;
    sign.metadata = { roomId: room.id };
    sign.parent = root;
    return material;
}

function createSearchKiosk(
    runtime: RelicSceneRuntime,
    room: RelicRoom,
    root: TransformNode
): Mesh {
    const kiosk = MeshBuilder.CreateBox(
        `facility-room-${room.id}-kiosk`,
        { width: 0.72, height: 0.82, depth: 0.42 },
        runtime.scene
    );
    kiosk.position.set(-ROOM_FLOOR_SIZE / 2 + 0.86, 0.68, ROOM_FLOOR_SIZE / 2 - 0.9);
    kiosk.material = room.kind === 'trap' || room.unstable ? runtime.materials.danger : runtime.materials.cyan;
    kiosk.metadata = { roomId: room.id, primeAction: 'search' };
    kiosk.parent = root;
    return kiosk;
}

function createCorridor(
    runtime: RelicSceneRuntime,
    from: RelicRoom,
    to: RelicRoom
): Mesh[] {
    const a = facilityRoomPosition(from);
    const b = facilityRoomPosition(to);
    const mid = Vector3.Center(a, b);
    const dx = Math.abs(a.x - b.x);
    const dz = Math.abs(a.z - b.z);
    const alongX = dx >= dz;
    const length = Math.max(1.1, (alongX ? dx : dz) - ROOM_FLOOR_SIZE + 0.9);
    const floor = MeshBuilder.CreateBox(
        `facility-corridor-${from.id}-${to.id}`,
        {
            width: alongX ? length : 3.25,
            height: 0.18,
            depth: alongX ? 3.25 : length
        },
        runtime.scene
    );
    floor.position.set(mid.x, 0.12, mid.z);
    floor.material = runtime.materials.corridor;
    floor.metadata = { roomId: to.id };

    const seam = MeshBuilder.CreateBox(
        `facility-corridor-${from.id}-${to.id}-seam`,
        {
            width: alongX ? length : 0.12,
            height: 0.05,
            depth: alongX ? 0.12 : length
        },
        runtime.scene
    );
    seam.position.set(mid.x, 0.27, mid.z);
    seam.material = from.unstable || to.unstable ? runtime.materials.danger : runtime.materials.cyan;
    seam.metadata = { roomId: to.id };
    return [floor, seam];
}

export function updateRoomHighlights(runtime: RelicSceneRuntime): void {
    const snapshot = runtime.snapshot.value;
    const selectedRoomId = runtime.selectedRoomId.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === runtime.localPlayerId.value);
    for (const [roomId, bundle] of runtime.rooms.entries()) {
        const selected = roomId === selectedRoomId;
        const local = roomId === localPlayer?.roomId;
        const pulse = 0.18 + Math.sin(runtime.pulsePhase.value * 3.2) * 0.08;
        bundle.accent.emissiveColor = Color3.FromHexString(
            relicNeonAccentForRoom(
                snapshot?.map.find((room) => room.id === roomId) ?? {
                    kind: 'hallway',
                    collapsed: false,
                    unstable: false
                }
            ).emissive
        ).scale(selected ? 1.45 : local ? 1.05 : 0.62 + pulse);
        bundle.floor.scaling.y = selected ? 1.32 : 1;
    }
}
