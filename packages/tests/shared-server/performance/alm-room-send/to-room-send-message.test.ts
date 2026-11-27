import { describe, expect, it } from 'vitest';

import {
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';

import type { RoomSendOrdering } from '../../../../../apps/api-v1/scripts/perf/alm-room-send/room-send-ordering.ts';
import { toRoomSendMessage } from '../../../../../apps/api-v1/scripts/perf/alm-room-send/to-room-send-message.ts';

const ROOM = { applicationId: 'room-send-cell', workspaceId: 'default', groupId: 'room-run-1' };
const CREATED_AT_EPOCH_MS = 1_800_000_000_000;

function createSeventhSend(ordering: RoomSendOrdering) {
    return toRoomSendMessage({
        send: {
            msgId: 'session-04-a-send-7',
            publisherPeerId: 'session-04-a',
            publisherInstanceIndex: 0,
            seq: 7,
            dueOffsetMs: 3_100,
            expectedRecipientPeerIds: ['session-01-a', 'session-02-b']
        },
        roomRef: ROOM,
        createdAtEpochMs: CREATED_AT_EPOCH_MS,
        ordering
    });
}

/**
 * The seventh send as a browser's `notification` channel hands it to its WS client when the send names no ordering
 * key, before that client plans it.
 */
function createUnorderedSeventhSendBeforeItsClientPlansIt(traceId: string): ALMessage {
    return {
        id: { v: 4, msgId: 'session-04-a-send-7', ts: CREATED_AT_EPOCH_MS, senderId: 'session-04-a', traceId },
        route: { topicId: 'room.cell-send', resourceId: 'session-04-a-send-7', contextId: 'room-run-1' },
        constraints: { expiresAtMs: 1_800_000_030_000 },
        qos: { durability: { algo: 'volatile' } },
        payload: { typeId: 'room.cell-send', contentType: 'application/json', resource: '{"seq":7}' },
        audit: { createdBy: 'session-04-a', createdTs: CREATED_AT_EPOCH_MS },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        delivery: { ownership: 'shared', reliability: 'at-least-once', ack: 'all-logical-recipients' }
    };
}

/** The same send when it names the room's ordering key, before its WS client plans it. */
function createOrderedSeventhSendBeforeItsClientPlansIt(traceId: string): ALMessage {
    return {
        ...createUnorderedSeventhSendBeforeItsClientPlansIt(traceId),
        ordering: { orderingKey: '["room-send-cell","default","room-run-1"]', seq: 7 }
    };
}

/** What the product's WS client plans for an envelope its `notification` channel hands it on an open socket. */
function planAsTheProductsWsClient(envelope: ALMessage) {
    return toWsQueueBoxClientDispatchPlan(envelope, {
        sessionId: 'session-04-a',
        serverPeerId: 'default-qbox-server',
        socketOpen: true,
        nowMs: CREATED_AT_EPOCH_MS,
        backpressured: false,
        qosProvider: toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, undefined)
    });
}

describe('toRoomSendMessage', () => {
    it('addresses the room as a broadcast of its publisher, under the msgId the schedule gave the send', () => {
        const message = createSeventhSend('ordering-key');

        expect(message.id).toMatchObject({ msgId: 'session-04-a-send-7', senderId: 'session-04-a', ts: 1_800_000_000_000 });
        expect(message.targets).toEqual({ mode: 'broadcast', scope: 'room', groupRef: ROOM });
        expect(message.route).toEqual({
            topicId: 'room.cell-send',
            contextId: 'room-run-1',
            resourceId: 'session-04-a-send-7'
        });
        expect(message.payload.typeId).toBe('room.cell-send');
    });

    it('places the send on its publisher\'s track of the room at the seq the schedule gave it', () => {
        expect(createSeventhSend('ordering-key').ordering).toEqual({
            orderingKey: '["room-send-cell","default","room-run-1"]',
            seq: 7
        });
    });

    it('offers an unordered send as the same notification envelope with no ordering key and no seq, and keeps its number in the payload', () => {
        const message = createSeventhSend('unordered');

        expect(JSON.parse(JSON.stringify(message))).toEqual({
            id: {
                v: 4,
                msgId: 'session-04-a-send-7',
                ts: 1_800_000_000_000,
                senderId: 'session-04-a',
                traceId: message.id.traceId
            },
            route: { topicId: 'room.cell-send', resourceId: 'session-04-a-send-7', contextId: 'room-run-1' },
            constraints: { expiresAtMs: 1_800_000_030_000 },
            qos: {
                durability: { algo: 'volatile' },
                expiry: { algo: 'expires-at', opts: { expiresAtMs: 1_800_000_030_000, maxStalenessMs: 60_000 } }
            },
            payload: { typeId: 'room.cell-send', contentType: 'application/json', resource: '{"seq":7}' },
            audit: { createdBy: 'session-04-a', createdTs: 1_800_000_000_000 },
            targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
            delivery: { ownership: 'shared', reliability: 'at-least-once', ack: 'all-logical-recipients' }
        });
    });

    it('asks what a notification channel asks: at least once, a receipt of every recipient, 30 s to live', () => {
        const message = createSeventhSend('ordering-key');

        expect(message.delivery).toEqual({ ownership: 'shared', reliability: 'at-least-once', ack: 'all-logical-recipients' });
        expect(message.constraints).toEqual({ expiresAtMs: 1_800_000_030_000 });
        expect(message.qos?.durability).toEqual({ algo: 'volatile' });
    });

    it('states the expiry the product\'s WS client writes into a frame: the envelope\'s own deadline', () => {
        const message = createSeventhSend('ordering-key');

        expect(message.qos?.expiry).toEqual({
            algo: 'expires-at',
            opts: { expiresAtMs: 1_800_000_030_000, maxStalenessMs: 60_000 }
        });
        expect(message.constraints).toEqual({ expiresAtMs: 1_800_000_030_000 });
    });

    it('is the message the product\'s WS client plans to write for the same send', () => {
        const message = createSeventhSend('ordering-key');

        const clientPlan = planAsTheProductsWsClient(createOrderedSeventhSendBeforeItsClientPlansIt(message.id.traceId));

        expect(clientPlan.dropReasonCode).toBeUndefined();
        expect(JSON.parse(JSON.stringify(message))).toEqual(JSON.parse(JSON.stringify(clientPlan.msg)));
    });

    it('is the message the product\'s WS client plans for an unordered send: a 2 s first-hop wait with three retries, four repairs, and no track', () => {
        const message = createSeventhSend('unordered');

        const clientPlan = planAsTheProductsWsClient(createUnorderedSeventhSendBeforeItsClientPlansIt(message.id.traceId));

        expect(clientPlan.dropReasonCode).toBeUndefined();
        expect(JSON.parse(JSON.stringify(message))).toEqual(JSON.parse(JSON.stringify(clientPlan.msg)));
        expect(clientPlan.firstHopTracking).toEqual({ timeoutMs: 2_000, maxAttempts: 3 });
        expect(clientPlan.repairTracking).toEqual({ enabled: true, algo: 'retransmit', maxAttempts: 4 });
        expect(toALOrderingTrackKey(message)).toBeUndefined();
    });

    it('passes the server\'s own decoding of an arriving envelope unchanged', () => {
        const message = createSeventhSend('ordering-key');

        const decoded = decodeALMessageValue(JSON.parse(JSON.stringify(message)));

        expect(decoded.left).toBeUndefined();
        expect(decoded.right).toEqual(JSON.parse(JSON.stringify(message)));
        expect(normalizeALQosPolicy(message).unmetRequirements).toEqual([]);
    });
});
