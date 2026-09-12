import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { GAME_PROTOCOL, type GameRealtimeMessage, type RemotePlayer, type RemoteShot } from '../../types.ts';
import { toValidatedPlayerPose } from '../state/to-validated-player-pose.ts';
import { acceptArenaDirectorShot } from './arena-director-peer-message.ts';

export interface ArenaPeerShotMessage extends Extract<GameRealtimeMessage, { kind: 'director-shot-accepted'; }> {
    readonly roomRef: GroupRef;
}

export interface ArenaPeerShotReception {
    readonly peerId: string;
    readonly message: ArenaPeerShotMessage;
    readonly roomRef: GroupRef;
    readonly isCurrent: () => boolean;
}

interface ArenaPeerMessageHandlersInput {
    readonly nowMs: () => number;
    readonly sessionRef: RefObject<AuthSession | undefined>;
    readonly setRemotePlayers: Dispatch<SetStateAction<ReadonlyMap<string, RemotePlayer>>>;
    readonly setRemoteShots: Dispatch<SetStateAction<readonly RemoteShot[]>>;
}

export interface ArenaPeerMessageHandlers {
    readonly acceptMotionMessage: (peerId: string, message: GameRealtimeMessage) => void;
    readonly acceptPeerShot: (reception: ArenaPeerShotReception) => void;
}

export function useArenaPeerMessageHandlers(input: ArenaPeerMessageHandlersInput): ArenaPeerMessageHandlers {
    const acceptMotionMessage = useCallback(
        (peerId: string, message: GameRealtimeMessage) => acceptArenaMotion(input, peerId, message),
        [input.nowMs, input.sessionRef, input.setRemotePlayers]
    );
    const acceptPeerShot = useCallback((reception: ArenaPeerShotReception) => {
        const { message, roomRef, peerId, isCurrent } = reception;
        if (
            !isCurrent() || message?.protocol !== GAME_PROTOCOL || message.kind !== 'director-shot-accepted' ||
            !message.roomRef || typeof message.roomRef.applicationId !== 'string' ||
            typeof message.roomRef.workspaceId !== 'string' || typeof message.roomRef.groupId !== 'string' ||
            !isSameGroupRef(message.roomRef, roomRef)
        ) {
            return;
        }
        if (message.accepted?.shot?.sessionId !== peerId) {
            return;
        }
        acceptArenaDirectorShot(input, message, isCurrent);
    }, [input.nowMs, input.sessionRef, input.setRemoteShots]);
    return { acceptMotionMessage, acceptPeerShot };
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
