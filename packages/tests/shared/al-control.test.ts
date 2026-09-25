import {
    describe,
    expect,
    it
} from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_CONTROL_ACK_TYPE_ID,
    AL_CONTROL_NACK_TYPE_ID,
    AL_CONTROL_RECEIPT_TYPE_ID,
    AL_CONTROL_REPAIR_TYPE_ID,
    isALControlTypeId
} from '@shared/al-contracts/al-control-type-ids.ts';
import {
    decodeALControlMessage,
    newALAckControlMessage,
    newALNackControlMessage,
    newALReceiptControlMessage,
    newALRepairControlMessage,
    parseALControlMessage,
    prepareALNackControlMessage,
    type ALAckPayload,
    type ALControlPayload,
    type ALNackPayload,
    type ALReceiptPayload,
    type ALRepairPayload
} from '@shared/al-contracts/al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';

const ack: ALAckPayload = {
    ackedMsgId: 'msg-1',
    fromPeerId: 'sender',
    toPeerId: 'receiver',
    originPeerId: 'receiver',
    logicalRecipientPeerId: 'sender',
    status: 'delivered',
    observedAtEpochMs: 12,
    carrier: 'ws'
};
const nack: ALNackPayload = {
    msgId: 'msg-1',
    fromPeerId: 'sender',
    toPeerId: 'receiver',
    reason: 'resync-required',
    observedAtEpochMs: 13,
    orderingKey: 'track',
    expectedSeq: 2,
    missingSeqs: []
};
const repair: ALRepairPayload = {
    msgId: 'msg-1',
    fromPeerId: 'sender',
    toPeerId: 'receiver',
    reason: 'resync',
    observedAtEpochMs: 14,
    orderingKey: 'track',
    expectedSeq: 2,
    missingSeqs: [2]
};
const receipt: ALReceiptPayload = {
    msgId: 'msg-1',
    originPeerId: 'origin',
    expectedRecipientPeerIds: ['recipient-b', 'recipient-c'],
    confirmedRecipientPeerIds: ['recipient-b'],
    snapshotVersion: 7,
    phase: 'complete',
    observedAtEpochMs: 15
};
const controlId: ALMessage['id'] = {
    v: 2,
    msgId: 'control-1',
    ts: 11,
    senderId: 'sender'
};

