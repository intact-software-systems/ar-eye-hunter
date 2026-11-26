import { describe, expect, it } from 'vitest';

import {
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';

import { toOrderedSendMessage } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/to-ordered-send-message.ts';

const ROOM = { applicationId: 'ordered-send-cell', workspaceId: 'default', groupId: 'room-run-1' };
const CREATED_AT_EPOCH_MS = 1_800_000_000_000;

function createSeventhSend() {
    return toOrderedSendMessage({
        send: {
            msgId: 'session-04-a-send-7',
            publisherPeerId: 'session-04-a',
            publisherInstanceIndex: 0,
            seq: 7,
            dueOffsetMs: 3_100,
            expectedRecipientPeerIds: ['session-01-a', 'session-02-b']
        },
        roomRef: ROOM,
        createdAtEpochMs: CREATED_AT_EPOCH_MS
    });
}

/** The seventh send as a browser's `notification` channel hands it to its WS client, before that client plans it. */
function createSeventhSendBeforeItsClientPlansIt(traceId: string): ALMessage {
    return {
        id: { v: 4, msgId: 'session-04-a-send-7', ts: CREATED_AT_EPOCH_MS, senderId: 'session-04-a', traceId },
        route: { topicId: 'room.ordered-send', resourceId: 'session-04-a-send-7', contextId: 'room-run-1' },
        constraints: { expiresAtMs: 1_800_000_030_000 },
        qos: { durability: { algo: 'volatile' } },
        payload: { typeId: 'room.ordered-send', contentType: 'application/json', resource: '{"seq":7}' },
        audit: { createdBy: 'session-04-a', createdTs: CREATED_AT_EPOCH_MS },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        ordering: { orderingKey: '["ordered-send-cell","default","room-run-1"]', seq: 7 },
        delivery: { ownership: 'shared', reliability: 'at-least-once', ack: 'all-logical-recipients' }
    };
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
        expect(message.qos?.durability).toEqual({ algo: 'volatile' });
    });

    it('states the expiry the product\'s WS client writes into a frame: the envelope\'s own deadline', () => {
        const message = createSeventhSend();

        expect(message.qos?.expiry).toEqual({
            algo: 'expires-at',
            opts: { expiresAtMs: 1_800_000_030_000, maxStalenessMs: 60_000 }
        });
        expect(message.constraints).toEqual({ expiresAtMs: 1_800_000_030_000 });
    });

    it('is the message the product\'s WS client plans to write for the same send', () => {
        const message = createSeventhSend();

        const clientPlan = toWsQueueBoxClientDispatchPlan(createSeventhSendBeforeItsClientPlansIt(message.id.traceId), {
            sessionId: 'session-04-a',
            serverPeerId: 'default-qbox-server',
            socketOpen: true,
            nowMs: CREATED_AT_EPOCH_MS,
            backpressured: false,
            qosProvider: toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, undefined)
        });

        expect(clientPlan.dropReasonCode).toBeUndefined();
        expect(JSON.parse(JSON.stringify(message))).toEqual(JSON.parse(JSON.stringify(clientPlan.msg)));
    });

    it('passes the server\'s own decoding of an arriving envelope unchanged', () => {
        const message = createSeventhSend();

        const decoded = decodeALMessageValue(JSON.parse(JSON.stringify(message)));

        expect(decoded.left).toBeUndefined();
        expect(decoded.right).toEqual(JSON.parse(JSON.stringify(message)));
        expect(normalizeALQosPolicy(message).unmetRequirements).toEqual([]);
    });
});
