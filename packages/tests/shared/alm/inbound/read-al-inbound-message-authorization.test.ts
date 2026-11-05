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
    (ack) => ack.originPeerId === 'origin' ? undefined : { code: 'unauthorized', message: 'AL acknowledgement names no receipt this server aggregates' },
    undefined
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
    )('preserves the %s decision without reading relay authority', async (_name, message, source, rejection) => {
        const relayObservations: string[] = [];
        const receiver = toALInboundReceiver('server', (ack) => {
            relayObservations.push(ack.ackedMsgId);
            return { code: 'unauthorized', message: 'Unrelated relay refusal' };
        }, undefined);

        const authorization = await readALInboundMessageAuthorization(message, source, receiver);

        expect(authorization.left).toEqual(rejection === undefined ? undefined : { code: 'unauthorized', message: rejection });
        expect(authorization.right).toEqual(rejection === undefined ? message : undefined);
        expect(relayObservations).toEqual([]);
    });

    it('supplies the original decoded control identity while preserving payload-only relay callers', async () => {
        const message = createReceiverAcknowledgement('stranger');
        const identities: Array<ALMessage['id'] | undefined> = [];
        const receiver = toALInboundReceiver('server', (_ack, controlIdentity) => {
            identities.push(controlIdentity);
            return { code: 'unauthorized', message: 'closed relay refusal' };
        }, undefined);
        expect((await readALInboundMessageAuthorization(message, toWsClientSource('recipient'), receiver)).left).toEqual({
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

    it('admits a receiver ACK addressed to an origin the WS server relays for', async () => {
        const authorization = await readALInboundMessageAuthorization(createReceiverAcknowledgement('origin'), toWsClientSource('recipient'), SERVER);

        expect(authorization.left).toBeUndefined();
    });

    it('answers a receiver ACK the server cannot count with the relay rejection', async () => {
        const authorization = await readALInboundMessageAuthorization(createReceiverAcknowledgement('stranger'), toWsClientSource('recipient'), SERVER);

        expect(authorization.left).toEqual({ code: 'unauthorized', message: 'AL acknowledgement names no receipt this server aggregates' });
    });

    it.each(['server', 'origin'])('refuses a WS session ACK to %s that speaks for another recipient', async (toPeerId) => {
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
        }, undefined);

        expect((await readALInboundMessageAuthorization(forged, toWsClientSource('recipient'), receiver)).left).toEqual({
            code: 'unauthorized',
            message: 'AL acknowledgement from a WS session speaks for another recipient than its sender'
        });
        expect(relayObservations).toEqual([]);
    });

    // I1: a WS session never relays, so a `not-subscribed` NACK it sends can only remove itself from an audience.
    it.each(['server', 'origin'])('refuses a WS session NACK to %s that speaks for another recipient', async (toPeerId) => {
        const forged = newALNackControlMessage(
            { v: 4, msgId: 'nack-forged', senderId: 'recipient', ts: 1, traceId: 'trace-read-al-inbound-message-authorization' },
            {
                msgId: 'message-1',
                fromPeerId: 'recipient',
                logicalRecipientPeerId: 'another-recipient',
                toPeerId,
                reason: 'not-subscribed',
                observedAtEpochMs: 1
            }
        );

        expect((await readALInboundMessageAuthorization(forged, toWsClientSource('recipient'), SERVER)).left).toEqual({
            code: 'unauthorized',
            message: 'AL NACK from a WS session speaks for another recipient than its sender'
        });
    });

    it('refuses a nonlocal NACK and an ACK without relay authority', async () => {
        const nack = newALNackControlMessage(
            { v: 4, msgId: 'nack-1', senderId: 'recipient', ts: 1, traceId: 'trace-read-al-inbound-message-authorization' },
            { msgId: 'message-1', fromPeerId: 'recipient', logicalRecipientPeerId: 'recipient', toPeerId: 'origin', reason: 'gap', observedAtEpochMs: 1 }
        );

        expect((await readALInboundMessageAuthorization(nack, toWsClientSource('recipient'), SERVER)).left?.code).toBe('unauthorized');
        expect(
            (await readALInboundMessageAuthorization(
                createReceiverAcknowledgement('origin'),
                toWsClientSource('recipient'),
                toALInboundReceiver('server', undefined, undefined)
            ))
                .left?.code
        )
            .toBe('unauthorized');
    });

    describe('a session NACK addressed to the origin of a track the server relays (P2)', () => {
        /** The server relays `origin`'s `message-1` to the audience it admitted: `recipient` alone. */
        const RELAYING_SERVER = toALInboundReceiver('server', undefined, (request, requesterPeerId) =>
            Promise.resolve(
                request.msgId === 'message-1' && request.toPeerId === 'origin' && requesterPeerId === 'recipient'
                    ? undefined
                    : { code: 'unauthorized', message: 'AL repair request names no relayed message admitted to its sender' }
            ));

        it('admits the gap NACK of a session inside the admitted audience', async () => {
            const nack = createGapNack('recipient');

            expect((await readALInboundMessageAuthorization(nack, toWsClientSource('recipient'), RELAYING_SERVER)).right).toBe(nack);
        });

        it('refuses the gap NACK of a session outside the admitted audience', async () => {
            expect((await readALInboundMessageAuthorization(createGapNack('outsider'), toWsClientSource('outsider'), RELAYING_SERVER)).left)
                .toEqual({ code: 'unauthorized', message: 'AL repair request names no relayed message admitted to its sender' });
        });

        it('admits no NACK addressed to another peer from a source that is not a WS session', async () => {
            const asked: string[] = [];
            const receiver = toALInboundReceiver('server', undefined, (request) => {
                asked.push(request.msgId);
                return Promise.resolve(undefined);
            });

            const authorization = await readALInboundMessageAuthorization(createGapNack('recipient'), { kind: 'trusted-server' }, receiver);

            expect(authorization.left).toEqual({ code: 'unauthorized', message: 'Control is addressed to another local receiver' });
            expect(asked).toEqual([]);
        });
    });

    it.each(
        [
            { kind: 'ws-client', peerId: 'server', authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' } },
            { kind: 'rtc-peer', peerId: 'server' }
        ] as const
    )('refuses a receipt from a $kind source as a typed rejection', async (source) => {
        const authorization = await readALInboundMessageAuthorization(createServerReceipt(), source, toALInboundReceiver('origin', undefined, undefined));

        expect(authorization.left).toEqual({ code: 'unauthorized', message: 'AL receipt control comes only from the trusted server' });
    });

    it('accepts a receipt addressed to this origin from the trusted server', async () => {
        const authorization = await readALInboundMessageAuthorization(
            createServerReceipt(),
            { kind: 'trusted-server' },
            toALInboundReceiver('origin', undefined, undefined)
        );

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
    const receiver = toALInboundReceiver('receiver', undefined, undefined);

    it('refuses an RTC peer copy of a room multicast whose origin froze no audience', async () => {
        expect((await readALInboundMessageAuthorization(multicast, { kind: 'rtc-peer', peerId: 'relay' }, receiver)).left).toEqual({
            code: 'malformed',
            message: 'RTC room multicast carries no frozen audience'
        });
    });

    it('admits a frozen RTC copy, and an unfrozen one from a WS session the server freezes at admission', async () => {
        expect((await readALInboundMessageAuthorization(frozen, { kind: 'rtc-peer', peerId: 'relay' }, receiver)).left).toBeUndefined();
        expect((await readALInboundMessageAuthorization(multicast, toWsClientSource('origin'), SERVER)).left).toBeUndefined();
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

function createGapNack(fromPeerId: string): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: `nack-${fromPeerId}`, senderId: fromPeerId, ts: 1, traceId: 'trace-read-al-inbound-message-authorization' },
        {
            msgId: 'message-1',
            fromPeerId,
            logicalRecipientPeerId: fromPeerId,
            toPeerId: 'origin',
            reason: 'gap',
            observedAtEpochMs: 1,
            orderingKey: 'game-1:origin:1',
            expectedSeq: 2,
            missingRanges: [{ from: 2, to: 2 }]
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
            outsideAudienceRecipientPeerIds: [],
            snapshotVersion: 3,
            phase: 'admitted',
            observedAtEpochMs: 1
        }
    );
}
