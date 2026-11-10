import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    decodeALAckPayload,
    decodeALNackPayload,
    decodeALPendingAckSnapshot
} from '@shared/al-contracts/al-control-value-codec.ts';
import {
    decodeALControlMessage,
    newALAckControlMessage,
    newALNackControlMessage,
    newALReceiptControlMessage,
    type ALNackPayload,
    type ALReceiptPayload
} from '@shared/al-contracts/al-control.ts';

import { toTestALAckPayload, toTestALNackPayload } from '../../al-control-test-payloads.ts';

const controlId: ALMessage['id'] = {
    v: 4,
    msgId: 'control-1',
    ts: 11,
    senderId: 'relay',
    traceId: 'trace-al-control-value-codec'
};

const notSubscribedNack: ALNackPayload = toTestALNackPayload({
    msgId: 'msg-1',
    fromPeerId: 'relay',
    toPeerId: 'origin',
    logicalRecipientPeerId: 'recipient-b',
    reason: 'not-subscribed',
    observedAtEpochMs: 13
});

const receipt: ALReceiptPayload = {
    msgId: 'msg-1',
    originPeerId: 'origin',
    expectedRecipientPeerIds: ['recipient-b', 'recipient-c', 'recipient-d'],
    confirmedRecipientPeerIds: ['recipient-b'],
    outsideAudienceRecipientPeerIds: ['recipient-d'],
    snapshotVersion: 7,
    phase: 'complete',
    observedAtEpochMs: 15
};

/** A control whose payload resource was written by a peer that did not go through the strict builder. */
function withResource(message: ALMessage, resource: object): ALMessage {
    return { ...message, payload: { ...message.payload, resource: JSON.stringify(resource) } };
}

describe('AL control value codec', () => {
    it('the shared test builders build payloads the closed decoders round-trip', () => {
        const ack = toTestALAckPayload({ ackedMsgId: 'm', fromPeerId: 'b', toPeerId: 'a' });
        const nack = toTestALNackPayload({ msgId: 'm', fromPeerId: 'b', toPeerId: 'a', reason: 'not-subscribed' });

        expect(decodeALAckPayload(ack)).toEqual(ack);
        expect(decodeALNackPayload(nack)).toEqual(nack);
    });

    it('round-trips a not-subscribed NACK that speaks for a logical recipient other than its sender', () => {
        const message = newALNackControlMessage(controlId, notSubscribedNack);

        expect(decodeALControlMessage(message).right).toEqual({ type: 'nack', payload: notSubscribedNack });
    });

    it('round-trips a before-entry NACK, which a receiver sends for a copy below its track position', () => {
        const beforeEntryNack: ALNackPayload = { ...notSubscribedNack, logicalRecipientPeerId: 'relay', reason: 'before-entry' };
        const message = newALNackControlMessage(controlId, beforeEntryNack);

        expect(decodeALControlMessage(message).right).toEqual({ type: 'nack', payload: beforeEntryNack });
    });

    it('builds no NACK that names no logical recipient', () => {
        const { logicalRecipientPeerId: _omitted, ...withoutRecipient } = notSubscribedNack;

        expect(() => newALNackControlMessage(controlId, withoutRecipient as ALNackPayload)).toThrow(TypeError);
    });

    it('refuses a NACK with an empty logical recipient as malformed', () => {
        const message = withResource(
            newALNackControlMessage(controlId, notSubscribedNack),
            { ...notSubscribedNack, logicalRecipientPeerId: '' }
        );

        expect(decodeALControlMessage(message).left).toMatchObject({ code: 'malformed' });
    });

    it('round-trips a receipt that lists the recipients outside the audience', () => {
        const message = newALReceiptControlMessage({ ...controlId, senderId: 'server' }, receipt);

        expect(decodeALControlMessage(message).right).toEqual({ type: 'receipt', payload: receipt });
    });

    it('refuses an ACK without its proof slot and a NACK without its origin as malformed', () => {
        const ack = toTestALAckPayload({ ackedMsgId: 'msg-1', fromPeerId: 'relay', toPeerId: 'origin' });
        const { proof: _proof, ...ackWithoutProof } = ack;
        const { originPeerId: _origin, ...nackWithoutOrigin } = notSubscribedNack;

        expect(() => decodeALAckPayload(ackWithoutProof)).toThrow('Control value is missing mandatory fields');
        expect(() => decodeALNackPayload(nackWithoutOrigin)).toThrow('Control value is missing mandatory fields');
        expect(decodeALControlMessage(withResource(newALAckControlMessage(controlId, ack), ackWithoutProof)).left)
            .toEqual({ code: 'malformed', message: 'Control value is missing mandatory fields' });
        expect(
            decodeALControlMessage(
                withResource(newALNackControlMessage(controlId, notSubscribedNack), nackWithoutOrigin)
            ).left
        ).toEqual({ code: 'malformed', message: 'Control value is missing mandatory fields' });
    });

    it('refuses a proof with an unknown field or another algorithm', () => {
        const ack = toTestALAckPayload({ ackedMsgId: 'msg-1', fromPeerId: 'relay', toPeerId: 'origin' });
        const proof = { alg: 'ES256', keyId: 'key-1', signature: 'c2lnbmF0dXJl' };

        expect(() => decodeALAckPayload({ ...ack, proof: { ...proof, extra: true } }))
            .toThrow('Control proof is invalid');
        expect(() => decodeALAckPayload({ ...ack, proof: { ...proof, alg: 'RS256' } }))
            .toThrow('Control proof is invalid');
        expect(() => decodeALNackPayload({ ...notSubscribedNack, proof: { ...proof, keyId: '' } }))
            .toThrow('Control proof is invalid');
        expect(() => decodeALNackPayload({ ...notSubscribedNack, proof: 'signed' }))
            .toThrow('Control proof is invalid');
    });

    it('round-trips a NACK that carries its origin and a proof', () => {
        const signed: ALNackPayload = {
            ...notSubscribedNack,
            originPeerId: 'origin',
            proof: { alg: 'ES256', keyId: 'key-1', signature: 'c2lnbmF0dXJl' }
        };

        expect(decodeALControlMessage(newALNackControlMessage(controlId, signed)).right)
            .toEqual({ type: 'nack', payload: signed });
    });

    it('refuses a receipt whose outside-audience list names an empty recipient as malformed', () => {
        const message = withResource(
            newALReceiptControlMessage(controlId, receipt),
            { ...receipt, outsideAudienceRecipientPeerIds: [''] }
        );

        expect(decodeALControlMessage(message).left).toMatchObject({ code: 'malformed' });
    });

    it('reads a relay row stored before it recorded recipients outside the audience as recording none', () => {
        const row = {
            toPeerId: 'origin',
            status: 'subtree-complete',
            localReady: true,
            expectedFromPeerIds: ['child'],
            ackedFromPeerIds: [],
            carrier: 'rtc'
        };

        expect(decodeALPendingAckSnapshot(row).outsideAudiencePeerIds).toEqual([]);
        expect(decodeALPendingAckSnapshot({ ...row, outsideAudiencePeerIds: ['child'] }).outsideAudiencePeerIds).toEqual(['child']);
        expect(() => decodeALPendingAckSnapshot({ ...row, outsideAudiencePeerIds: [''] })).toThrow(TypeError);
    });
});
