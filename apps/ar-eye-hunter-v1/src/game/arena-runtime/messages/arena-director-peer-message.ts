import type { AuthSession } from '@shared/api/api-config.ts';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import { hydrateArenaSnapshot, toArenaSnapshot, upsertPlayerPose } from '../../simulation.ts';
import type { ArenaSnapshot, GameRealtimeMessage, RemotePlayer, RemoteShot } from '../../types.ts';
import { withValidatedAvatarProfile } from '../arena-connection-helpers.ts';

export interface ArenaDirectorPeerMessageInput {
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
    const currentSessionId = input.sessionRef.current?.sessionId;
    if (message.kind === 'director-player-state') {
        const pose = withValidatedAvatarProfile(message.pose);
        if (pose.sessionId === currentSessionId) {
            return true;
        }
        input.setRemotePlayers((previous) => {
            const next = new Map(previous);
            const existing = next.get(pose.sessionId);
            if (existing && existing.pose.seq > pose.seq) {
                return previous;
            }
            next.set(pose.sessionId, { pose, lastSeenEpochMs: Date.now() });
            return next;
        });
        input.setArenaSnapshot((previous) => {
            if (!previous) {
                return previous;
            }
            const next = toArenaSnapshot(
                upsertPlayerPose(hydrateArenaSnapshot(previous), pose, Date.now()),
                previous.roomId ?? input.roomIdRef.current,
                Date.now()
            );
            input.arenaSnapshotRef.current = next;
            return next;
        });
        return true;
    }
    if (message.kind === 'director-shot-event') {
        const shot = message.shot;
        if (shot.sessionId !== currentSessionId) {
            input.setRemoteShots((previous) => [
                ...previous.slice(-24),
                {
                    id: `${shot.sessionId}:${shot.seq}`,
                    shot,
                    receivedAtEpochMs: Date.now()
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
                    receivedAtEpochMs: Date.now()
                }
            ]);
        }
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
                            pose: withValidatedAvatarProfile(pose),
                            lastSeenEpochMs: Date.now()
                        }
                    ])
            )
        );
        return true;
    }
    return false;
}
