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
    inspection
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
            hotspotId: inspection.hotspot.id,
            label: inspection.hotspot.promptLabel,
            detail: `${inspection.hotspot.inspectionDetail} Esc or back away to leave inspection.`,
            inspecting: true
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
        return left.hotspotId === right.hotspotId &&
            left.label === right.label &&
            left.detail === right.detail &&
            left.inspecting === right.inspecting;
    }
    return false;
}

export function roomClueHotspot(room: RelicRoom): ClueHotspot {
    return roomClueHotspots(room)[0];
}

export function roomClueHotspots(room: RelicRoom): readonly ClueHotspot[] {
    switch (room.kind) {
        case 'shrine':
            return [
                {
                    id: `${room.id}-altar`,
                    x: 0,
                    z: 0,
                    label: 'Search the altar',
                    promptLabel: 'Inspect altar runes',
                    detail: 'Prime a Search plan for this room',
                    inspectionDetail:
                        'The altar glyphs pulse in uneven beats, hinting at a relic sealed beneath old vows.',
                    discoveredLabel: 'Altar runes'
                },
                {
                    id: `${room.id}-rune-wall`,
                    x: -1.05,
                    z: -0.62,
                    label: 'Read the rune wall',
                    promptLabel: 'Inspect rune wall',
                    detail: 'Prime a Search plan from the rune marks',
                    inspectionDetail:
                        'A broken rune line bends toward the next chamber like a sentence left unfinished.',
                    discoveredLabel: 'Rune wall'
                },
                {
                    id: `${room.id}-cracked-statue`,
                    x: 1.0,
                    z: 0.74,
                    label: 'Inspect the cracked statue',
                    promptLabel: 'Inspect cracked statue',
                    detail: 'Prime a Search plan from the statue clue',
                    inspectionDetail:
                        'The statue face is split cleanly, revealing a bright thread of dust in the crack.',
                    discoveredLabel: 'Cracked statue'
                }
            ];
        case 'storage':
            return [
                {
                    id: `${room.id}-crates`,
                    x: -0.75,
                    z: 0.55,
                    label: 'Search the crates',
                    promptLabel: 'Inspect map fragment',
                    detail: 'Look for relic signs among the supplies',
                    inspectionDetail:
                        'Fresh dust breaks around one marked crate, and a torn map points deeper into the castle.',
                    discoveredLabel: 'Torn supply map'
                },
                {
                    id: `${room.id}-wax-seal`,
                    x: 0.92,
                    z: 0.1,
                    label: 'Inspect the wax seal',
                    promptLabel: 'Inspect wax seal',
                    detail: 'Prime a Search plan from the marked seal',
                    inspectionDetail:
                        'The red wax bears the same crest as the far castle doors, pressed over a supply ledger.',
                    discoveredLabel: 'Marked wax seal'
                },
                {
                    id: `${room.id}-broken-crate`,
                    x: -1.24,
                    z: -0.72,
                    label: 'Inspect the broken crate',
                    promptLabel: 'Inspect broken crate',
                    detail: 'Prime a Search plan from the splintered crate',
                    inspectionDetail:
                        'The crate was opened from inside; splinters point along the route the thief took.',
                    discoveredLabel: 'Broken crate'
                }
            ];
        case 'treasure':
            return [
                {
                    id: `${room.id}-chest`,
                    x: 0,
                    z: 0.35,
                    label: 'Inspect the chest',
                    promptLabel: 'Inspect chest latch',
                    detail: 'Prime a Search plan before others steal the lead',
                    inspectionDetail:
                        'Coin scratches trail away from the chest, and the mirror plaque reflects a hidden latch.',
                    discoveredLabel: 'Chest latch'
                },
                {
                    id: `${room.id}-mirror`,
                    x: 1.02,
                    z: -0.48,
                    label: 'Inspect the mirror',
                    promptLabel: 'Inspect mirror plaque',
                    detail: 'Prime a Search plan from the reflected clue',
                    inspectionDetail:
                        'The mirror does not reflect the doorway; it reflects a coin trail that is not in the room.',
                    discoveredLabel: 'Mirror plaque'
                },
                {
                    id: `${room.id}-coin-trail`,
                    x: -0.95,
                    z: 0.92,
                    label: 'Follow the coin trail',
                    promptLabel: 'Inspect coin trail',
                    detail: 'Prime a Search plan from the scattered coins',
                    inspectionDetail:
                        'The coins are arranged in careful half-steps, each one cleaner on its north edge.',
                    discoveredLabel: 'Coin trail'
                }
            ];
        case 'trap':
            return [
                {
                    id: `${room.id}-plates`,
                    x: 0,
                    z: 0,
                    label: 'Study the pressure plates',
                    promptLabel: 'Study pressure plates',
                    detail: 'Search carefully; the ruin hears noise',
                    inspectionDetail:
                        'The plate corners carry worn boot marks; the center stone is clean enough to be dangerous.',
                    discoveredLabel: 'Safe plate edges'
                },
                {
                    id: `${room.id}-wall-scratches`,
                    x: -1.05,
                    z: -0.88,
                    label: 'Read the wall scratches',
                    promptLabel: 'Inspect wall scratches',
                    detail: 'Prime a Search plan from the warning marks',
                    inspectionDetail:
                        'Three scrape lines end before the center tile; someone learned the safe path late.',
                    discoveredLabel: 'Wall scratches'
                },
                {
                    id: `${room.id}-loose-tile`,
                    x: 0.86,
                    z: 0.82,
                    label: 'Inspect the loose tile',
                    promptLabel: 'Inspect loose tile',
                    detail: 'Prime a Search plan from the loose stone',
                    inspectionDetail:
                        'The tile shifts under the toe, exposing a brass pin and a thin shadow beneath it.',
                    discoveredLabel: 'Loose tile'
                }
            ];
        case 'monster':
            return [
                {
                    id: `${room.id}-bone-altar`,
                    x: 0,
                    z: 0.6,
                    label: 'Search the bone altar',
                    promptLabel: 'Inspect bone altar',
                    detail: 'Dangerous rooms can hold the richest relics',
                    inspectionDetail:
                        'Broken chains and claw marks circle the bones, but a gold glint sits beneath the ash.',
                    discoveredLabel: 'Bone altar'
                },
                {
                    id: `${room.id}-claw-marks`,
                    x: 1.08,
                    z: -0.68,
                    label: 'Inspect the claw marks',
                    promptLabel: 'Inspect claw marks',
                    detail: 'Prime a Search plan from the clawed wall',
                    inspectionDetail:
                        'The claw marks are not random; their spacing narrows toward the exit side of the room.',
                    discoveredLabel: 'Claw marks'
                },
                {
                    id: `${room.id}-ash-pile`,
                    x: -0.95,
                    z: 0.14,
                    label: 'Sift the ash pile',
                    promptLabel: 'Inspect ash pile',
                    detail: 'Prime a Search plan from the ash',
                    inspectionDetail:
                        'The ash is cold, but a curved clean line shows where something was recently lifted away.',
                    discoveredLabel: 'Ash pile'
                }
            ];
        case 'exit':
            return [
                {
                    id: `${room.id}-runes`,
                    x: 0,
                    z: ROOM_SIZE / 2 - 0.95,
                    label: 'Read the exit runes',
                    promptLabel: 'Read exit runes',
                    detail: 'Escape is a plan, not free movement',
                    inspectionDetail: 'The runes brighten toward daylight, but they demand a committed escape plan.',
                    discoveredLabel: 'Exit runes'
                },
                {
                    id: `${room.id}-daylight-slit`,
                    x: -0.76,
                    z: ROOM_SIZE / 2 - 0.72,
                    label: 'Inspect daylight slit',
                    promptLabel: 'Inspect daylight slit',
                    detail: 'Prime a Search plan from the daylight mark',
                    inspectionDetail: 'Dust floats outward through the narrow split, proving the route still breathes.',
                    discoveredLabel: 'Daylight slit'
                },
                {
                    id: `${room.id}-threshold`,
                    x: 0.78,
                    z: ROOM_SIZE / 2 - 0.52,
                    label: 'Inspect threshold glyphs',
                    promptLabel: 'Inspect threshold glyphs',
                    detail: 'Prime a Search plan from the threshold',
                    inspectionDetail: 'The threshold glyphs brighten only where carried relics cross the stone.',
                    discoveredLabel: 'Threshold glyphs'
                }
            ];
        default:
            return [
                {
                    id: `${room.id}-clue`,
                    x: 0,
                    z: 0,
                    label: 'Search for clues',
                    promptLabel: 'Inspect room clue',
                    detail: 'Prime a Search plan for the next reveal',
                    inspectionDetail:
                        'Scuffed stone and old candle soot suggest something in this room has been disturbed.',
                    discoveredLabel: 'Room clue'
                }
            ];
    }
}

