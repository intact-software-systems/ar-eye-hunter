import {
    describe,
    expect,
    it
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    newALReceiptControlMessage
} from '@shared/al-contracts/al-control.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { readALInboundMessageAuthorization, toALInboundReceiver } from '@shared/alm/inbound/read-al-inbound-message-authorization.ts';

const SERVER = toALInboundReceiver(
    'server',
    (ack) => ack.originPeerId === 'origin' ? undefined : { code: 'unauthorized', message: 'AL acknowledgement names no receipt this server aggregates' }
);

describe('inbound control addressing', () => {
    it.each(
        [
            ['forged origin', createReceiverAcknowledgement('origin'), toWsClientSource('attacker'), 'AL origin does not match the authenticated peer'],
            ['local ACK', createReceiverAcknowledgement('server'), toWsClientSource('recipient'), undefined],
            [
                'nonlocal RTC ACK',
                createReceiverAcknowledgement('origin'),
                { kind: 'rtc-peer', peerId: 'recipient' },
                'Direct RTC envelope is addressed to another recipient'
            ]
        ] as const
    )('preserves the %s decision without reading relay authority', (_name, message, source, rejection) => {
        const relayObservations: string[] = [];
        const receiver = toALInboundReceiver('server', (ack) => {
            relayObservations.push(ack.ackedMsgId);
            return { code: 'unauthorized', message: 'Unrelated relay refusal' };
        });

        const authorization = readALInboundMessageAuthorization(message, source, receiver);

        expect(authorization.left).toEqual(rejection === undefined ? undefined : { code: 'unauthorized', message: rejection });
        expect(authorization.right).toEqual(rejection === undefined ? message : undefined);
        expect(relayObservations).toEqual([]);
    });

    it('supplies the original decoded control identity while preserving payload-only relay callers', () => {
        const message = createReceiverAcknowledgement('stranger');
        const identities: Array<ALMessage['id'] | undefined> = [];
        const receiver = toALInboundReceiver('server', (_ack, controlIdentity) => {
            identities.push(controlIdentity);
            return { code: 'unauthorized', message: 'closed relay refusal' };
        });
        expect(readALInboundMessageAuthorization(message, toWsClientSource('recipient'), receiver).left).toEqual({
            code: 'unauthorized',
            message: 'closed relay refusal'
        });
        expect(identities).toEqual([{ v: 4, msgId: 'ack-1', senderId: 'recipient', ts: 1, traceId: 'trace-read-al-inbound-message-authorization' }]);
        expect(receiver.readRelayedAckRejection({
            ackedMsgId: 'message-1',
            fromPeerId: 'recipient',
            toPeerId: 'origin',
            originPeerId: 'origin',
            logicalRecipientPeerId: 'recipient',
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: 1
        })).toEqual({ code: 'unauthorized', message: 'closed relay refusal' });
        expect(identities[1]).toBeUndefined();
    });

    it('admits a receiver ACK addressed to an origin the WS server relays for', () => {
        const authorization = readALInboundMessageAuthorization(createReceiverAcknowledgement('origin'), toWsClientSource('recipient'), SERVER);

        expect(authorization.left).toBeUndefined();
    });

    it('answers a receiver ACK the server cannot count with the relay rejection', () => {
        const authorization = readALInboundMessageAuthorization(createReceiverAcknowledgement('stranger'), toWsClientSource('recipient'), SERVER);

        expect(authorization.left).toEqual({ code: 'unauthorized', message: 'AL acknowledgement names no receipt this server aggregates' });
    });

    it.each(['server', 'origin'])('refuses a WS session ACK to %s that speaks for another recipient', (toPeerId) => {
        const forged = newALAckControlMessage(
            { v: 4, msgId: 'ack-forged', senderId: 'recipient', ts: 1, traceId: 'trace-read-al-inbound-message-authorization' },
            {
                ackedMsgId: 'message-1',
                fromPeerId: 'recipient',
                toPeerId,
                originPeerId: toPeerId,
                logicalRecipientPeerId: 'another-recipient',
                carrier: 'ws',
                status: 'delivered',
                observedAtEpochMs: 1
            }
        );

        const relayObservations: string[] = [];
        const receiver = toALInboundReceiver('server', (ack) => {
            relayObservations.push(ack.ackedMsgId);
            return { code: 'unauthorized', message: 'Unrelated relay refusal' };
        });

        expect(readALInboundMessageAuthorization(forged, toWsClientSource('recipient'), receiver).left).toEqual({
            code: 'unauthorized',
            message: 'AL acknowledgement from a WS session speaks for another recipient than its sender'
        });
        expect(relayObservations).toEqual([]);
    });

    it('refuses a nonlocal NACK and an ACK without relay authority', () => {
        const nack = newALNackControlMessage(
            { v: 4, msgId: 'nack-1', senderId: 'recipient', ts: 1, traceId: 'trace-read-al-inbound-message-authorization' },
            { msgId: 'message-1', fromPeerId: 'recipient', toPeerId: 'origin', reason: 'gap', observedAtEpochMs: 1 }
        );

        expect(readALInboundMessageAuthorization(nack, toWsClientSource('recipient'), SERVER).left?.code).toBe('unauthorized');
        expect(
            readALInboundMessageAuthorization(createReceiverAcknowledgement('origin'), toWsClientSource('recipient'), toALInboundReceiver('server', undefined))
                .left?.code
        )
            .toBe('unauthorized');
    });

    it.each(
        [
            { kind: 'ws-client', peerId: 'server', authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' } },
            { kind: 'rtc-peer', peerId: 'server' }
        ] as const
    )('refuses a receipt from a $kind source as a typed rejection', (source) => {
        const authorization = readALInboundMessageAuthorization(createServerReceipt(), source, toALInboundReceiver('origin', undefined));

        expect(authorization.left).toEqual({ code: 'unauthorized', message: 'AL receipt control comes only from the trusted server' });
    });

    it('accepts a receipt addressed to this origin from the trusted server', () => {
        const authorization = readALInboundMessageAuthorization(createServerReceipt(), { kind: 'trusted-server' }, toALInboundReceiver('origin', undefined));

        expect(authorization.left).toBeUndefined();
    });
});

describe('inbound frozen room audience', () => {
    const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
    const multicast: ALMessage = {
        id: { v: 4, msgId: 'room-message', senderId: 'origin', ts: 1, traceId: 'trace-read-al-inbound-message-authorization' },
        route: { topicId: 'chat', resourceId: 'resource', contextId: 'room' },
        targets: { mode: 'multicast', groupRef: room },
        payload: { typeId: 'chat', resource: '{}' }
    };
    const frozen: ALMessage = {
        ...multicast,
        targets: { mode: 'multicast', groupRef: room, recipientPeerIds: ['receiver'], snapshotVersion: 4 }
    };
    const receiver = toALInboundReceiver('receiver', undefined);

    it('refuses an RTC peer copy of a room multicast whose origin froze no audience', () => {
        expect(readALInboundMessageAuthorization(multicast, { kind: 'rtc-peer', peerId: 'relay' }, receiver).left).toEqual({
            code: 'malformed',
            message: 'RTC room multicast carries no frozen audience'
        });
    });

    it('admits a frozen RTC copy, and an unfrozen one from a WS session the server freezes at admission', () => {
        expect(readALInboundMessageAuthorization(frozen, { kind: 'rtc-peer', peerId: 'relay' }, receiver).left).toBeUndefined();
        expect(readALInboundMessageAuthorization(multicast, toWsClientSource('origin'), SERVER).left).toBeUndefined();
    });
});

function toWsClientSource(peerId: string): ALInboundMessageRuntime.Source {
    return { kind: 'ws-client', peerId, authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' } };
}

function createReceiverAcknowledgement(originPeerId: string): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: 'ack-1', senderId: 'recipient', ts: 1, traceId: 'trace-read-al-inbound-message-authorization' },
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

function createServerReceipt(): ALMessage {
    return newALReceiptControlMessage(
        { v: 4, msgId: 'receipt-1', senderId: 'server', ts: 1, traceId: 'trace-read-al-inbound-message-authorization' },
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
