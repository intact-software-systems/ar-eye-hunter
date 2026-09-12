import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { AuthSession } from '@shared/api/api-config.ts';

import { hydrateArenaSnapshot, toArenaSnapshot, upsertPlayerPose } from '../../simulation.ts';
import type { ArenaSnapshot, GameRealtimeMessage, RemotePlayer, RemoteShot } from '../../types.ts';
import { toValidatedPlayerPose } from '../state/to-validated-player-pose.ts';

export interface ArenaDirectorPeerMessageInput {
    readonly nowMs: () => number;
    readonly arenaSnapshotRef: RefObject<ArenaSnapshot | undefined>;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly sessionRef: RefObject<AuthSession | undefined>;
    readonly setArenaSnapshot: Dispatch<SetStateAction<ArenaSnapshot | undefined>>;
    readonly setRemotePlayers: Dispatch<SetStateAction<ReadonlyMap<string, RemotePlayer>>>;
    readonly setRemoteShots: Dispatch<SetStateAction<readonly RemoteShot[]>>;
}

export function acceptArenaDirectorPeerMessage(
    input: ArenaDirectorPeerMessageInput,
    message: GameRealtimeMessage
): boolean {
    const nowEpochMs = input.nowMs();
    const currentSessionId = input.sessionRef.current?.sessionId;
    if (message.kind === 'director-player-state') {
        const pose = toValidatedPlayerPose(message.pose);
        if (pose.sessionId === currentSessionId) {
            return true;
        }
        input.setRemotePlayers((previous) => {
            const next = new Map(previous);
            const existing = next.get(pose.sessionId);
            if (existing && existing.pose.seq > pose.seq) {
                return previous;
            }
            next.set(pose.sessionId, { pose, lastSeenEpochMs: nowEpochMs });
            return next;
        });
        input.setArenaSnapshot((previous) => {
            if (!previous) {
                return previous;
            }
            const next = toArenaSnapshot(
                upsertPlayerPose(hydrateArenaSnapshot(previous), pose, nowEpochMs),
                previous.roomId ?? input.roomIdRef.current,
                nowEpochMs
            );
            input.arenaSnapshotRef.current = next;
            return next;
        });
        return true;
    }
    if (acceptArenaDirectorShot(input, message)) {
        return true;
    }
    if (message.kind === 'director-state-snapshot') {
        input.setRemotePlayers(
            new Map(
                message.players
                    .filter((pose) => pose.sessionId !== currentSessionId)
                    .map((pose) => [
                        pose.sessionId,
                        {
                            pose: toValidatedPlayerPose(pose),
                            lastSeenEpochMs: nowEpochMs
                        }
                    ])
            )
        );
        return true;
    }
    return false;
}

function acceptArenaDirectorShot(input: ArenaDirectorPeerMessageInput, message: GameRealtimeMessage): boolean {
    const nowEpochMs = input.nowMs();
    const currentSessionId = input.sessionRef.current?.sessionId;
    if (message.kind === 'director-shot-event') {
        const shot = message.shot;
        if (shot.sessionId !== currentSessionId) {
            input.setRemoteShots((previous) => [
                ...previous.slice(-24),
                {
                    id: `${shot.sessionId}:${shot.seq}`,
                    shot,
                    receivedAtEpochMs: nowEpochMs
                }
            ]);
        }
        return true;
    }
    if (message.kind === 'director-shot-accepted') {
        const accepted = message.accepted;
        if (accepted.shot.sessionId !== currentSessionId) {
            input.setRemoteShots((previous) => [
                ...previous.slice(-32),
                {
                    id: `${accepted.shot.sessionId}:${accepted.shot.seq}:${accepted.revision}`,
                    shot: accepted.shot,
                    accepted,
                    receivedAtEpochMs: nowEpochMs
                }
            ]);
        }
        return true;
    }
    return false;
}
