import { describe, expect, it, vi } from 'vitest';

import type { RallarServerWsRoomAudience } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { readRallarServerWsPublishAudience } from '@shared-server/rallar-system/websocket/router/read-rallar-server-ws-publish-audience.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const NOTIFICATION = newALBroadcastMessage(
    'server',
    newALRoute('room.snapshot', 'room-1', 'round-1'),
    'room',
    'snapshot.v1',
    {},
    {
        groupRef: ROOM,
        reliability: 'at-least-once',
        ack: 'receiver',
        ttlMs: 15_000
    }
);
const AUDIENCE: RallarServerWsRoomAudience = {
    targets: NOTIFICATION.targets!,
    sessions: [{ sessionId: 'b' }, {
        sessionId: 'c'
    }] as unknown as RallarServerWsRoomAudience['sessions'],
    snapshotVersion: 4
};

describe('the audience a server publish is frozen to (D58, Q7, C8)', () => {
    it('freezes the server\'s own outbox room notification to the room\'s live sessions', async () => {
        const readRoomAudience = vi.fn(async () => AUDIENCE);

        const frozen = await readRallarServerWsPublishAudience({
            message: NOTIFICATION,
            fanout: 'outbox',
            serverPeerId: 'server',
            readRoomAudience
        });

        expect(frozen).toEqual({ current: AUDIENCE, admittedPeerIds: ['b', 'c'] });
        expect(readRoomAudience).toHaveBeenCalledWith(NOTIFICATION);
    });

    it.each<[string, ALMessage, 'outbox' | 'live-only']>([
        ['a live-only publish', NOTIFICATION, 'live-only'],
        ['a notification another sender publishes', {
            ...NOTIFICATION,
            id: { ...NOTIFICATION.id, senderId: 'relic-hunter-server' }
        }, 'outbox'],
        [
            'a world broadcast',
            { ...NOTIFICATION, targets: { mode: 'broadcast', scope: 'world' } },
            'outbox'
        ]
    ])('leaves %s to resolve its audience at dequeue', async (_name, message, fanout) => {
        const readRoomAudience = vi.fn(async () => AUDIENCE);

        expect(
            await readRallarServerWsPublishAudience({
                message,
                fanout,
                serverPeerId: 'server',
                readRoomAudience
            })
        ).toBeUndefined();
        expect(readRoomAudience).not.toHaveBeenCalled();
    });

    it('freezes nothing when the router has no audience reader or the room has none to read', async () => {
        expect(
            await readRallarServerWsPublishAudience({
                message: NOTIFICATION,
                fanout: 'outbox',
                serverPeerId: 'server',
                readRoomAudience: undefined
            })
        )
            .toBeUndefined();
        expect(
            await readRallarServerWsPublishAudience({
                message: NOTIFICATION,
                fanout: 'outbox',
                serverPeerId: 'server',
                readRoomAudience: async () => undefined
            })
        )
            .toBeUndefined();
    });
});
