import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALPendingAckSnapshot } from '@shared/al-contracts/al-control-value-codec.ts';
import {
    decodeALControlMessage,
    newALNackControlMessage,
    newALReceiptControlMessage,
    type ALNackPayload,
    type ALReceiptPayload
} from '@shared/al-contracts/al-control.ts';

const controlId: ALMessage['id'] = {
    v: 4,
    msgId: 'control-1',
    ts: 11,
    senderId: 'relay',
    traceId: 'trace-al-control-value-codec'
};

const notSubscribedNack: ALNackPayload = {
    msgId: 'msg-1',
    fromPeerId: 'relay',
    toPeerId: 'origin',
    logicalRecipientPeerId: 'recipient-b',
    reason: 'not-subscribed',
    observedAtEpochMs: 13
};

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
    it('round-trips a not-subscribed NACK that speaks for a logical recipient other than its sender', () => {
        const message = newALNackControlMessage(controlId, notSubscribedNack);

        expect(decodeALControlMessage(message).right).toEqual({ type: 'nack', payload: notSubscribedNack });
    });

    it('round-trips a before-entry NACK, which a receiver sends for a copy below its track position', () => {
        const beforeEntryNack: ALNackPayload = { ...notSubscribedNack, logicalRecipientPeerId: 'relay', reason: 'before-entry' };
        const message = newALNackControlMessage(controlId, beforeEntryNack);

        expect(decodeALControlMessage(message).right).toEqual({ type: 'nack', payload: beforeEntryNack });
    });

    // An older peer's NACK names no logical recipient: it speaks for its sender.
    it('reads a NACK that names no logical recipient as speaking for its sender', () => {
        const { logicalRecipientPeerId: _omitted, ...withoutRecipient } = notSubscribedNack;
        const message = withResource(newALNackControlMessage(controlId, notSubscribedNack), withoutRecipient);

        expect(decodeALControlMessage(message).right).toEqual({
            type: 'nack',
            payload: { ...notSubscribedNack, logicalRecipientPeerId: 'relay' }
        });
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

    // An older server's receipt lists nobody outside the audience.
    it('reads a receipt that omits its outside-audience list as holding nobody outside', () => {
        const { outsideAudienceRecipientPeerIds: _omitted, ...withoutOutside } = receipt;
        const message = withResource(newALReceiptControlMessage(controlId, receipt), withoutOutside);

        expect(decodeALControlMessage(message).right).toEqual({
            type: 'receipt',
            payload: { ...receipt, outsideAudienceRecipientPeerIds: [] }
        });
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
