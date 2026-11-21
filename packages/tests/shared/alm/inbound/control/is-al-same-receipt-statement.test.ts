import { describe, expect, it } from 'vitest';

import type { ALAckPayload, ALNackPayload, ALPendingAckSnapshot } from '@shared/al-contracts/al-control.ts';
import type { ALReceiptControl } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';
import {
    hasALOutsideStatement,
    isALSameReceiptStatement,
    toALReceiptStatementHistory,
    toALReceiptStatementSubject,
    type ALReceiptStatementSubject
} from '@shared/alm/inbound/control/is-al-same-receipt-statement.ts';
import type { SignatureProof } from '@shared/signature/signature-proof.ts';

import { toTestALAckPayload, toTestALNackPayload, toTestSignatureProof } from '../../../../al-control-test-payloads.ts';
import {
    ACK,
    ACK_ALTERATIONS,
    GAP_NACK,
    NACK,
    NACK_ALTERATIONS,
    RELAY_REWRITES,
    withPayload
} from '../../../al-contracts/receipt-proof/al-receipt-proof-fixtures.ts';

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

function isSameStatement(prior: ALAckPayload | ALNackPayload, control: ALAckPayload | ALNackPayload): boolean {
    return isALSameReceiptStatement(toALReceiptStatementSubject(prior), toALReceiptStatementSubject(control));
}

/** The control under one shared non-null proof, so only its signed content tells two statements apart. */
function toSignedSubject(control: ALReceiptControl): ALReceiptStatementSubject {
    return toALReceiptStatementSubject({ ...control.payload, proof: toTestSignatureProof(1) });
}

describe('isALSameReceiptStatement', () => {
    it('is one statement for two ACKs about one recipient under one proof, and an ACK and a NACK only when both are unsigned', () => {
        const proof = toTestSignatureProof(1);

        expect(isSameStatement(toAck('child', 'x', proof), toAck('child', 'x', proof))).toBe(true);
        expect(isSameStatement(toNack('child', 'x', proof), toNack('other-child', 'x', proof))).toBe(true);
        expect(isSameStatement(toNack('child', 'x', proof), toAck('child', 'x', proof))).toBe(false);
        expect(isSameStatement(toNack('child', 'x', null), toAck('child', 'x', null))).toBe(true);
    });

    it('is two statements for one proof over different signed content', () => {
        const proof = toTestSignatureProof(1);
        const ack = toAck('child', 'x', proof);
        const nack = toNack('child', 'x', proof);

        expect(isSameStatement(ack, { ...ack, status: 'accepted' })).toBe(false);
        expect(isSameStatement(ack, { ...ack, observedAtEpochMs: 2 })).toBe(false);
        expect(isSameStatement(nack, { ...nack, observedAtEpochMs: 2 })).toBe(false);
    });

    it('is two statements for an ACK and a NACK under one proof', () => {
        const proof = toTestSignatureProof(1);

        expect(isSameStatement(toAck('child', 'x', proof), toNack('other-child', 'x', proof))).toBe(false);
        expect(isSameStatement(toNack('other-child', 'x', proof), toAck('child', 'x', proof))).toBe(false);
    });

    it('is one statement for one proof when only the hop fields differ', () => {
        const proof = toTestSignatureProof(1);
        const ack = toAck('child', 'x', proof);
        const nack = toNack('child', 'x', proof);

        expect(isSameStatement(ack, { ...ack, fromPeerId: 'other-child', toPeerId: 'upstream', carrier: 'ws' })).toBe(true);
        expect(isSameStatement(nack, { ...nack, fromPeerId: 'other-child', toPeerId: 'upstream' })).toBe(true);
    });

    it('is one statement for a recipient\'s own words on its own channel, whatever their proofs', () => {
        expect(isSameStatement(toAck('x', 'x', toTestSignatureProof(1)), toAck('x', 'x', toTestSignatureProof(2))))
            .toBe(true);
        expect(isSameStatement(toNack('x', 'x', toTestSignatureProof(1)), toAck('x', 'x', null))).toBe(true);
    });

    it('is two statements for a forwarded word under another proof, or for another recipient', () => {
        const proof = toTestSignatureProof(1);

        expect(isSameStatement(toAck('child', 'x', proof), toAck('child', 'x', toTestSignatureProof(2)))).toBe(false);
        expect(isSameStatement(toAck('child', 'x', proof), toAck('x', 'x', toTestSignatureProof(2)))).toBe(false);
        expect(isSameStatement(toAck('child', 'x', proof), toAck('child', 'y', proof))).toBe(false);
    });

    it('is one statement for two unsigned controls about one recipient', () => {
        expect(isSameStatement(toAck('child', 'x', null), toNack('x', 'x', null))).toBe(true);
    });

    it('is one statement for two unsigned controls whatever their content', () => {
        const ack = toAck('child', 'x', null);

        expect(isSameStatement(ack, { ...ack, status: 'accepted', observedAtEpochMs: 2 })).toBe(true);
        expect(isSameStatement(ack, toNack('other-child', 'x', null))).toBe(true);
    });
});

