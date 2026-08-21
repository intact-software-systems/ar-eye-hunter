import type { RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';

export const MAX_ACTIVE_EFFECT_ROOMS = 6;

export function selectActiveEffectRoomIds({
    snapshot,
    localPlayerId,
    selectedRoomId,
    objectiveTargetRoomId,
    focusRoomId,
    maxRooms = MAX_ACTIVE_EFFECT_ROOMS
}: Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    selectedRoomId?: string;
    objectiveTargetRoomId?: string;
    focusRoomId?: string;
    maxRooms?: number;
}>): readonly string[] {
    if (!snapshot || snapshot.phase === 'lobby' || maxRooms <= 0) {
        return [];
    }

    const roomById = new Map(snapshot.map.map((room) => [room.id, room]));
    const scored = new Map<string, number>();
    const add = (roomId: string | undefined, score: number) => {
        if (!roomId || !roomById.has(roomId)) {
            return;
        }
        scored.set(roomId, Math.min(scored.get(roomId) ?? Number.POSITIVE_INFINITY, score));
    };

    const localPlayer = snapshot.players.find((player) => player.playerId === localPlayerId);
    const currentRoom = localPlayer ? roomById.get(localPlayer.roomId) : undefined;
    add(currentRoom?.id, 0);
    add(selectedRoomId, 1);
    add(objectiveTargetRoomId, 2);
    add(focusRoomId, 2);

    for (const player of snapshot.players) {
        if (player.escaped || player.defeated) {
            continue;
        }
        add(player.roomId, player.playerId === localPlayerId ? 0 : 3);
    }

    for (const neighborId of currentRoom?.neighbors ?? []) {
        add(neighborId, 4);
    }

    const selectedRoom = selectedRoomId ? roomById.get(selectedRoomId) : undefined;
    for (const neighborId of selectedRoom?.neighbors ?? []) {
        add(neighborId, 5);
    }

    const origin = currentRoom ?? selectedRoom ?? roomById.get(objectiveTargetRoomId ?? '') ??
        roomById.get(focusRoomId ?? '');

    return [...scored.entries()]
        .sort(([roomA, scoreA], [roomB, scoreB]) => {
            const priority = scoreA - scoreB;
            if (priority !== 0) {
                return priority;
            }
            const distance = roomDistance(roomById.get(roomA), origin) -
                roomDistance(roomById.get(roomB), origin);
            if (distance !== 0) {
                return distance;
            }
            return roomA.localeCompare(roomB);
        })
        .slice(0, maxRooms)
        .map(([roomId]) => roomId);
}

function roomDistance(room: RelicRoom | undefined, origin: RelicRoom | undefined): number {
    if (!room || !origin) {
        return 0;
    }
    return Math.abs(room.x - origin.x) + Math.abs(room.z - origin.z);
}
