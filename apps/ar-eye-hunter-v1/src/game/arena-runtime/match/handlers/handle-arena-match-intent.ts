import type { RallarGameEnvelope } from '@shared-web/game/mod.ts';

import {
    isArenaAcceptedShotFromSender,
    isArenaMatchStartIntentFromSender,
    isArenaPickupIntentFromSender,
    isArenaPlayerHitIntentFromSender,
    isArenaShotIntentFromSender,
} from '../../../rallar-game-match-adapter.ts';
import {
    hydrateArenaSnapshot,
    resolvePickupIntent,
    resolvePlayerHitIntent,
    toArenaSnapshot,
} from '../../../simulation.ts';
import { GAME_PROTOCOL, type GameRealtimeMessage } from '../../../types.ts';
import type {
    ArenaConnectionLifecycleInput,
} from '../../lifecycle/use-arena-connection-lifecycle.ts';

export async function handleArenaMatchIntent(
    input: ArenaConnectionLifecycleInput,
    generation: number,
    envelope: RallarGameEnvelope<GameRealtimeMessage>,
): Promise<void> {
    if (!input.isCurrentNetworkGeneration(generation)) return;
    const data = envelope.payload;
    if (isArenaShotIntentFromSender(data, envelope.senderId)) {
        await input.arenaMatchRef.current?.publishEvent({
            protocol: GAME_PROTOCOL,
            kind: 'director-shot-event',
            shot: data.shot,
        });
        return;
    }
    if (isArenaPlayerHitIntentFromSender(data, envelope.senderId)) {
        const previous = input.arenaSnapshotRef.current;
        if (!previous) return;
        const result = resolvePlayerHitIntent(
            hydrateArenaSnapshot(previous),
            data.intent,
            Date.now(),
        );
        if (!result.accepted) return;
        const snapshot = toArenaSnapshot(
            result.state,
            previous.roomId ?? input.roomIdRef.current,
            Date.now(),
        );
        input.arenaSnapshotRef.current = snapshot;
        input.setArenaSnapshot(snapshot);
        input.acceptPlayerHit(result.acceptedHit);
        await input.arenaMatchRef.current?.publishEvent({
            protocol: GAME_PROTOCOL,
            kind: 'director-player-hit-accepted',
            accepted: result.acceptedHit,
        });
        await input.arenaMatchRef.current?.publishSnapshot(snapshot, { reliable: false });
        return;
    }
    if (isArenaPickupIntentFromSender(data, envelope.senderId)) {
        const previous = input.arenaSnapshotRef.current;
        if (!previous) return;
        const result = resolvePickupIntent(
            hydrateArenaSnapshot(previous),
            data.intent,
            Date.now(),
        );
        if (!result.accepted) return;
        const snapshot = toArenaSnapshot(
            result.state,
            previous.roomId ?? input.roomIdRef.current,
            Date.now(),
        );
        input.arenaSnapshotRef.current = snapshot;
        input.setArenaSnapshot(snapshot);
        input.acceptPickup(result.acceptedPickup);
        await input.arenaMatchRef.current?.publishEvent({
            protocol: GAME_PROTOCOL,
            kind: 'director-pickup-accepted',
            accepted: result.acceptedPickup,
        });
        await input.arenaMatchRef.current?.publishSnapshot(snapshot, { reliable: false });
        return;
    }
    if (isArenaMatchStartIntentFromSender(data, envelope.senderId)) {
        const status = input.arenaMatchRef.current?.status();
        if (status?.directorPeerId === envelope.senderId) {
            await input.acceptMatchStartIntent(data.intent);
        }
        return;
    }
    if (isArenaAcceptedShotFromSender(data, envelope.senderId)) {
        await input.arenaMatchRef.current?.publishEvent(data);
    }
}
