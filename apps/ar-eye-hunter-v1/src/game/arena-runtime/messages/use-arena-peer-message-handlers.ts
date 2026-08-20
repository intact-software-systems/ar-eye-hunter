import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';

import type { ArenaStateAcceptance } from '../state/use-arena-state-acceptance.ts';
import { withValidatedAvatarProfile } from '../arena-connection-helpers.ts';
import {
    type ArenaEvent,
    type ArenaSnapshot,
    GAME_PROTOCOL,
    type GameRealtimeMessage,
    type RemotePlayer,
    type RemoteShot,
} from '../../types.ts';

interface ArenaPeerMessageHandlersInput
    extends Pick<ArenaStateAcceptance, 'acceptEyeAttack' | 'acceptPickup' | 'acceptPlayerHit'> {
    readonly sessionRef: RefObject<AuthSession | undefined>;
    readonly setActiveEvent: Dispatch<SetStateAction<ArenaEvent | undefined>>;
    readonly setArenaSnapshot: Dispatch<SetStateAction<ArenaSnapshot | undefined>>;
    readonly setRemoteEvents: Dispatch<SetStateAction<readonly ArenaEvent[]>>;
    readonly setRemotePlayers: Dispatch<SetStateAction<ReadonlyMap<string, RemotePlayer>>>;
    readonly setRemoteShots: Dispatch<SetStateAction<readonly RemoteShot[]>>;
}

export interface ArenaPeerMessageHandlers {
    readonly acceptMotionMessage: (peerId: string, message: GameRealtimeMessage) => void;
    readonly acceptRealtimeMessage: (peerId: string, message: GameRealtimeMessage) => void;
}

export function useArenaPeerMessageHandlers(
    input: ArenaPeerMessageHandlersInput,
): ArenaPeerMessageHandlers {
    const {
        acceptEyeAttack,
        acceptPickup,
        acceptPlayerHit,
        sessionRef,
        setActiveEvent,
        setArenaSnapshot,
        setRemoteEvents,
        setRemotePlayers,
        setRemoteShots,
    } = input;

    const acceptMotionMessage = useCallback((
        peerId: string,
        message: GameRealtimeMessage,
    ) => {
        if (message.protocol !== GAME_PROTOCOL) {
            return;
        }

        const currentSessionId = sessionRef.current?.sessionId;
        if (message.kind === 'player-pose') {
            const pose = withValidatedAvatarProfile(message.pose);
            if (pose.sessionId === currentSessionId || pose.sessionId !== peerId) {
                return;
            }

            setRemotePlayers((previous) => {
                const next = new Map(previous);
                const existing = next.get(pose.sessionId);
                if (existing && existing.pose.seq > pose.seq) {
                    return previous;
                }

                next.set(pose.sessionId, {
                    pose,
                    lastSeenEpochMs: Date.now(),
                });
                return next;
            });
            return;
        }

        return;
    }, [acceptPickup, acceptPlayerHit]);

    const acceptRealtimeMessage = useCallback((
        peerId: string,
        message: GameRealtimeMessage,
    ) => {
        if (message.protocol !== GAME_PROTOCOL) {
            return;
        }

        const currentSessionId = sessionRef.current?.sessionId;

        if (message.kind === 'player-shot') {
            const shot = message.shot;
            if (shot.sessionId === currentSessionId || shot.sessionId !== peerId) {
                return;
            }

            setRemoteShots((previous) => [
                ...previous.slice(-24),
                {
                    id: `${shot.sessionId}:${shot.seq}`,
                    shot,
                    receivedAtEpochMs: Date.now(),
                },
            ]);
            return;
        }

        if (message.kind === 'director-shot-accepted') {
            const accepted = message.accepted;
            if (accepted.shot.sessionId === currentSessionId) {
                return;
            }

            setRemoteShots((previous) => [
                ...previous.slice(-32),
                {
                    id: `${accepted.shot.sessionId}:${accepted.shot.seq}:${accepted.revision}`,
                    shot: accepted.shot,
                    accepted,
                    receivedAtEpochMs: Date.now(),
                },
            ]);
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

        if (message.kind === 'director-eye-attack-accepted') {
            acceptEyeAttack(message.accepted);
            return;
        }

        if (message.kind === 'arena-event') {
            setRemoteEvents((previous) => [
                ...previous.filter((event) => event.id !== message.event.id).slice(-12),
                message.event,
            ]);
            setActiveEvent(message.event);
            return;
        }

        if (message.kind === 'director-arena-snapshot') {
            setArenaSnapshot(message.snapshot);
            setActiveEvent(message.snapshot.activeEvent);
            setRemoteEvents(message.snapshot.events);
        }
    }, [acceptEyeAttack, acceptPickup, acceptPlayerHit]);

    return { acceptMotionMessage, acceptRealtimeMessage };
}
