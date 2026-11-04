import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
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
function withResource(message: ALMessage, resource: Record<string, unknown>): ALMessage {
    return { ...message, payload: { ...message.payload, resource: JSON.stringify(resource) } };
}

describe('AL control value codec', () => {
    it('round-trips a not-subscribed NACK that speaks for a logical recipient other than its sender', () => {
        const message = newALNackControlMessage(controlId, notSubscribedNack);

        expect(decodeALControlMessage(message).right).toEqual({ type: 'nack', payload: notSubscribedNack });
    });

    it('refuses a NACK that names no logical recipient as malformed', () => {
        const { logicalRecipientPeerId: _omitted, ...withoutRecipient } = notSubscribedNack;
        const message = withResource(newALNackControlMessage(controlId, notSubscribedNack), withoutRecipient);

        expect(decodeALControlMessage(message).left).toMatchObject({ code: 'malformed' });
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

    it('refuses a receipt that omits its outside-audience list as malformed', () => {
        const { outsideAudienceRecipientPeerIds: _omitted, ...withoutOutside } = receipt;
        const message = withResource(newALReceiptControlMessage(controlId, receipt), withoutOutside);

        expect(decodeALControlMessage(message).left).toMatchObject({ code: 'malformed' });
    });
});
