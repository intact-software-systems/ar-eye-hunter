import { describe, expect, it } from 'vitest';

import type { ALAckPayload, ALNackPayload, ALPendingAckSnapshot } from '@shared/al-contracts/al-control.ts';
import {
    hasALOutsideStatement,
    isALSameReceiptStatement
} from '@shared/alm/inbound/control/is-al-same-receipt-statement.ts';
import type { SignatureProof } from '@shared/signature/signature-proof.ts';

import { toTestALAckPayload, toTestALNackPayload, toTestSignatureProof } from '../../../../al-control-test-payloads.ts';

/** A relay waiting on its child `child` for the frozen recipients `child` and `x`. */
const ROW: ALPendingAckSnapshot = {
    toPeerId: 'parent',
    status: 'subtree-complete',
    localReady: true,
    expectedFromPeerIds: ['child'],
    ackedFromPeerIds: [],
    upwardAudiencePeerIds: ['child', 'x'],
    outsideAudiencePeerIds: [],
    carrier: 'rtc'
};

function toAck(fromPeerId: string, logicalRecipientPeerId: string, proof: SignatureProof | null): ALAckPayload {
    return toTestALAckPayload({ ackedMsgId: 'subject', fromPeerId, toPeerId: 'relay', originPeerId: 'origin', logicalRecipientPeerId, proof });
}

function toNack(fromPeerId: string, logicalRecipientPeerId: string, proof: SignatureProof | null): ALNackPayload {
    return toTestALNackPayload({
        msgId: 'subject',
        fromPeerId,
        toPeerId: 'relay',
        originPeerId: 'origin',
        logicalRecipientPeerId,
        reason: 'not-subscribed',
        proof
    });
}

describe('isALSameReceiptStatement', () => {
    it('is one statement for two ACKs about one recipient under one proof, and an ACK and a NACK only when both are unsigned', () => {
        const proof = toTestSignatureProof(1);

        expect(isALSameReceiptStatement(toAck('child', 'x', proof), toAck('child', 'x', proof))).toBe(true);
        expect(isALSameReceiptStatement(toNack('child', 'x', proof), toNack('other-child', 'x', proof))).toBe(true);
        expect(isALSameReceiptStatement(toNack('child', 'x', proof), toAck('child', 'x', proof))).toBe(false);
        expect(isALSameReceiptStatement(toNack('child', 'x', null), toAck('child', 'x', null))).toBe(true);
    });

    it('is two statements for one proof over different signed content', () => {
        const proof = toTestSignatureProof(1);
        const ack = toAck('child', 'x', proof);
        const nack = toNack('child', 'x', proof);

        expect(isALSameReceiptStatement(ack, { ...ack, status: 'accepted' })).toBe(false);
        expect(isALSameReceiptStatement(ack, { ...ack, observedAtEpochMs: 2 })).toBe(false);
        expect(isALSameReceiptStatement(nack, { ...nack, observedAtEpochMs: 2 })).toBe(false);
    });

    it('is two statements for an ACK and a NACK under one proof', () => {
        const proof = toTestSignatureProof(1);

        expect(isALSameReceiptStatement(toAck('child', 'x', proof), toNack('other-child', 'x', proof))).toBe(false);
        expect(isALSameReceiptStatement(toNack('other-child', 'x', proof), toAck('child', 'x', proof))).toBe(false);
    });

    it('is one statement for one proof when only the hop fields differ', () => {
        const proof = toTestSignatureProof(1);
        const ack = toAck('child', 'x', proof);
        const nack = toNack('child', 'x', proof);

        expect(isALSameReceiptStatement(ack, { ...ack, fromPeerId: 'other-child', toPeerId: 'upstream', carrier: 'ws' })).toBe(true);
        expect(isALSameReceiptStatement(nack, { ...nack, fromPeerId: 'other-child', toPeerId: 'upstream' })).toBe(true);
    });

    it('is one statement for a recipient\'s own words on its own channel, whatever their proofs', () => {
        expect(isALSameReceiptStatement(toAck('x', 'x', toTestSignatureProof(1)), toAck('x', 'x', toTestSignatureProof(2))))
            .toBe(true);
        expect(isALSameReceiptStatement(toNack('x', 'x', toTestSignatureProof(1)), toAck('x', 'x', null))).toBe(true);
    });

    it('is two statements for a forwarded word under another proof, or for another recipient', () => {
        const proof = toTestSignatureProof(1);

        expect(isALSameReceiptStatement(toAck('child', 'x', proof), toAck('child', 'x', toTestSignatureProof(2)))).toBe(false);
        expect(isALSameReceiptStatement(toAck('child', 'x', proof), toAck('x', 'x', toTestSignatureProof(2)))).toBe(false);
        expect(isALSameReceiptStatement(toAck('child', 'x', proof), toAck('child', 'y', proof))).toBe(false);
    });

    it('is one statement for two unsigned controls about one recipient', () => {
        expect(isALSameReceiptStatement(toAck('child', 'x', null), toNack('x', 'x', null))).toBe(true);
    });

    it('is one statement for two unsigned controls whatever their content', () => {
        const ack = toAck('child', 'x', null);

        expect(isALSameReceiptStatement(ack, { ...ack, status: 'accepted', observedAtEpochMs: 2 })).toBe(true);
        expect(isALSameReceiptStatement(ack, toNack('other-child', 'x', null))).toBe(true);
    });
});

describe('hasALOutsideStatement', () => {
    it('hasALOutsideStatement answers from the recipient alone once the history holds nothing that recorded it outside', () => {
        const confirmation = toAck('child', 'x', toTestSignatureProof(1));

        expect(hasALOutsideStatement({ ...ROW, outsideAudiencePeerIds: ['x'] }, { acks: [], nacks: [] }, confirmation)).toBe(true);
        expect(hasALOutsideStatement({ ...ROW, outsideAudiencePeerIds: [] }, { acks: [], nacks: [] }, confirmation)).toBe(false);
    });

    it('hasALOutsideStatement answers for the same statement only while the history holds what recorded the recipient outside', () => {
        const row = { ...ROW, outsideAudiencePeerIds: ['x'] };
        const history = { acks: [], nacks: [toNack('child', 'x', toTestSignatureProof(1))] };

        expect(hasALOutsideStatement(row, history, toNack('other-child', 'x', toTestSignatureProof(1)))).toBe(true);
        expect(hasALOutsideStatement(row, history, toAck('child', 'x', toTestSignatureProof(1)))).toBe(false);
        expect(hasALOutsideStatement(row, history, toAck('child', 'x', toTestSignatureProof(2)))).toBe(false);
    });
});
