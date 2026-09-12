import type { Dispatch, RefObject, SetStateAction } from 'react';

import { rallar } from '@shared-web/browser/rallar.ts';

import { createArenaRallarGameMatch, type ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type {
    ArenaEvent,
    ArenaSnapshot,
    GameRealtimeMessage,
    MatchStartIntent,
    PickupAccepted,
    PlayerHitAccepted
} from '../../types.ts';
import type { ArenaPeerShotReception } from '../messages/use-arena-peer-message-handlers.ts';
import { acceptArenaMatchInput } from './handlers/accept-arena-match-input.ts';
import { acceptArenaMatchIntent } from './handlers/accept-arena-match-intent.ts';

export interface ArenaMatchRuntimeInput {
    readonly nowMs: () => number;
    readonly acceptDirectorOutput: (message: GameRealtimeMessage, isCurrent: () => boolean) => void;
    readonly acceptPeerShot: (reception: ArenaPeerShotReception) => void;
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
    roomId: string
): ArenaRallarGameMatchHandle {
    const isCurrent = () => input.isCurrentNetworkGeneration(generation);
    return createArenaRallarGameMatch({
        rallar,
        roomId,
        readSnapshot: () => input.arenaSnapshotRef.current,
        onPresence: (envelope) => {
            if (isCurrent()) {
                input.acceptMotionMessage(envelope.senderId, envelope.payload);
            }
        },
        onInput: (envelope) => acceptArenaMatchInput(input, generation, envelope),
        onIntent: (envelope) => acceptArenaMatchIntent(input, generation, envelope),
        onEvent: (envelope) => {
            if (isCurrent()) {
                input.acceptDirectorOutput(envelope.payload, isCurrent);
            }
        },
        onSnapshot: (envelope) => {
            if (!isCurrent()) {
                return;
            }
            input.setArenaSnapshot(envelope.payload);
            input.setActiveEvent(envelope.payload.activeEvent);
            input.setRemoteEvents(envelope.payload.events);
        },
        onSyncRequest: async () => {
            if (!isCurrent()) {
                return;
            }
            const snapshot = input.arenaSnapshotRef.current;
            if (snapshot) {
                await input.arenaMatchRef.current?.publishSnapshot(snapshot, { reliable: true });
            }
        }
    });
}
