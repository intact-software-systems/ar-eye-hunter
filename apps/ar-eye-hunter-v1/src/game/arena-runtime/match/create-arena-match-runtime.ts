import type { Dispatch, RefObject, SetStateAction } from 'react';

import { rallar } from '@shared-web/browser/rallar.ts';

import { createArenaRallarGameMatch, type ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type { ArenaEvent, ArenaSnapshot, GameRealtimeMessage } from '../../types.ts';
import type { ArenaPeerMessageHandlers } from '../messages/use-arena-peer-message-handlers.ts';
import type { ArenaStateAcceptance } from '../state/use-arena-state-acceptance.ts';
import { acceptArenaMatchInput } from './handlers/accept-arena-match-input.ts';
import { acceptArenaMatchIntent } from './handlers/accept-arena-match-intent.ts';

export interface ArenaMatchRuntimeInput
    extends
        Pick<ArenaStateAcceptance, 'acceptMatchStartIntent' | 'acceptPickup' | 'acceptPlayerHit'>,
        ArenaPeerMessageHandlers {
    readonly nowMs: () => number;
    readonly acceptDirectorOutput: (message: GameRealtimeMessage, isCurrent: () => boolean) => void;
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
                input.acceptMotionMessage(envelope.senderId, envelope.payload, isCurrent);
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
            input.setArenaSnapshot((previous) => isCurrent() ? envelope.payload : previous);
            input.setActiveEvent((previous) => isCurrent() ? envelope.payload.activeEvent : previous);
            input.setRemoteEvents((previous) => isCurrent() ? envelope.payload.events : previous);
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
