import type { RallarGameEnvelope } from '@shared-web/game/mod.ts';

import { withValidatedAvatarProfile } from '../../arena-connection-helpers.ts';
import { isArenaPoseIntentFromSender } from '../../../rallar-game-match-adapter.ts';
import { hydrateArenaSnapshot, toArenaSnapshot, upsertPlayerPose } from '../../../simulation.ts';
import { GAME_PROTOCOL, type GameRealtimeMessage } from '../../../types.ts';
import type {
    ArenaConnectionLifecycleInput,
} from '../../lifecycle/use-arena-connection-lifecycle.ts';

export async function handleArenaMatchInput(
    input: ArenaConnectionLifecycleInput,
    generation: number,
    envelope: RallarGameEnvelope<GameRealtimeMessage>,
): Promise<void> {
    if (!input.isCurrentNetworkGeneration(generation)) return;
    const data = envelope.payload;
    if (!isArenaPoseIntentFromSender(data, envelope.senderId)) return;
    const pose = withValidatedAvatarProfile(data.pose);
    const previous = input.arenaSnapshotRef.current;
    if (previous) {
        const next = toArenaSnapshot(
            upsertPlayerPose(hydrateArenaSnapshot(previous), pose, Date.now()),
            previous.roomId ?? input.roomIdRef.current,
            Date.now(),
        );
        input.arenaSnapshotRef.current = next;
        input.setArenaSnapshot(next);
    }
    await input.arenaMatchRef.current?.publishEvent({
        protocol: GAME_PROTOCOL,
        kind: 'director-player-state',
        pose,
    });
}
