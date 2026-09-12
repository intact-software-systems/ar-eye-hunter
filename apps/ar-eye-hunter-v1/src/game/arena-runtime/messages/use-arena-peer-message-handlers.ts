import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { AuthSession } from '@shared/api/api-config.ts';

import {
    GAME_PROTOCOL,
    type ArenaEvent,
    type ArenaSnapshot,
    type GameRealtimeMessage,
    type RemotePlayer,
    type RemoteShot
} from '../../types.ts';
import { toValidatedPlayerPose } from '../state/to-validated-player-pose.ts';
import type { ArenaStateAcceptance } from '../state/use-arena-state-acceptance.ts';

interface ArenaPeerMessageHandlersInput
    extends Pick<ArenaStateAcceptance, 'acceptEyeAttack' | 'acceptPickup' | 'acceptPlayerHit'> {
    readonly nowMs: () => number;
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

export function useArenaPeerMessageHandlers(input: ArenaPeerMessageHandlersInput): ArenaPeerMessageHandlers {
    const acceptMotionMessage = useCallback(
        (peerId: string, message: GameRealtimeMessage) => acceptArenaMotion(input, peerId, message),
        [input.sessionRef, input.setRemotePlayers]
    );
    const acceptRealtimeMessage = useCallback(
        (peerId: string, message: GameRealtimeMessage) => acceptArenaRealtime(input, peerId, message),
        [input.acceptEyeAttack, input.acceptPickup, input.acceptPlayerHit]
    );
    return { acceptMotionMessage, acceptRealtimeMessage };
}

function acceptArenaMotion(input: ArenaPeerMessageHandlersInput, peerId: string, message: GameRealtimeMessage): void {
    if (message.protocol !== GAME_PROTOCOL) {
        return;
    }

    const nowEpochMs = input.nowMs();
    const currentSessionId = input.sessionRef.current?.sessionId;
    if (message.kind === 'player-pose') {
        const pose = toValidatedPlayerPose(message.pose);
        if (pose.sessionId === currentSessionId || pose.sessionId !== peerId) {
            return;
        }

        input.setRemotePlayers((previous) => {
            const next = new Map(previous);
            const existing = next.get(pose.sessionId);
            if (existing && existing.pose.seq > pose.seq) {
                return previous;
            }

            next.set(pose.sessionId, {
                pose,
                lastSeenEpochMs: nowEpochMs
            });
            return next;
        });
        return;
    }

    return;
}

function acceptArenaRealtime(input: ArenaPeerMessageHandlersInput, peerId: string, message: GameRealtimeMessage): void {
    if (message.protocol !== GAME_PROTOCOL || acceptArenaPeerShot(input, peerId, message)) {
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

    if (message.kind === 'director-arena-snapshot') {
        input.setArenaSnapshot(message.snapshot);
        input.setActiveEvent(message.snapshot.activeEvent);
        input.setRemoteEvents(message.snapshot.events);
    }
}

function acceptArenaPeerShot(
    input: ArenaPeerMessageHandlersInput,
    peerId: string,
    message: GameRealtimeMessage
): boolean {
    const nowEpochMs = input.nowMs();
    const currentSessionId = input.sessionRef.current?.sessionId;

    if (message.kind === 'player-shot') {
        const shot = message.shot;
        if (shot.sessionId === currentSessionId || shot.sessionId !== peerId) {
            return true;
        }

        input.setRemoteShots((previous) => [
            ...previous.slice(-24),
            {
                id: `${shot.sessionId}:${shot.seq}`,
                shot,
                receivedAtEpochMs: nowEpochMs
            }
        ]);
        return true;
    }

    if (message.kind === 'director-shot-accepted') {
        const accepted = message.accepted;
        if (accepted.shot.sessionId === currentSessionId) {
            return true;
        }

        input.setRemoteShots((previous) => [
            ...previous.slice(-32),
            {
                id: `${accepted.shot.sessionId}:${accepted.shot.seq}:${accepted.revision}`,
                shot: accepted.shot,
                accepted,
                receivedAtEpochMs: nowEpochMs
            }
        ]);
        return true;
    }

    return false;
}
