import type { SetStateAction } from 'react';
import { describe, expect, it } from 'vitest';

import {
    acceptArenaDirectorPeerMessage,
    type ArenaDirectorPeerMessageInput
} from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/messages/arena-director-peer-message.ts';
import type { GameRealtimeMessage, RemoteShot } from '../../../apps/ar-eye-hunter-v1/src/game/types.ts';

describe('accepted arena shot projection lifetime', () => {
    it.each([true, false])('applies a deferred accepted-shot update only while its owner is current (%s)', (current) => {
        const updates: SetStateAction<readonly RemoteShot[]>[] = [];
        let isCurrent = true;
        const input: ArenaDirectorPeerMessageInput = {
            nowMs: () => 5000,
            arenaSnapshotRef: { current: undefined },
            roomIdRef: { current: 'arena-1' },
            sessionRef: { current: undefined },
            setArenaSnapshot: () => {},
            setRemotePlayers: () => {},
            setRemoteShots: (update) => updates.push(update)
        };
        const message: GameRealtimeMessage = {
            protocol: 'ar-eye-hunter.v1',
            kind: 'director-shot-accepted',
            accepted: {
                shot: { sessionId: 'peer', username: 'peer', color: '#00ffaa', origin: [0, 2, 0], direction: [0, 0, 1], seq: 1, sentAtEpochMs: 1000 },
                hit: true,
                impact: [0, 2, 4],
                scoreDelta: 120,
                combo: 2,
                multiplier: 1,
                overdrive: 20,
                revision: 3,
                acceptedAtEpochMs: 1000
            }
        };
        acceptArenaDirectorPeerMessage(input, message, () => isCurrent);
        isCurrent = current;
        const shots = updates.reduce<readonly RemoteShot[]>((previous, update) => typeof update === 'function' ? update(previous) : update, []);
        expect(shots).toEqual(current ? [{ id: 'peer:1:3', shot: message.accepted.shot, accepted: message.accepted, receivedAtEpochMs: 5000 }] : []);
    });
});
