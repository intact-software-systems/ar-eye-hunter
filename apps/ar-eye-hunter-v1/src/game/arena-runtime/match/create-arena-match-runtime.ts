import { rallar } from '@shared-web/browser/rallar.ts';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import { handleArenaMatchInput } from './handlers/handle-arena-match-input.ts';
import { handleArenaMatchIntent } from './handlers/handle-arena-match-intent.ts';
import {
    type ArenaRallarGameMatchHandle,
    createArenaRallarGameMatch,
} from '../../rallar-game-match-adapter.ts';
import type {
    ArenaEvent,
    ArenaSnapshot,
    GameRealtimeMessage,
    MatchStartIntent,
    PickupAccepted,
    PlayerHitAccepted,
} from '../../types.ts';

export interface ArenaMatchRuntimeInput {
    readonly acceptDirectorOutput: (message: GameRealtimeMessage) => void;
    readonly acceptMatchStartIntent: (intent: MatchStartIntent) => Promise<void>;
    readonly acceptMotionMessage: (senderId: string, message: GameRealtimeMessage) => void;
    readonly acceptPickup: (accepted: PickupAccepted) => void;
    readonly acceptPlayerHit: (accepted: PlayerHitAccepted) => void;
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly arenaSnapshotRef: RefObject<ArenaSnapshot | undefined>;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly setActiveEvent: Dispatch<SetStateAction<ArenaEvent | undefined>>;
    readonly setArenaSnapshot: Dispatch<SetStateAction<ArenaSnapshot | undefined>>;
    readonly setRemoteEvents: Dispatch<SetStateAction<readonly ArenaEvent[]>>;
}

export function createArenaMatchRuntime(
    input: ArenaMatchRuntimeInput,
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
