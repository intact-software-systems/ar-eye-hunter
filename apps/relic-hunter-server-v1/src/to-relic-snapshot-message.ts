import {
    RELIC_TOPICS,
    RELIC_TYPES,
    toPublicRelicSnapshot,
    toRelicRoomGroupRef,
    type RelicGameState,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';

/** How long a snapshot stays deliverable: the 15 s it had before it carried receipts (Q7). */
export const RELIC_SNAPSHOT_TTL_MS = 15_000;

/**
 * A snapshot is the server's own room notification (D58, D77): the server peer id is its sender, so every receiver's
 * ACK reaches the server's receipt row, and it names the room Relic's REST routes read (C14).
 */
export function toRelicSnapshotMessage(state: RelicGameState, serverPeerId: string): ALMessage {
    const snapshot = toPublicRelicSnapshot(state);
    const event: RelicServerEvent = {
        protocolVersion: snapshot.protocolVersion,
        gameId: snapshot.gameId,
        snapshot
    };
    return newALBroadcastMessage(
        serverPeerId,
        newALRoute(RELIC_TOPICS.snapshot, state.roomId, `${state.gameId}:${state.round}`),
        'room',
        RELIC_TYPES.snapshot,
        event,
        {
            groupRef: toRelicRoomGroupRef(state.roomId),
            reliability: 'at-least-once',
            ack: 'receiver',
            ttlMs: RELIC_SNAPSHOT_TTL_MS
        }
    );
}
