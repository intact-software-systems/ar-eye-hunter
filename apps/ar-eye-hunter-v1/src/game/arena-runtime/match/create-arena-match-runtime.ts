import { rallar } from '@shared-web/browser/rallar.ts';

import { handleArenaMatchInput } from './handlers/handle-arena-match-input.ts';
import { handleArenaMatchIntent } from './handlers/handle-arena-match-intent.ts';
import {
    type ArenaRallarGameMatchHandle,
    createArenaRallarGameMatch,
} from '../../rallar-game-match-adapter.ts';
import type { ArenaConnectionLifecycleInput } from '../lifecycle/use-arena-connection-lifecycle.ts';

export function createArenaMatchRuntime(
    input: ArenaConnectionLifecycleInput,
    generation: number,
    roomId: string,
): ArenaRallarGameMatchHandle {
    const isCurrent = () => input.isCurrentNetworkGeneration(generation);
    return createArenaRallarGameMatch({
        rallar,
        roomId,
        readSnapshot: () => input.arenaSnapshotRef.current,
        onPresence: (envelope) => {
            if (isCurrent()) input.acceptMotionMessage(envelope.senderId, envelope.payload);
        },
        onInput: (envelope) => handleArenaMatchInput(input, generation, envelope),
        onIntent: (envelope) => handleArenaMatchIntent(input, generation, envelope),
        onEvent: (envelope) => {
            if (isCurrent()) input.acceptDirectorOutput(envelope.payload);
        },
        onSnapshot: (envelope) => {
            if (!isCurrent()) return;
            input.setArenaSnapshot(envelope.payload);
            input.setActiveEvent(envelope.payload.activeEvent);
            input.setRemoteEvents(envelope.payload.events);
        },
        onSyncRequest: async () => {
            if (!isCurrent()) return;
            const snapshot = input.arenaSnapshotRef.current;
            if (snapshot) {
                await input.arenaMatchRef.current?.publishSnapshot(snapshot, { reliable: true });
            }
        },
    });
}
