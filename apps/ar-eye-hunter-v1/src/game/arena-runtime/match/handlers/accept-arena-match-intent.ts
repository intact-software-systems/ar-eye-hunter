import type { RallarGameEnvelope } from '@shared-web/game/mod.ts';

import {
    isArenaAcceptedShotFromSender,
    isArenaMatchStartIntentFromSender,
    isArenaPickupIntentFromSender,
    isArenaPlayerHitIntentFromSender,
    isArenaShotIntentFromSender,
    type ArenaRallarGameMatchHandle
} from '../../../rallar-game-match-adapter.ts';
import {
    hydrateArenaSnapshot,
    resolvePickupIntent,
    resolvePlayerHitIntent,
    toArenaSnapshot
} from '../../../simulation.ts';
import { GAME_PROTOCOL, type GameRealtimeMessage, type PickupIntent, type PlayerHitIntent } from '../../../types.ts';
import type { ArenaMatchRuntimeInput } from '../create-arena-match-runtime.ts';

interface ArenaIntentOwner {
    readonly input: ArenaMatchRuntimeInput;
    readonly generation: number;
    readonly roomId: string;
    readonly match: ArenaRallarGameMatchHandle;
}

export async function acceptArenaMatchIntent(
    input: ArenaMatchRuntimeInput,
    generation: number,
    envelope: RallarGameEnvelope<GameRealtimeMessage>
): Promise<void> {
    if (!input.isCurrentNetworkGeneration(generation)) {
        return;
    }
    const match = input.arenaMatchRef.current;
    const roomId = input.roomIdRef.current;
    if (!match || !roomId || envelope.roomId !== roomId) {
        return;
    }
    const owner: ArenaIntentOwner = { input, generation, roomId, match };
    const message = envelope.payload;
    if (isArenaShotIntentFromSender(message, envelope.senderId)) {
        await match.publishEvent({
            protocol: GAME_PROTOCOL,
            kind: 'director-shot-event',
            shot: message.shot
        });
        return;
    }
    if (isArenaPlayerHitIntentFromSender(message, envelope.senderId)) {
        await acceptArenaPlayerHitIntent(owner, message.intent);
        return;
    }
    if (isArenaPickupIntentFromSender(message, envelope.senderId)) {
        await acceptArenaPickupIntent(owner, message.intent);
        return;
    }
    if (isArenaMatchStartIntentFromSender(message, envelope.senderId)) {
        const status = match.status();
        if (status?.directorPeerId === envelope.senderId) {
            await input.acceptMatchStartIntent(message.intent);
        }
        return;
    }
    if (isArenaAcceptedShotFromSender(message, envelope.senderId)) {
        await match.publishEvent(message);
    }
}

async function acceptArenaPlayerHitIntent(owner: ArenaIntentOwner, intent: PlayerHitIntent): Promise<void> {
    const { input, match, roomId } = owner;
    const nowEpochMs = input.nowMs();
    const previous = input.arenaSnapshotRef.current;
    if (!previous || (previous.roomId !== undefined && previous.roomId !== roomId)) {
        return;
    }
    const result = resolvePlayerHitIntent(
        hydrateArenaSnapshot(previous),
        intent,
        nowEpochMs
    );
    if (!result.accepted) {
        return;
    }
    const snapshot = toArenaSnapshot(
        result.state,
        previous.roomId ?? roomId,
        nowEpochMs
    );
    input.arenaSnapshotRef.current = snapshot;
    input.setArenaSnapshot(snapshot);
    input.acceptPlayerHit(result.acceptedHit);
    await match.publishEvent({
        protocol: GAME_PROTOCOL,
        kind: 'director-player-hit-accepted',
        accepted: result.acceptedHit
    });
    if (isCurrentArenaIntentOwner(owner)) {
        await match.publishSnapshot(snapshot, { reliable: false });
    }
}

async function acceptArenaPickupIntent(owner: ArenaIntentOwner, intent: PickupIntent): Promise<void> {
    const { input, match, roomId } = owner;
    const nowEpochMs = input.nowMs();
    const previous = input.arenaSnapshotRef.current;
    if (!previous || (previous.roomId !== undefined && previous.roomId !== roomId)) {
        return;
    }
    const result = resolvePickupIntent(
        hydrateArenaSnapshot(previous),
        intent,
        nowEpochMs
    );
    if (!result.accepted) {
        return;
    }
    const snapshot = toArenaSnapshot(
        result.state,
        previous.roomId ?? roomId,
        nowEpochMs
    );
    input.arenaSnapshotRef.current = snapshot;
    input.setArenaSnapshot(snapshot);
    input.acceptPickup(result.acceptedPickup);
    await match.publishEvent({
        protocol: GAME_PROTOCOL,
        kind: 'director-pickup-accepted',
        accepted: result.acceptedPickup
    });
    if (isCurrentArenaIntentOwner(owner)) {
        await match.publishSnapshot(snapshot, { reliable: false });
    }
}

function isCurrentArenaIntentOwner(owner: ArenaIntentOwner): boolean {
    return owner.input.isCurrentNetworkGeneration(owner.generation) &&
        owner.input.arenaMatchRef.current === owner.match && owner.input.roomIdRef.current === owner.roomId;
}
