import {
    legalMoveTargets,
    type RelicActionInput,
    type RelicPublicSnapshot,
} from '@relic-hunters/mod.ts';

export function sceneMoveActionForPickedRoom({
    snapshot,
    localPlayerId,
    roomId,
}: Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    roomId: string;
}>): RelicActionInput | undefined {
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    if (
        !snapshot ||
        !localPlayer ||
        snapshot.phase !== 'planning' ||
        localPlayer.escaped ||
        localPlayer.defeated ||
        snapshot.submittedPlayerIds.includes(localPlayer.playerId)
    ) {
        return undefined;
    }

    if (!legalMoveTargets(snapshot, localPlayer).includes(roomId)) {
        return undefined;
    }

    return {
        kind: 'move',
        targetRoomId: roomId,
    };
}
