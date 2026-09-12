import type { RallarGameEnvelope } from '@shared-web/game/mod.ts';

import {
    isArenaAcceptedShotFromSender,
    isArenaMatchStartIntentFromSender,
    isArenaPickupIntentFromSender,
    isArenaPlayerHitIntentFromSender,
    isArenaShotIntentFromSender
} from '../../../rallar-game-match-adapter.ts';
import {
    hydrateArenaSnapshot,
    resolvePickupIntent,
    resolvePlayerHitIntent,
    toArenaSnapshot
} from '../../../simulation.ts';
import { GAME_PROTOCOL, type GameRealtimeMessage, type PickupIntent, type PlayerHitIntent } from '../../../types.ts';
import type { ArenaMatchRuntimeInput } from '../create-arena-match-runtime.ts';

export async function acceptArenaMatchIntent(
    input: ArenaMatchRuntimeInput,
    generation: number,
    envelope: RallarGameEnvelope<GameRealtimeMessage>
): Promise<void> {
    if (!input.isCurrentNetworkGeneration(generation)) {
        return;
    }
    const message = envelope.payload;
    if (isArenaShotIntentFromSender(message, envelope.senderId)) {
        await input.arenaMatchRef.current?.publishEvent({
            protocol: GAME_PROTOCOL,
            kind: 'director-shot-event',
            shot: message.shot
        });
        return;
    }
    if (isArenaPlayerHitIntentFromSender(message, envelope.senderId)) {
        await acceptArenaPlayerHitIntent(input, message.intent);
        return;
    }
    if (isArenaPickupIntentFromSender(message, envelope.senderId)) {
        await acceptArenaPickupIntent(input, message.intent);
        return;
    }
    if (isArenaMatchStartIntentFromSender(message, envelope.senderId)) {
        const status = input.arenaMatchRef.current?.status();
        if (status?.directorPeerId === envelope.senderId) {
            await input.acceptMatchStartIntent(message.intent);
        }
        return;
    }
    if (isArenaAcceptedShotFromSender(message, envelope.senderId)) {
        await input.arenaMatchRef.current?.publishEvent(message);
    }
}

async function acceptArenaPlayerHitIntent(input: ArenaMatchRuntimeInput, intent: PlayerHitIntent): Promise<void> {
    const nowEpochMs = input.nowMs();
    const previous = input.arenaSnapshotRef.current;
    if (!previous) {
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
        previous.roomId ?? input.roomIdRef.current,
        nowEpochMs
    );
    input.arenaSnapshotRef.current = snapshot;
    input.setArenaSnapshot(snapshot);
    input.acceptPlayerHit(result.acceptedHit);
    await input.arenaMatchRef.current?.publishEvent({
        protocol: GAME_PROTOCOL,
        kind: 'director-player-hit-accepted',
        accepted: result.acceptedHit
    });
    await input.arenaMatchRef.current?.publishSnapshot(snapshot, { reliable: false });
}

async function acceptArenaPickupIntent(input: ArenaMatchRuntimeInput, intent: PickupIntent): Promise<void> {
    const nowEpochMs = input.nowMs();
    const previous = input.arenaSnapshotRef.current;
    if (!previous) {
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
        previous.roomId ?? input.roomIdRef.current,
        nowEpochMs
    );
    input.arenaSnapshotRef.current = snapshot;
    input.setArenaSnapshot(snapshot);
    input.acceptPickup(result.acceptedPickup);
    await input.arenaMatchRef.current?.publishEvent({
        protocol: GAME_PROTOCOL,
        kind: 'director-pickup-accepted',
        accepted: result.acceptedPickup
    });
    await input.arenaMatchRef.current?.publishSnapshot(snapshot, { reliable: false });
}
