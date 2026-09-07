import { describe, expect, it } from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_CONTROL_ACK_TYPE_ID,
    AL_CONTROL_NACK_TYPE_ID,
    AL_CONTROL_REPAIR_TYPE_ID,
    decodeALControlMessage,
    newALAckControlMessage,
    newALNackControlMessage,
    newALRepairControlMessage,
    parseALControlMessage,
    type ALAckPayload,
    type ALControlPayload,
    type ALNackPayload,
    type ALRepairPayload
} from '@shared/al-contracts/al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';

const ack: ALAckPayload = {
    ackedMsgId: 'msg-1',
    fromPeerId: 'sender',
    toPeerId: 'receiver',
    status: 'delivered',
    observedAtEpochMs: 12
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
const controlId: ALMessage['id'] = {
    v: 2,
    msgId: 'control-1',
    ts: 11,
    senderId: 'sender'
};

describe('AL control message codec', () => {
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
