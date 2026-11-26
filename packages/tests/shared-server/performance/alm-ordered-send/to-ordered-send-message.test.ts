import { describe, expect, it } from 'vitest';

import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';

import { toOrderedSendMessage } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/to-ordered-send-message.ts';

const ROOM = { applicationId: 'ordered-send-cell', workspaceId: 'default', groupId: 'room-run-1' };
const CREATED_AT_EPOCH_MS = 1_800_000_000_000;

function createSeventhSend() {
    return toOrderedSendMessage({
        send: {
            msgId: 'session-04-a-send-7',
            publisherPeerId: 'session-04-a',
            seq: 7,
            dueOffsetMs: 3_100,
            expectedRecipientPeerIds: ['session-01-a', 'session-02-b']
        },
        roomRef: ROOM,
        createdAtEpochMs: CREATED_AT_EPOCH_MS
    });
}

describe('toOrderedSendMessage', () => {
    it('addresses the room as a broadcast of its publisher, under the msgId the schedule gave the send', () => {
        const message = createSeventhSend();

        expect(message.id).toMatchObject({ msgId: 'session-04-a-send-7', senderId: 'session-04-a', ts: 1_800_000_000_000 });
        expect(message.targets).toEqual({ mode: 'broadcast', scope: 'room', groupRef: ROOM });
        expect(message.route).toEqual({
            topicId: 'room.ordered-send',
            contextId: 'room-run-1',
            resourceId: 'session-04-a-send-7'
        });
        expect(message.payload.typeId).toBe('room.ordered-send');
    });

    it('places the send on its publisher\'s track of the room at the seq the schedule gave it', () => {
        expect(createSeventhSend().ordering).toEqual({
            orderingKey: '["ordered-send-cell","default","room-run-1"]',
            seq: 7
        });
    });

    it('asks what a notification channel asks: at least once, a receipt of every recipient, 30 s to live', () => {
        const message = createSeventhSend();

        expect(message.delivery).toEqual({ ownership: 'shared', reliability: 'at-least-once', ack: 'all-logical-recipients' });
        expect(message.constraints).toEqual({ expiresAtMs: 1_800_000_030_000 });
        expect(message.qos).toEqual({ durability: { algo: 'volatile' } });
    });

    it('passes the server\'s own decoding of an arriving envelope unchanged', () => {
        const message = createSeventhSend();

        const decoded = decodeALMessageValue(JSON.parse(JSON.stringify(message)));

        expect(decoded.left).toBeUndefined();
        expect(decoded.right).toEqual(JSON.parse(JSON.stringify(message)));
        expect(normalizeALQosPolicy(message).unmetRequirements).toEqual([]);
    });
});
