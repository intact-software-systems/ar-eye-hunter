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
): (message: GameRealtimeMessage) => void {
    const {
        acceptEyeAttack,
        acceptPickup,
        acceptPlayerHit,
        arenaSnapshotRef,
        roomIdRef,
        sessionRef,
        setActiveEvent,
        setArenaSnapshot,
        setRemoteEvents,
        setRemotePlayers,
        setRemoteShots
    } = input;

    const acceptDirectorOutput = useCallback((
        message: GameRealtimeMessage
    ) => {
        if (message.protocol !== GAME_PROTOCOL) {
            return;
        }

        if (
            acceptArenaDirectorPeerMessage({
                arenaSnapshotRef,
                roomIdRef,
                sessionRef,
                setArenaSnapshot,
                setRemotePlayers,
                setRemoteShots
            }, message)
        ) {
            return;
        }

        if (message.kind === 'director-player-hit-accepted') {
            acceptPlayerHit(message.accepted);
            return;
        }

        if (message.kind === 'director-pickup-accepted') {
            acceptPickup(message.accepted);
            return;
        }

        if (message.kind === 'director-match-started') {
            setArenaSnapshot((previous) => {
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
                arenaSnapshotRef.current = next;
                return next;
            });
            return;
        }

        if (message.kind === 'director-match-ended') {
            setArenaSnapshot((previous) => {
                if (!previous || message.accepted.revision < previous.revision) {
                    return previous;
                }
                const next = {
                    ...previous,
                    revision: message.accepted.revision,
                    match: message.accepted.match
                };
                arenaSnapshotRef.current = next;
                return next;
            });
            return;
        }

        if (message.kind === 'director-eye-attack-accepted') {
            acceptEyeAttack(message.accepted);
            return;
        }

        if (message.kind === 'arena-event') {
            setRemoteEvents((previous) => [
                ...previous.filter((event) => event.id !== message.event.id).slice(-12),
                message.event
            ]);
            setActiveEvent(message.event);
            return;
        }

        if (message.kind === 'director-arena-snapshot') {
            setArenaSnapshot(message.snapshot);
            setActiveEvent(message.snapshot.activeEvent);
            setRemoteEvents(message.snapshot.events);
            return;
        }
    }, [acceptEyeAttack, acceptPickup, acceptPlayerHit]);

    return acceptDirectorOutput;
}
