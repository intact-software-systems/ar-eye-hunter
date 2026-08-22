import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';
import { WORLD_SCALE } from './constants.ts';
import { AVATAR_CAMERA_FOLLOW_HOLD_MS, AVATAR_CAMERA_ZOOM_OUT_MS, ROOM_FLYOVER_DURATION_MS } from './motionTuning.ts';

export {
    AVATAR_CAMERA_FOLLOW_HOLD_MS,
    AVATAR_CAMERA_ZOOM_OUT_MS,
    ROOM_FLYOVER_DURATION_MS
};

export type RelicCameraMode = 'lobby' | 'tactical' | 'roam' | 'inspection' | 'event-focus' | 'flyover';

export type RelicCameraPose = Readonly<{
    position: Vector3;
    target: Vector3;
    fov: number;
}>;

const ROOM_FLYOVER_RETURN_START = 0.72;

export type AvatarCameraReturnState = Readonly<{
    phase: 'inactive' | 'follow' | 'zoom-out';
    progress: number;
}>;

export type RelicSceneCameraControl = 'flyover' | 'tactical' | 'avatar';
export type RelicSceneManualCameraMode = 'auto' | 'tactical' | 'avatar';

export function deriveRelicCameraMode({
    snapshot,
    localPlayerId,
    isRoaming,
    isInspecting,
    focusRoomId
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

export function avatarCameraReturnState({
    snapshotPhase,
    lastRoamInputMs,
    nowMs
}: Readonly<{
    snapshotPhase?: RelicPublicSnapshot['phase'];
    lastRoamInputMs?: number;
    nowMs: number;
}>): AvatarCameraReturnState {
    if (snapshotPhase !== 'planning' || typeof lastRoamInputMs !== 'number') {
        return { phase: 'inactive', progress: 1 };
    }

    const elapsedMs = Math.max(0, nowMs - lastRoamInputMs);
    if (elapsedMs <= AVATAR_CAMERA_FOLLOW_HOLD_MS) {
        return { phase: 'follow', progress: 0 };
    }

    const zoomElapsedMs = elapsedMs - AVATAR_CAMERA_FOLLOW_HOLD_MS;
    if (zoomElapsedMs <= AVATAR_CAMERA_ZOOM_OUT_MS) {
        return {
            phase: 'zoom-out',
            progress: smoothstep(zoomElapsedMs / AVATAR_CAMERA_ZOOM_OUT_MS)
        };
    }

    return { phase: 'inactive', progress: 1 };
}

export function blendRelicCameraPose(
    avatarPose: RelicCameraPose,
    tacticalPose: RelicCameraPose,
    progress: number
): RelicCameraPose {
    const t = clamp(progress, 0, 1);
    return {
        position: Vector3.Lerp(avatarPose.position, tacticalPose.position, t),
        target: Vector3.Lerp(avatarPose.target, tacticalPose.target, t),
        fov: avatarPose.fov + (tacticalPose.fov - avatarPose.fov) * t
    };
}

export function planRoomFlyoverCameraPose({
    rooms,
    progress,
    returnPose
}: Readonly<{
    rooms: readonly RelicRoom[];
    progress: number;
    returnPose: RelicCameraPose;
}>): RelicCameraPose {
    const routeProgress = clamp(progress / ROOM_FLYOVER_RETURN_START, 0, 1);
    const flyoverPose = planRoomFlyoverRoutePose(rooms, routeProgress);
    if (progress <= ROOM_FLYOVER_RETURN_START) {
        return flyoverPose;
    }

    const returnProgress = smoothstep(
        (progress - ROOM_FLYOVER_RETURN_START) / (1 - ROOM_FLYOVER_RETURN_START)
    );
    return blendRelicCameraPose(flyoverPose, returnPose, returnProgress);
}

export function planTacticalCameraPose({
    snapshot,
    currentRoom,
    selectedRoomId,
    objectiveTargetRoomId,
    aspectRatio
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
        objectiveTargetRoomId
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
            center.z - distance * 0.82
        ),
        target: center,
        fov: 0.72
    };
}

export function tacticalFocusRooms({
    snapshot,
    currentRoom,
    selectedRoomId,
    objectiveTargetRoomId
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

function planRoomFlyoverRoutePose(
    rooms: readonly RelicRoom[],
    progress: number
): RelicCameraPose {
    const sortedRooms = [...rooms].sort((left, right) => left.z === right.z ? left.x - right.x : left.z - right.z);
    const positions = (sortedRooms.length > 0 ? sortedRooms : [
        {
            id: 'origin',
            name: 'Origin',
            kind: 'hallway',
            x: 0,
            z: 0,
            neighbors: []
        } satisfies RelicRoom
    ]).map(roomWorldPositionForCamera);
    const scaled = clamp(progress, 0, 1) * Math.max(1, positions.length - 1);
    const index = Math.min(positions.length - 1, Math.floor(scaled));
    const nextIndex = Math.min(positions.length - 1, index + 1);
    const segmentProgress = smoothstep(scaled - index);
    const center = Vector3.Lerp(positions[index], positions[nextIndex], segmentProgress);

    return {
        position: new Vector3(center.x - 7.4, 9.8, center.z - 8.8),
        target: new Vector3(center.x, 0.78, center.z),
        fov: 0.78
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function smoothstep(value: number): number {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
}