export function chooseLookRoom(
    snapshot: RelicPublicSnapshot,
    room: RelicRoom,
    selectedRoomId: string | undefined
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
    forward: Vector3
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
                direction
            } satisfies ScenePrompt;
        })
        .filter((prompt): prompt is Extract<ScenePrompt, { kind: 'move'; }> => !!prompt);

    return prompts[0];
}

function findCluePrompt(
    room: RelicRoom,
    roamOffset: Vector3,
    forward: Vector3
): ScenePrompt | undefined {
    const prompts: Array<Readonly<{ distance: number; prompt: ScenePrompt; }>> = [];
    for (const clue of roomClueHotspots(room)) {
        const toClue = new Vector3(clue.x - roamOffset.x, 0, clue.z - roamOffset.z);
        const distance = toClue.length();
        if (distance > 1.65) {
            continue;
        }

        const direction = distance > 0.01 ? toClue.normalize() : forward;
        const facing = forward.x * direction.x + forward.z * direction.z > 0.2 ||
            distance < 0.68;
        if (!facing) {
            continue;
        }

        prompts.push({
            distance,
            prompt: {
                kind: 'search',
                hotspotId: clue.id,
                label: clue.promptLabel,
                detail: clue.detail
            }
        });
    }

    prompts.sort((left, right) => left.distance - right.distance);

    return prompts[0]?.prompt;
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
