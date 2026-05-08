import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { RelicRoom } from '@relic-hunters/mod.ts';
import { PLAYER_RADIUS, ROAM_MARGIN, ROOM_SIZE } from './constants.ts';
import type { CollisionBox } from './types.ts';
import { clamp } from './controls.ts';

export function resolveRoomRoam(
    blockers: ReadonlyMap<string, readonly CollisionBox[]>,
    roomId: string,
    previous: Vector3,
    desired: Vector3,
): Vector3 {
    const next = clampRoamOffset(desired);
    const xCandidate = new Vector3(next.x, 0, previous.z);
    const resolvedX = collidesWithRoomBlockers(blockers, roomId, xCandidate)
        ? previous.x
        : next.x;
    const zCandidate = new Vector3(resolvedX, 0, next.z);
    const resolvedZ = collidesWithRoomBlockers(blockers, roomId, zCandidate)
        ? previous.z
        : next.z;

    return new Vector3(resolvedX, 0, resolvedZ);
}

export function roomCollisionBoxes(room: RelicRoom): readonly CollisionBox[] {
    const sideFurniture = [
        { x: -ROOM_SIZE / 2 + 0.62, z: 1.35, halfX: 0.36, halfZ: 0.76 },
        { x: ROOM_SIZE / 2 - 0.62, z: 1.35, halfX: 0.36, halfZ: 0.76 },
    ];

    switch (room.kind) {
        case 'storage':
            return [
                ...sideFurniture,
                { x: -0.98, z: 1.02, halfX: 0.8, halfZ: 0.52 },
                { x: 0.15, z: 0.34, halfX: 0.68, halfZ: 0.48 },
                { x: 1.06, z: -0.34, halfX: 0.62, halfZ: 0.46 },
                { x: -1.38, z: -1.02, halfX: 0.38, halfZ: 0.38 },
                { x: 1.38, z: -1.02, halfX: 0.38, halfZ: 0.38 },
            ];
        case 'shrine':
            return [
                ...sideFurniture,
                { x: 0, z: 0, halfX: 0.86, halfZ: 0.86 },
            ];
        case 'trap':
            return [
                ...sideFurniture,
                { x: 0, z: 0, halfX: 1.24, halfZ: 1.24 },
            ];
        case 'treasure':
            return [
                ...sideFurniture,
                { x: 0, z: 0.3, halfX: 0.82, halfZ: 0.58 },
            ];
        case 'monster':
            return [
                ...sideFurniture,
                { x: 0, z: 0.54, halfX: 0.72, halfZ: 0.72 },
            ];
        case 'exit':
            return [
                ...sideFurniture,
                { x: -1.48, z: ROOM_SIZE / 2 - 0.52, halfX: 0.34, halfZ: 0.6 },
                { x: 1.48, z: ROOM_SIZE / 2 - 0.52, halfX: 0.34, halfZ: 0.6 },
            ];
        default:
            return sideFurniture;
    }
}

function clampRoamOffset(value: Vector3): Vector3 {
    const limit = ROOM_SIZE / 2 - ROAM_MARGIN;
    return new Vector3(
        clamp(value.x, -limit, limit),
        0,
        clamp(value.z, -limit, limit),
    );
}

function collidesWithRoomBlockers(
    blockers: ReadonlyMap<string, readonly CollisionBox[]>,
    roomId: string,
    offset: Vector3,
): boolean {
    for (const blocker of blockers.get(roomId) ?? []) {
        const insideX = Math.abs(offset.x - blocker.x) < blocker.halfX + PLAYER_RADIUS;
        const insideZ = Math.abs(offset.z - blocker.z) < blocker.halfZ + PLAYER_RADIUS;
        if (insideX && insideZ) {
            return true;
        }
    }

    return false;
}
