import assert from 'node:assert/strict';

import {
    newALEventRoute,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { createGroupSnapshot } from '../../../../packages/tests/shared-server/rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';
import {
    createLiveRoomRuntime,
    readOriginReceipts,
    receiverAck,
    waitForRoomSends,
    type RoomLiveSend
} from './ws-room-live-runtime.ts';
import { putRoomSnapshot } from './ws-room-test-runtime.ts';

Deno.test('a receiver room unicast reaches only its addressee and its receipt names the addressee alone (D53)', async () => {
    const snapshot = createGroupSnapshot(2, ['session-1', 'session-2', 'session-3']);
    const runtime = createLiveRoomRuntime(Date.now());
    try {
        await putRoomSnapshot(runtime.repository, snapshot);
        runtime.cache.observe(snapshot);
        runtime.router.install();
        const message = roomUnicast(snapshot.group, 'unicast-1', 'session-2');

        assert.deepEqual(
            (await runtime.service.acceptIncomingMessage(message, 'session-1')).right,
            { kind: 'admitted' }
        );
        await waitForRoomSends(() => roomSends(runtime.sent).length >= 1);
        await runtime.service.acceptIncomingMessage(receiverAck(message, 'session-2'), 'session-2');
        await waitForRoomSends(() => readOriginReceipts(runtime.sent).length >= 2);

        assert.deepEqual(roomSends(runtime.sent), [{
            sessionId: 'session-2',
            encoded: JSON.stringify(message)
        }]);
        assert.deepEqual(
            readOriginReceipts(runtime.sent).map((
                receipt
            ) => [
                receipt.phase,
                receipt.expectedRecipientPeerIds,
                receipt.confirmedRecipientPeerIds
            ]),
            [['admitted', ['session-2'], []], ['complete', ['session-2'], ['session-2']]]
        );
    }
    finally {
        runtime.service.dispose();
        await runtime.manager.clear();
    }
});

Deno.test('a room unicast to a session outside the room is refused before admission (Q5)', async () => {
    const snapshot = createGroupSnapshot(2, ['session-1', 'session-2']);
    const runtime = createLiveRoomRuntime(Date.now());
    try {
        await putRoomSnapshot(runtime.repository, snapshot);
        runtime.cache.observe(snapshot);
        runtime.router.install();

        const refused = await runtime.service.acceptIncomingMessage(
            roomUnicast(snapshot.group, 'unicast-2', 'outsider'),
            'session-1'
        );
        await waitForRoomSends(() => false);

        assert.equal(refused.left?.code, 'unauthorized');
        assert.deepEqual(roomSends(runtime.sent), []);
        assert.deepEqual(readOriginReceipts(runtime.sent), []);
    }
    finally {
        runtime.service.dispose();
        await runtime.manager.clear();
    }
});

function roomUnicast(groupRef: GroupRef, resourceId: string, toPeerId: string): ALMessage {
    return newALUnicastMessage(
        'session-1',
        newALEventRoute('room.chat', groupRef.groupId, resourceId),
        toPeerId,
        'chat.message.v1',
        {
            text: 'for you'
        },
        { groupRef, ttlMs: 30_000, reliability: 'at-least-once', ack: 'receiver' }
    );
}

function roomSends(sent: readonly RoomLiveSend[]): readonly RoomLiveSend[] {
    return sent.filter((send) => decodePersistedALMessage(send.encoded).route.topicId === 'room.chat');
}
