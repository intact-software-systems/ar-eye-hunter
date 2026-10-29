import { rallar } from '@shared-web/browser/rallar.ts';
import type { RallarGameEnvelope } from '@shared-web/game/mod.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';

import { isArenaPoseIntentFromSender } from '../../../rallar-game-match-adapter.ts';
import {
    hydrateArenaSnapshot,
    toArenaSnapshot,
    upsertPlayerPose
} from '../../../simulation.ts';
import { GAME_PROTOCOL, type GameRealtimeMessage } from '../../../types.ts';
import { isCurrentArenaPlayerSession } from '../../arena-participation.ts';
import { toValidatedPlayerPose } from '../../state/to-validated-player-pose.ts';
import type { ArenaMatchRuntimeInput } from '../create-arena-match-runtime.ts';

export async function acceptArenaMatchInput(
    input: ArenaMatchRuntimeInput,
    generation: number,
    envelope: RallarGameEnvelope<GameRealtimeMessage>
): Promise<void> {
    if (
        !input.isCurrentNetworkGeneration(generation) || !isCurrentArenaPlayerSession(envelope.senderId, input.nowMs())
    ) {
        return;
    }
    const roomRef = rallar.rooms.state().currentRoomRef;
    if (!roomRef || !isSameGroupRef(envelope.roomRef, roomRef)) {
        return;
    }
    const message = envelope.payload;
    if (!isArenaPoseIntentFromSender(message, envelope.senderId)) {
        return;
    }
    const nowEpochMs = input.nowMs();
    const pose = toValidatedPlayerPose(message.pose);
    const previous = input.arenaSnapshotRef.current;
    if (previous) {
        const next = toArenaSnapshot(
            upsertPlayerPose(hydrateArenaSnapshot(previous), pose, nowEpochMs),
            previous.roomId ?? input.roomIdRef.current,
            nowEpochMs
        );
        input.arenaSnapshotRef.current = next;
        input.setArenaSnapshot(next);
    }
    await input.arenaMatchRef.current?.publishEvent({
        protocol: GAME_PROTOCOL,
        kind: 'director-player-state',
        pose
    });
}
