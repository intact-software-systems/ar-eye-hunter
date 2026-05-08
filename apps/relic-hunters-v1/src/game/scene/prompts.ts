import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';
import { DOOR_WIDTH, ROAM_MARGIN, ROOM_SIZE } from './constants.ts';
import type { CardinalDirection, ClueHotspot, InspectionFocus, ScenePrompt } from './types.ts';

export function computeScenePrompt({
    snapshot,
    localPlayerId,
    room,
    roamOffset,
    forward,
    inspection,
}: Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    room: RelicRoom;
    roamOffset: Vector3;
    forward: Vector3;
    inspection?: InspectionFocus;
}>): ScenePrompt | undefined {
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    if (!snapshot || !localPlayer || localPlayer.escaped || localPlayer.defeated) {
        return undefined;
    }

    const alreadySubmitted = snapshot.submittedPlayerIds.includes(localPlayer.playerId);
    if (snapshot.phase !== 'planning' || alreadySubmitted) {
        return undefined;
    }

    const doorwayPrompt = findDoorwayPrompt(snapshot, room, roamOffset, forward);
    if (doorwayPrompt) {
        return doorwayPrompt;
    }

    if (inspection && inspection.roomId === room.id) {
        return {
            kind: 'search',
            label: inspection.hotspot.label,
            detail: `${inspection.hotspot.inspectionDetail} Esc or back away to leave inspection.`,
            inspecting: true,
        };
    }

    return findCluePrompt(room, roamOffset, forward);
}

export function samePrompt(left: ScenePrompt | undefined, right: ScenePrompt | undefined): boolean {
    if (!left || !right) {
        return left === right;
    }
    if (left.kind !== right.kind) {
        return false;
    }
    if (left.kind === 'move' && right.kind === 'move') {
        return left.roomId === right.roomId && left.direction === right.direction;
    }
    if (left.kind === 'search' && right.kind === 'search') {
        return left.label === right.label &&
            left.detail === right.detail &&
            left.inspecting === right.inspecting;
    }
    return false;
}

export function roomClueHotspot(room: RelicRoom): ClueHotspot {
    switch (room.kind) {
        case 'shrine':
            return {
                id: `${room.id}-altar`,
                x: 0,
                z: 0,
                label: 'Search the altar',
                detail: 'Prime a Search plan for this room',
                inspectionDetail: 'The altar glyphs pulse in uneven beats, hinting at a relic sealed beneath old vows.',
            };
        case 'storage':
            return {
                id: `${room.id}-crates`,
                x: -0.75,
                z: 0.55,
                label: 'Search the crates',
                detail: 'Look for relic signs among the supplies',
                inspectionDetail: 'Fresh dust breaks around one marked crate, and a torn map points deeper into the castle.',
            };
        case 'treasure':
            return {
                id: `${room.id}-chest`,
                x: 0,
                z: 0.35,
                label: 'Inspect the chest',
                detail: 'Prime a Search plan before others steal the lead',
                inspectionDetail: 'Coin scratches trail away from the chest, and the mirror plaque reflects a hidden latch.',
            };
        case 'trap':
            return {
                id: `${room.id}-plates`,
                x: 0,
                z: 0,
                label: 'Study the pressure plates',
                detail: 'Search carefully; the ruin hears noise',
                inspectionDetail: 'The plate corners carry worn boot marks; the center stone is clean enough to be dangerous.',
            };
        case 'monster':
            return {
                id: `${room.id}-bone-altar`,
                x: 0,
                z: 0.6,
                label: 'Search the bone altar',
                detail: 'Dangerous rooms can hold the richest relics',
                inspectionDetail: 'Broken chains and claw marks circle the bones, but a gold glint sits beneath the ash.',
            };
        case 'exit':
            return {
                id: `${room.id}-runes`,
                x: 0,
                z: ROOM_SIZE / 2 - 0.95,
                label: 'Read the exit runes',
                detail: 'Escape is a plan, not free movement',
                inspectionDetail: 'The runes brighten toward daylight, but they demand a committed escape plan.',
            };
        default:
            return {
                id: `${room.id}-clue`,
                x: 0,
                z: 0,
                label: 'Search for clues',
                detail: 'Prime a Search plan for the next reveal',
                inspectionDetail: 'Scuffed stone and old candle soot suggest something in this room has been disturbed.',
            };
    }
}

