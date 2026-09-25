import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, newALNackControlMessage, newALReceiptControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toALInboundReceiver, validateALInboundMessage } from '@shared/alm/inbound/validate-al-inbound-message.ts';

const SERVER = toALInboundReceiver('server', (peerId) => peerId === 'origin');

describe('inbound control addressing', () => {
    it('admits a receiver ACK addressed to an origin the WS server relays for', () => {
        const validated = validateALInboundMessage(receiverAck('origin'), fromClient('recipient'), SERVER);

        expect(validated.left).toBeUndefined();
    });

    it('refuses a receiver ACK for an origin the server does not relay for', () => {
        const validated = validateALInboundMessage(receiverAck('stranger'), fromClient('recipient'), SERVER);

        expect(validated.left).toEqual({ code: 'unauthorized', message: 'Control is addressed to another local receiver' });
    });

    it('keeps next-hop addressing for every other control and carrier', () => {
        const nack = newALNackControlMessage(
            { v: 2, msgId: 'nack-1', senderId: 'recipient', ts: 1 },
            { msgId: 'message-1', fromPeerId: 'recipient', toPeerId: 'origin', reason: 'gap', observedAtEpochMs: 1 }
        );
        const overRtc = validateALInboundMessage(receiverAck('origin'), { kind: 'rtc-peer', peerId: 'recipient' }, SERVER);

        expect(validateALInboundMessage(nack, fromClient('recipient'), SERVER).left?.code).toBe('unauthorized');
        expect(overRtc.left?.code).toBe('unauthorized');
        expect(validateALInboundMessage(receiverAck('origin'), fromClient('recipient'), toALInboundReceiver('server', undefined)).left?.code)
            .toBe('unauthorized');
    });

    it.each(
        [
            { kind: 'ws-client', peerId: 'server' },
            { kind: 'rtc-peer', peerId: 'server' }
        ] as const
    )('refuses a receipt from a $kind source as a typed rejection', (source) => {
        const validated = validateALInboundMessage(receipt(), source, toALInboundReceiver('origin', undefined));

        expect(validated.left).toEqual({ code: 'unauthorized', message: 'AL receipt control comes only from the trusted server' });
    });

    it('accepts a receipt addressed to this origin from the trusted server', () => {
        const validated = validateALInboundMessage(receipt(), { kind: 'trusted-server' }, toALInboundReceiver('origin', undefined));

        expect(validated.left).toBeUndefined();
    });
});

function fromClient(peerId: string): ALInboundMessageRuntime.Source {
    return { kind: 'ws-client', peerId };
}

function receiverAck(originPeerId: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: 'ack-1', senderId: 'recipient', ts: 1 },
        {
            ackedMsgId: 'message-1',
            fromPeerId: 'recipient',
            toPeerId: originPeerId,
            originPeerId,
            logicalRecipientPeerId: 'recipient',
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: 1
        }
    );
}

function receipt(): ALMessage {
    return newALReceiptControlMessage(
        { v: 2, msgId: 'receipt-1', senderId: 'server', ts: 1 },
        {
            msgId: 'message-1',
            originPeerId: 'origin',
            expectedRecipientPeerIds: ['recipient'],
            confirmedRecipientPeerIds: [],
            snapshotVersion: 3,
            phase: 'admitted',
            observedAtEpochMs: 1
        }
    );
}