describe('isALSameReceiptStatement over one proof\'s signed content', () => {
    it.each(RELAY_REWRITES)('is the same content for an ACK whose %s a relay rewrote', (_field, change) => {
        expect(isALSameReceiptStatement(toSignedSubject(ACK), toSignedSubject(withPayload(ACK, change)))).toBe(true);
    });

    it.each(['fromPeerId', 'toPeerId'] as const)('is the same content for a NACK whose %s a relay rewrote', (field) => {
        expect(isALSameReceiptStatement(toSignedSubject(NACK), toSignedSubject(withPayload(NACK, { [field]: 'rewritten' })))).toBe(true);
    });

    it.each(ACK_ALTERATIONS)('is other content for an ACK whose %s was altered', (_field, change) => {
        expect(isALSameReceiptStatement(toSignedSubject(ACK), toSignedSubject(withPayload(ACK, change)))).toBe(false);
    });

    it.each(NACK_ALTERATIONS)('is other content for a NACK whose %s was altered', (_field, change) => {
        expect(isALSameReceiptStatement(toSignedSubject(NACK), toSignedSubject(withPayload(NACK, change)))).toBe(false);
    });

    it('is other content for two gap NACKs that differ only in their gap request number', () => {
        expect(isALSameReceiptStatement(toSignedSubject(GAP_NACK), toSignedSubject(withPayload(GAP_NACK, { gapRequestNumber: 2 }))))
            .toBe(false);
    });

    it('is other content for an ACK and a NACK about one recipient', () => {
        expect(isALSameReceiptStatement(toSignedSubject(ACK), toSignedSubject(NACK))).toBe(false);
        expect(isALSameReceiptStatement(toSignedSubject(NACK), toSignedSubject(ACK))).toBe(false);
    });
});

describe('hasALOutsideStatement', () => {
    it('hasALOutsideStatement answers false once the history holds nothing that recorded the recipient outside', () => {
        const confirmation = toALReceiptStatementSubject(toAck('child', 'x', toTestSignatureProof(1)));

        expect(hasALOutsideStatement({ ...ROW, outsideAudiencePeerIds: ['x'] }, toALReceiptStatementHistory([], []), confirmation)).toBe(false);
        expect(hasALOutsideStatement({ ...ROW, outsideAudiencePeerIds: [] }, toALReceiptStatementHistory([], []), confirmation)).toBe(false);
    });

    it('hasALOutsideStatement answers for the same statement only while the history holds what recorded the recipient outside', () => {
        const row = { ...ROW, outsideAudiencePeerIds: ['x'] };
        const history = toALReceiptStatementHistory([], [toNack('child', 'x', toTestSignatureProof(1))]);

        expect(hasALOutsideStatement(row, history, toALReceiptStatementSubject(toNack('other-child', 'x', toTestSignatureProof(1)))))
            .toBe(true);
        expect(hasALOutsideStatement(row, history, toALReceiptStatementSubject(toAck('child', 'x', toTestSignatureProof(1)))))
            .toBe(false);
        expect(hasALOutsideStatement(row, history, toALReceiptStatementSubject(toAck('child', 'x', toTestSignatureProof(2)))))
            .toBe(false);
    });
});