export function chooseLookRoom(
    snapshot: RelicPublicSnapshot,
    room: RelicRoom,
    selectedRoomId: string | undefined,
): RelicRoom | undefined {
    const selectedRoom = selectedRoomId
        ? snapshot.map.find((candidate) => candidate.id === selectedRoomId)
        : undefined;
    if (selectedRoom && room.neighbors.includes(selectedRoom.id)) {
        return selectedRoom;
    }

    const openNeighbors = room.neighbors
        .map((roomId) => snapshot.map.find((candidate) => candidate.id === roomId))
        .filter((candidate): candidate is RelicRoom => !!candidate && !candidate.collapsed);

    return openNeighbors.find((candidate) => candidate.kind === 'exit') ??
        openNeighbors.find((candidate) => candidate.kind === 'treasure') ??
        openNeighbors[0];
}

export function directionBetweenRooms(from: RelicRoom, to: RelicRoom): CardinalDirection {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    if (Math.abs(dx) > Math.abs(dz)) {
        return dx > 0 ? 'east' : 'west';
    }
    return dz > 0 ? 'south' : 'north';
}

function findDoorwayPrompt(
    snapshot: RelicPublicSnapshot,
    room: RelicRoom,
    roamOffset: Vector3,
    forward: Vector3,
): ScenePrompt | undefined {
    const limit = ROOM_SIZE / 2 - ROAM_MARGIN;
    const prompts = room.neighbors
        .map((neighborId) => snapshot.map.find((candidate) => candidate.id === neighborId))
        .filter((neighbor): neighbor is RelicRoom => !!neighbor && !neighbor.collapsed)
        .map((neighbor) => {
            const direction = directionBetweenRooms(room, neighbor);
            const vector = directionVector(direction);
            const along = roamOffset.x * vector.x + roamOffset.z * vector.z;
            const cross = direction === 'north' || direction === 'south'
                ? roamOffset.x
                : roamOffset.z;
            const closeToDoor = limit - along < 0.62;
            const insideDoorway = Math.abs(cross) < DOOR_WIDTH / 2 + 0.38;
            const facingDoor = forward.x * vector.x + forward.z * vector.z > 0.36;
            if (!closeToDoor || !insideDoorway || !facingDoor) {
                return undefined;
            }

            return {
                kind: 'move',
                roomId: neighbor.id,
                roomName: neighbor.name,
                direction,
            } satisfies ScenePrompt;
        })
        .filter((prompt): prompt is Extract<ScenePrompt, { kind: 'move' }> => !!prompt);

    return prompts[0];
}

function findCluePrompt(
    room: RelicRoom,
    roamOffset: Vector3,
    forward: Vector3,
): ScenePrompt | undefined {
    const clue = roomClueHotspot(room);
    const toClue = new Vector3(clue.x - roamOffset.x, 0, clue.z - roamOffset.z);
    const distance = toClue.length();
    if (distance > 1.65) {
        return undefined;
    }

    const direction = distance > 0.01 ? toClue.normalize() : forward;
    const facing = forward.x * direction.x + forward.z * direction.z > 0.2 || distance < 0.68;
    if (!facing) {
        return undefined;
    }

    return {
        kind: 'search',
        label: clue.label,
        detail: clue.detail,
    };
}

function directionVector(direction: CardinalDirection): Vector3 {
    switch (direction) {
        case 'north':
            return new Vector3(0, 0, -1);
        case 'south':
            return new Vector3(0, 0, 1);
        case 'east':
            return new Vector3(1, 0, 0);
        case 'west':
            return new Vector3(-1, 0, 0);
    }
}
