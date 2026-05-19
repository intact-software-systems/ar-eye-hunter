import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';
import { WORLD_SCALE } from './constants.ts';

export type RelicCameraMode = 'lobby' | 'tactical' | 'roam' | 'inspection' | 'event-focus';

export type RelicCameraPose = Readonly<{
    position: Vector3;
    target: Vector3;
    fov: number;
}>;

export function deriveRelicCameraMode({
    snapshot,
    localPlayerId,
    isRoaming,
    isInspecting,
    focusRoomId,
}: Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    isRoaming: boolean;
    isInspecting: boolean;
    focusRoomId?: string;
}>): RelicCameraMode {
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    if (!snapshot || !localPlayer || snapshot.phase === 'lobby') {
        return 'lobby';
    }

    if (isInspecting) {
        return 'inspection';
    }

    if (isRoaming) {
        return 'roam';
    }

    if (snapshot.phase === 'planning') {
        return 'tactical';
    }

    return focusRoomId ? 'event-focus' : 'roam';
}

export function planTacticalCameraPose({
    snapshot,
    currentRoom,
    selectedRoomId,
    objectiveTargetRoomId,
    aspectRatio,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    currentRoom: RelicRoom;
    selectedRoomId?: string;
    objectiveTargetRoomId?: string;
    aspectRatio: number;
}>): RelicCameraPose {
    const rooms = tacticalFocusRooms({
        snapshot,
        currentRoom,
        selectedRoomId,
        objectiveTargetRoomId,
    });
    const positions = rooms.map(roomWorldPositionForCamera);
    const minX = Math.min(...positions.map((position) => position.x));
    const maxX = Math.max(...positions.map((position) => position.x));
    const minZ = Math.min(...positions.map((position) => position.z));
    const maxZ = Math.max(...positions.map((position) => position.z));
    const center = new Vector3((minX + maxX) / 2, 0.78, (minZ + maxZ) / 2);
    const paddedWidth = Math.max(WORLD_SCALE * 1.8, maxX - minX + WORLD_SCALE * 1.6);
    const paddedDepth = Math.max(WORLD_SCALE * 1.8, maxZ - minZ + WORLD_SCALE * 1.6);
    const correctedWidth = paddedWidth / Math.max(0.74, aspectRatio || 1);
    const span = Math.max(correctedWidth, paddedDepth);
    const distance = clamp(span * 0.62 + 11, 17, 62);
    const height = clamp(span * 0.48 + 13, 16, 54);

    return {
        position: new Vector3(
            center.x - distance * 0.58,
            height,
            center.z - distance * 0.82,
        ),
        target: center,
        fov: 0.72,
    };
}

export function tacticalFocusRooms({
    snapshot,
    currentRoom,
    selectedRoomId,
    objectiveTargetRoomId,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    currentRoom: RelicRoom;
    selectedRoomId?: string;
    objectiveTargetRoomId?: string;
}>): readonly RelicRoom[] {
    const roomById = new Map(snapshot.map.map((room) => [room.id, room]));
    const ids = new Set<string>([currentRoom.id, ...currentRoom.neighbors]);
    if (selectedRoomId) {
        ids.add(selectedRoomId);
    }
    if (objectiveTargetRoomId) {
        ids.add(objectiveTargetRoomId);
    }

    for (const player of snapshot.players) {
        if (player.escaped || player.defeated) {
            continue;
        }
        ids.add(player.roomId);
        const playerRoom = roomById.get(player.roomId);
        for (const neighborId of playerRoom?.neighbors ?? []) {
            ids.add(neighborId);
        }
    }

    return [...ids]
        .map((roomId) => roomById.get(roomId))
        .filter((room): room is RelicRoom => !!room);
}

function roomWorldPositionForCamera(room: RelicRoom): Vector3 {
    return new Vector3(room.x * WORLD_SCALE, 0, room.z * WORLD_SCALE);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
