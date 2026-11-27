import { describe, expect, it } from 'vitest';

import type { RallarServerWsRoomAuthorizationInput } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { createRoomSendRoomAuthorizer } from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/instance/create-room-send-room-authorizer.ts';
import { toRoomSendMessage } from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/to-room-send-message.ts';

const ROOM = { applicationId: 'room-send-cell', workspaceId: 'default', groupId: 'room-run-1' };
const SESSION_PEER_IDS = ['session-01-a', 'session-02-b', 'session-03-c'];

function createAuthorizer() {
    return createRoomSendRoomAuthorizer({
        roomRef: ROOM,
        sessionPeerIds: SESSION_PEER_IDS,
        connectedAtEpochMs: 1_800_000_000_000,
        expiresAtEpochMs: 1_800_086_400_000
    });
}

function toAuthorizationInput(publisherPeerId: string, roomRef: GroupRef): RallarServerWsRoomAuthorizationInput {
    const message = toRoomSendMessage({
        send: {
            msgId: `${publisherPeerId}-send-1`,
            publisherPeerId,
            publisherInstanceIndex: 0,
            seq: 1,
            dueOffsetMs: 0,
            expectedRecipientPeerIds: []
        },
        roomRef,
        createdAtEpochMs: 1_800_000_000_500
    });
    return {
        message,
        topic: { participation: 'members' },
        roomId: roomRef.groupId,
        roomRef,
        senderId: publisherPeerId,
        topicId: message.route.topicId,
        typeId: message.payload.typeId
    };
}

describe('createRoomSendRoomAuthorizer', () => {
    it('admits a session\'s send to the room with every session of the room as its live audience', async () => {
        const input = toAuthorizationInput('session-02-b', ROOM);

        const decision = await createAuthorizer()(input);

        expect(decision).toMatchObject({ authorized: true, audience: { targets: input.message.targets, snapshotVersion: 1 } });
        const sessions = typeof decision === 'object' && decision.authorized ? decision.audience?.sessions ?? [] : [];
        expect(sessions.map((session) => [session.sessionId, session.status, session.expiresAtEpochMs, session.groupId]))
            .toEqual([
                ['session-01-a', 'active', 1_800_086_400_000, 'room-run-1'],
                ['session-02-b', 'active', 1_800_086_400_000, 'room-run-1'],
                ['session-03-c', 'active', 1_800_086_400_000, 'room-run-1']
            ]);
    });

    it('refuses a send that names another room', async () => {
        const otherRoom = { ...ROOM, groupId: 'room-run-2' };

        expect(await createAuthorizer()(toAuthorizationInput('session-02-b', otherRoom))).toBe(false);
    });

    it('refuses a send of a session that is not in the room', async () => {
        expect(await createAuthorizer()(toAuthorizationInput('session-99-z', ROOM))).toBe(false);
    });
});
