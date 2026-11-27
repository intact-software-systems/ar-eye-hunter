import { newALMulticastMessage, type ALAckMode, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import type { ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';

import { INBOUND_TEST_SELF_PEER_ID, INBOUND_TEST_SENDER_PEER_ID } from './inbound-runtime-test-fixture.ts';

/** A room multicast from the fixture's sender frozen to the receiver, asking `ack`. */
export function createInboundTestRoomMessage(msgId: string, ack: ALAckMode, durability: ALDurabilityAlgo): ALMessage {
    const message = newALMulticastMessage({
        createdAtEpochMs: Date.now(),
        senderId: INBOUND_TEST_SENDER_PEER_ID,
        route: { topicId: 'chat', resourceId: msgId, contextId: 'room' },
        groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
        typeId: 'chat.message.v1',
        resource: { text: msgId },
        options: {
            ack,
            reliability: ack === 'none' ? 'best-effort' : 'at-least-once',
            ttlMs: 60_000,
            qos: { durability: { algo: durability } }
        }
    });
    return {
        ...toALFrozenMulticastMessage(message, { recipientPeerIds: [INBOUND_TEST_SELF_PEER_ID], snapshotVersion: 1 }),
        id: { ...message.id, msgId }
    };
}

/** The forger's copy of `origin`: the origin's id and audience, its own content, asking no receipt. */
export function toInboundTestForgedCopy(origin: ALMessage): ALMessage {
    return {
        ...origin,
        payload: { ...origin.payload, resource: toInboundTestForgedText(origin) },
        delivery: { reliability: 'best-effort', ack: 'none' }
    };
}

export function toInboundTestForgedText(origin: ALMessage): string {
    return JSON.stringify({ text: `forged ${origin.id.msgId}` });
}