describe('AL control message codec', () => {
    it('names the v2 acknowledgement and the receipt control as the four supported control ids', () => {
        expect(AL_CONTROL_ACK_TYPE_ID).toBe('al.control.ack.v2');
        expect(AL_CONTROL_RECEIPT_TYPE_ID).toBe('al.control.receipt.v1');
        expect(['al.control.ack.v2', 'al.control.nack.v1', 'al.control.repair.v1', 'al.control.receipt.v1']
            .every(isALControlTypeId)).toBe(true);
        expect(isALControlTypeId('al.control.ack.v1')).toBe(false);
    });

    it('refuses a v1 acknowledgement as unsupported', () => {
        const v2 = newALAckControlMessage(controlId, ack);
        const v1 = { ...v2, payload: { ...v2.payload, typeId: 'al.control.ack.v1' } };
        expect(decodeALControlMessage(v1).left).toMatchObject({ code: 'unsupported' });
    });

    it.each(['originPeerId', 'logicalRecipientPeerId'] as const)('requires a v2 acknowledgement to name its %s', (field) => {
        const { [field]: _omitted, ...partial } = ack;
        expect(() => parseALControlMessage(controlMessageWithResource(AL_CONTROL_ACK_TYPE_ID, JSON.stringify(partial))))
            .toThrow(TypeError);
    });

    it('round-trips a v2 acknowledgement with its origin and logical recipient', () => {
        const message = newALAckControlMessage(controlId, ack);
        expect(message.payload.typeId).toBe('al.control.ack.v2');
        expect(decodeALControlMessage(message).right).toEqual({ type: 'ack', payload: ack });
    });

    it('round-trips a receipt addressed and routed to its origin', () => {
        const message = newALReceiptControlMessage({ ...controlId, senderId: 'server' }, receipt);
        expect(message.payload.typeId).toBe('al.control.receipt.v1');
        expect(message.targets).toEqual({ mode: 'unicast', toPeerId: 'origin' });
        expect(message.route).toMatchObject({ topicId: 'al-control', resourceId: 'msg-1', contextId: 'origin' });
        expect(message.qos).toEqual({
            delivery: { algo: 'best-effort' },
            durability: { algo: 'volatile' },
            ack: { algo: 'none', opts: { timeoutMs: 250 } }
        });
        expect(decodeALControlMessage(message).right).toEqual({ type: 'receipt', payload: receipt });
    });

    it.each([
        ['missing field', JSON.stringify({ ...receipt, snapshotVersion: undefined })],
        ['extra field', JSON.stringify({ ...receipt, extra: true })],
        ['unknown phase', JSON.stringify({ ...receipt, phase: 'pending' })],
        ['non-identifier recipient', JSON.stringify({ ...receipt, confirmedRecipientPeerIds: [''] })]
    ])('rejects a receipt with %s', (_label, resource) => {
        expect(() => parseALControlMessage(controlMessageWithResource(AL_CONTROL_RECEIPT_TYPE_ID, resource)))
            .toThrow(TypeError);
    });

    it('refuses a receipt whose unicast target is not its origin', () => {
        const valid = newALReceiptControlMessage(controlId, receipt);
        expect(decodeALControlMessage({ ...valid, targets: { mode: 'unicast', toPeerId: 'other' } }).left)
            .toMatchObject({ code: 'malformed' });
    });

    it('round-trips bounded payloads through the shared decoder', () => {
        expect(parseALControlMessage(newALAckControlMessage(controlId, ack)))
            .toEqual({ type: 'ack', payload: ack });
        expect(parseALControlMessage(newALNackControlMessage(controlId, nack)))
            .toEqual({ type: 'nack', payload: nack });
        expect(parseALControlMessage(newALRepairControlMessage(controlId, repair)))
            .toEqual({ type: 'repair', payload: repair });
    });

    it.each([
        newALAckControlMessage(controlId, ack),
        newALNackControlMessage(controlId, nack),
        newALRepairControlMessage(controlId, repair)
    ])(
        'makes control delivery volatile and non-recursive',
        (msg) => {
            expect(msg.qos).toEqual({
                delivery: { algo: 'best-effort' },
                durability: { algo: 'volatile' },
                ack: { algo: 'none', opts: { timeoutMs: 250 } }
            });
        }
    );

    it.each([128, 129, 600])('keeps a full %i-character referenced message ID behind bounded control routes', (length) => {
        const msgId = 'm'.repeat(length);
        const orderingKey = 'stream:'.repeat(40);
        const controls = [
            newALAckControlMessage(controlId, { ...ack, ackedMsgId: msgId }),
            newALNackControlMessage(controlId, { ...nack, msgId, orderingKey }),
            newALRepairControlMessage(controlId, { ...repair, msgId, orderingKey })
        ];
        for (const control of controls) {
            expect(control.route.resourceId.length).toBeLessThanOrEqual(AL_MESSAGE_RESOURCE_LIMITS.routeIdCharacters);
            const decoded = decodeALControlMessage(control);
            expect(decoded.left).toBeUndefined();
            expect(decoded.right?.payload).toMatchObject(decoded.right?.type === 'ack' ? { ackedMsgId: msgId } : { msgId, orderingKey });
        }
    });

    it('returns advisory size rejection while strict NACK construction still throws', () => {
        for (const msgId of ['m'.repeat(65536), '"'.repeat(32700)]) {
            const payload = { ...nack, msgId };
            expect(prepareALNackControlMessage(controlId, payload).left?.code).toBe('oversized');
            expect(() => newALNackControlMessage(controlId, payload)).toThrow(TypeError);
        }
        expect(prepareALNackControlMessage(controlId, nack).right).toEqual(newALNackControlMessage(controlId, nack));
    });

    it('bounds advisory receivers without weakening strict receiver or trusted sender invariants', () => {
        const receiver = 'p'.repeat(129);
        expect(prepareALNackControlMessage(controlId, { ...nack, toPeerId: receiver }).left?.code).toBe('oversized');
        expect(() => newALNackControlMessage(controlId, { ...nack, toPeerId: receiver })).toThrow(TypeError);
        expect(() => prepareALNackControlMessage(controlId, { ...nack, fromPeerId: receiver })).toThrow(TypeError);
        expect(() => prepareALNackControlMessage(controlId, { ...nack, toPeerId: '' })).toThrow(TypeError);
        const boundary = { ...nack, toPeerId: 'p'.repeat(128) };
        expect(prepareALNackControlMessage(controlId, boundary).right).toEqual(newALNackControlMessage(controlId, boundary));
    });

    it('surfaces malformed advisory payload and clock invariants', () => {
        expect(() => prepareALNackControlMessage(controlId, { ...nack, observedAtEpochMs: Number.NaN })).toThrow(TypeError);
        expect(() => prepareALNackControlMessage({ ...controlId, ts: Number.NaN }, nack)).toThrow(TypeError);
        expect(() => prepareALNackControlMessage({ ...controlId, senderId: 'other' }, nack)).toThrow(TypeError);
    });

    it('returns undefined for application messages and unknown control type identifiers', () => {
        expect(parseALControlMessage(controlMessage('application.event.v1', ack))).toBeUndefined();
        expect(parseALControlMessage(controlMessage('al.control.future.v2', ack))).toBeUndefined();
    });

    it('rejects unsupported control identifiers before runtime state is touched', () => {
        expect(decodeALControlMessage(controlMessage('al.control.future.v2', ack)).left)
            .toMatchObject({ code: 'unsupported' });
    });

    it('checks payload and envelope consistency without making runtime authorization decisions', () => {
        const valid = newALAckControlMessage(controlId, ack);
        expect(decodeALControlMessage(valid).right).toEqual({ type: 'ack', payload: ack });
        expect(
            decodeALControlMessage({
                ...valid,
                payload: { ...valid.payload, resource: JSON.stringify({ ...ack, fromPeerId: 'other' }) }
            }).left
        ).toMatchObject({ code: 'malformed' });
        expect(
            decodeALControlMessage({
                ...valid,
                targets: { mode: 'unicast', toPeerId: 'other' }
            }).left
        ).toMatchObject({ code: 'malformed' });
        expect(
            decodeALControlMessage({
                ...valid,
                route: { ...valid.route, resourceId: 'other' }
            }).left
        ).toMatchObject({ code: 'malformed' });
    });

    it('rejects control messages that request acknowledgements or durable retries', () => {
        const valid = newALAckControlMessage(controlId, ack);
        expect(
            decodeALControlMessage({
                ...valid,
                delivery: { reliability: 'best-effort', ack: 'receiver' }
            }).left
        ).toMatchObject({ code: 'malformed' });
        expect(
            decodeALControlMessage({
                ...valid,
                qos: {
                    ...valid.qos,
                    delivery: { algo: 'at-least-once' },
                    durability: { algo: 'local-outbox' },
                    retry: { algo: 'exp-backoff', opts: { maxAttempts: 3 } }
                }
            }).left
        ).toMatchObject({ code: 'malformed' });
    });

    it.each([
        ['malformed JSON', '{'],
        ['missing field', JSON.stringify({ ...ack, status: undefined })],
        ['extra field', JSON.stringify({ ...ack, extra: true })],
        ['unknown status', JSON.stringify({ ...ack, status: 'unknown' })],
        ['unsafe timestamp', JSON.stringify({ ...ack, observedAtEpochMs: Number.MAX_SAFE_INTEGER + 1 })]
    ])('rejects a known control type with %s', (_label, resource) => {
        expect(() => parseALControlMessage(controlMessageWithResource(AL_CONTROL_ACK_TYPE_ID, resource)))
            .toThrow(TypeError);
    });

    it('bounds peer identities, ordering collections, and serialized payload bytes', () => {
        expect(() =>
            parseALControlMessage(controlMessage(AL_CONTROL_ACK_TYPE_ID, {
                ...ack,
                fromPeerId: 'p'.repeat(AL_MESSAGE_RESOURCE_LIMITS.routeIdCharacters + 1)
            }))
        ).toThrow(TypeError);

        expect(() =>
            parseALControlMessage(controlMessage(AL_CONTROL_NACK_TYPE_ID, {
                ...nack,
                missingSeqs: Array.from({ length: AL_MESSAGE_RESOURCE_LIMITS.repairWindow + 1 }, (_, index) => index)
            }))
        ).toThrow(TypeError);

        expect(() =>
            parseALControlMessage(controlMessageWithResource(
                AL_CONTROL_REPAIR_TYPE_ID,
                ' '.repeat(AL_MESSAGE_RESOURCE_LIMITS.payloadBytes + 1)
            ))
        ).toThrow(TypeError);
    });
});

function controlMessage(typeId: string, payload: ALControlPayload): ALMessage {
    return controlMessageWithResource(typeId, JSON.stringify(payload));
}

function controlMessageWithResource(typeId: string, resource: string): ALMessage {
    return {
        ...newALUnicastMessage(
            'sender',
            { topicId: 'al-control', resourceId: 'msg-1', contextId: 'sender:receiver' },
            'receiver',
            typeId,
            null
        ),
        payload: { typeId, contentType: 'application/json', resource }
    };
}
