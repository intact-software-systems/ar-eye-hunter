import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ALAckPayload, ALAckStatus, ALPendingAckSnapshot } from '@shared/al-contracts/al-control.ts';
import type { ALReceiptControl } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';
import {
    hasALConfirmedStatement,
    hasALOutsideStatement,
    toALReceiptStatementHistory,
    toALReceiptStatementSubject,
    toFirstOfEachALReceiptStatement
} from '@shared/alm/inbound/control/is-al-same-receipt-statement.ts';
import type { SignatureProof } from '@shared/signature/signature-proof.ts';
import { toClassifiedSigningInput } from '@shared/signature/to-classified-signing-input.ts';

import { toTestALAckPayload, toTestSignatureProof } from '../../../../al-control-test-payloads.ts';

vi.mock('@shared/signature/to-classified-signing-input.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@shared/signature/to-classified-signing-input.ts')>();
    return { ...actual, toClassifiedSigningInput: vi.fn(actual.toClassifiedSigningInput) };
});

const encodeSpy = vi.mocked(toClassifiedSigningInput);

const ROW: ALPendingAckSnapshot = {
    toPeerId: 'parent',
    status: 'subtree-complete',
    localReady: true,
    expectedFromPeerIds: ['child'],
    ackedFromPeerIds: [],
    upwardAudiencePeerIds: ['x'],
    outsideAudiencePeerIds: ['x'],
    carrier: 'rtc'
};

/** A forwarded ACK about `recipient` whose signed content is told apart by `observedAtEpochMs`. */
function toAck(
    recipient: string,
    observedAtEpochMs: number,
    proof: SignatureProof | null,
    status: ALAckStatus = 'delivered'
): ALAckPayload {
    return toTestALAckPayload({
        ackedMsgId: 'subject',
        fromPeerId: 'child',
        toPeerId: 'relay',
        originPeerId: 'origin',
        logicalRecipientPeerId: recipient,
        status,
        observedAtEpochMs,
        proof
    });
}

function toAckControls(count: number, toRecipient: (index: number) => string, toProof: (index: number) => SignatureProof | null) {
    return Array.from({ length: count }, (_unused, index): ALReceiptControl => ({
        type: 'ack',
        payload: toAck(toRecipient(index), index + 1, toProof(index))
    }));
}

describe('a relay encodes each control\'s signed content once per scan', () => {
    beforeEach(() => {
        encodeSpy.mockClear();
    });

    it('groups 64 confirmations about one recipient under one proof with one encode each, keeping all in input order', () => {
        const proof = toTestSignatureProof(1);
        const controls = toAckControls(64, () => 'x', () => proof);

        const firsts = toFirstOfEachALReceiptStatement(controls);

        expect(encodeSpy).toHaveBeenCalledTimes(64);
        expect(firsts).toEqual(controls);
    });

    it('groups the same 64 spread over 8 recipients with one encode each', () => {
        const proof = toTestSignatureProof(1);
        const controls = toAckControls(64, (index) => `r${index % 8}`, () => proof);

        const firsts = toFirstOfEachALReceiptStatement(controls);

        expect(encodeSpy).toHaveBeenCalledTimes(64);
        expect(firsts).toEqual(controls);
    });

    it('encodes a prepared history of 32 same-proof priors and the control at most once across both scans', () => {
        const proof = toTestSignatureProof(1);
        const hopEnds = Array.from({ length: 16 }, (_unused, index) => toAck('x', index + 1, proof, 'subtree-complete-not-subscribed'));
        const confirmations = Array.from({ length: 16 }, (_unused, index) => toAck('x', index + 17, proof));
        const history = toALReceiptStatementHistory([...hopEnds, ...confirmations], []);
        const control = toALReceiptStatementSubject(toAck('x', 100, proof));

        expect(hasALOutsideStatement(ROW, history, control)).toBe(false);
        expect(hasALConfirmedStatement(history.acks, control)).toBe(false);
        expect(encodeSpy.mock.calls.length).toBeLessThanOrEqual(33);
    });

    it('encodes nothing for honest controls: absent proofs, or pairwise different proofs', () => {
        const unsigned = toAckControls(64, () => 'x', () => null);
        const distinctlySigned = toAckControls(64, () => 'x', (index) => toTestSignatureProof(index + 1));

        expect(toFirstOfEachALReceiptStatement(unsigned)).toEqual(unsigned.slice(0, 1));
        expect(toFirstOfEachALReceiptStatement(distinctlySigned)).toEqual(distinctlySigned);
        expect(encodeSpy).not.toHaveBeenCalled();
    });
});
