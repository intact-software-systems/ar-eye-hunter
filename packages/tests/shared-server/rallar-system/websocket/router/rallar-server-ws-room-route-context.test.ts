import { describe, expect, it } from 'vitest';

import { authorizeRallarServerWsIngress } from '@shared-server/rallar-system/websocket/router/decode-rallar-server-ws-ingress.ts';
import type { RallarServerWsRoomAuthorizer } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALPrincipalBroadcastMessage,
    newALRoute,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';

const ROOM = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const SENDER_ID = 'session-a';
const ROOM_SEND_SHAPES = ['unicast', 'multicast', 'room broadcast', 'principal broadcast'] as const;
const AUTHORIZE_EVERY_ROOM_SEND: RallarServerWsRoomAuthorizer = () => true;

type RoomSendShape = typeof ROOM_SEND_SHAPES[number];

describe('the WS ingress refusal of a room send whose route names another room (D82)', () => {
    it.each(ROOM_SEND_SHAPES)(
        'refuses a %s whose route names another room than its groupRef as unauthorized, whatever the room authorizer answers',
        async (shape) => {
            const authorization = await authorizeRoomSend(
                createRoomSend(shape, 'room-2'),
                AUTHORIZE_EVERY_ROOM_SEND
            );

            expect(authorization).toMatchObject({ authorized: false, reason: 'unauthorized' });
        }
    );

    it.each(ROOM_SEND_SHAPES)('authorizes the same %s when its route names its room', async (shape) => {
        const authorization = await authorizeRoomSend(
            createRoomSend(shape, ROOM.groupId),
            AUTHORIZE_EVERY_ROOM_SEND
        );

        expect(authorization).toMatchObject({ authorized: true });
    });

    it('keeps a room broadcast that carries no groupRef in the room its route names', async () => {
        const message = newALBroadcastMessage({
            ...createSendBase('room-1'),
            scope: 'room'
        });

        const authorization = await authorizeRoomSend(message, (input) => input.roomId === 'room-1');

        expect(authorization).toMatchObject({ authorized: true });
    });
});

async function authorizeRoomSend(
    message: ALMessage,
    authorizeRoomMessage: RallarServerWsRoomAuthorizer
): ReturnType<typeof authorizeRallarServerWsIngress> {
    return await authorizeRallarServerWsIngress({
        message,
        definition: undefined,
        topic: { participation: 'members' },
        senderId: SENDER_ID,
        authorizeRoomMessage
    });
}

function createRoomSend(shape: RoomSendShape, contextId: string): ALMessage {
    const base = createSendBase(contextId);
    switch (shape) {
        case 'unicast':
            return newALUnicastMessage({ ...base, toPeerId: 'session-b', options: { groupRef: ROOM } });
        case 'multicast':
            return newALMulticastMessage({ ...base, groupRef: ROOM });
        case 'room broadcast':
            return newALBroadcastMessage({ ...base, scope: 'room', options: { groupRef: ROOM } });
        case 'principal broadcast':
            return newALPrincipalBroadcastMessage({
                ...base,
                target: {
                    groupRef: ROOM,
                    principalRef: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId, principalId: 'principal-b' }
                }
            });
    }
}

function createSendBase(contextId: string) {
    return {
        senderId: SENDER_ID,
        createdAtEpochMs: 1_000,
        route: newALRoute('app.pose', contextId, 'pose-1'),
        typeId: 'pose.v1',
        resource: { x: 1 }
    };
}
