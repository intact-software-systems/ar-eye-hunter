import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { GAME_PROTOCOL, type ArenaEvent, type GameRealtimeMessage } from '../../types.ts';
import type { ArenaStateAcceptance } from '../state/use-arena-state-acceptance.ts';
import { acceptArenaDirectorPeerMessage, type ArenaDirectorPeerMessageInput } from './arena-director-peer-message.ts';

interface ArenaDirectorMessageHandlerInput
    extends
        ArenaDirectorPeerMessageInput,
        Pick<ArenaStateAcceptance, 'acceptEyeAttack' | 'acceptPickup' | 'acceptPlayerHit'> {
    readonly setActiveEvent: Dispatch<SetStateAction<ArenaEvent | undefined>>;
    readonly setRemoteEvents: Dispatch<SetStateAction<readonly ArenaEvent[]>>;
}

export function useArenaDirectorMessageHandler(
    input: ArenaDirectorMessageHandlerInput
): (message: GameRealtimeMessage, isCurrent: () => boolean) => void {
    return useCallback(
        (message: GameRealtimeMessage, isCurrent: () => boolean) =>
            acceptArenaDirectorOutput(input, message, isCurrent),
        [input.acceptEyeAttack, input.acceptPickup, input.acceptPlayerHit, input.nowMs]
    );
}

function acceptArenaDirectorOutput(
    input: ArenaDirectorMessageHandlerInput,
    message: GameRealtimeMessage,
    isCurrent: () => boolean
): void {
    if (!isCurrent() || message.protocol !== GAME_PROTOCOL) {
        return;
    }

    if (acceptArenaDirectorPeerMessage(input, message, isCurrent) || acceptArenaDirectorMatchUpdate(input, message)) {
        return;
    }

    if (message.kind === 'director-player-hit-accepted') {
        input.acceptPlayerHit(message.accepted);
        return;
    }

    if (message.kind === 'director-pickup-accepted') {
        input.acceptPickup(message.accepted);
        return;
    }

    if (message.kind === 'director-eye-attack-accepted') {
        input.acceptEyeAttack(message.accepted);
        return;
    }

    if (message.kind === 'arena-event') {
        input.setRemoteEvents((previous) => [
            ...previous.filter((event) => event.id !== message.event.id).slice(-12),
            message.event
        ]);
        input.setActiveEvent(message.event);
        return;
    }
}

function acceptArenaDirectorMatchUpdate(
    input: ArenaDirectorMessageHandlerInput,
    message: GameRealtimeMessage
): boolean {
    if (message.kind === 'director-match-started') {
        input.setArenaSnapshot((previous) => {
            if (!previous || message.accepted.revision < previous.revision) {
                return previous;
            }
            const next = {
                ...previous,
                revision: message.accepted.revision,
                match: message.accepted.match,
                activeEvent: {
                    id: `match-started:${message.accepted.match.matchId}`,
                    kind: 'match-started' as const,
                    startsAtEpochMs: message.accepted.acceptedAtEpochMs,
                    expiresAtEpochMs: message.accepted.acceptedAtEpochMs + 4_000,
                    revision: message.accepted.revision,
                    source: 'director' as const,
                    headline: 'Arena match started'
                }
            };
            input.arenaSnapshotRef.current = next;
            return next;
        });
        return true;
    }

    if (message.kind === 'director-match-ended') {
        input.setArenaSnapshot((previous) => {
            if (!previous || message.accepted.revision < previous.revision) {
                return previous;
            }
            const next = {
                ...previous,
                revision: message.accepted.revision,
                match: message.accepted.match
            };
            input.arenaSnapshotRef.current = next;
            return next;
        });
        return true;
    }

    return false;
}
