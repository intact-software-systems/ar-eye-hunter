import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALAckPayload } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import {
    resolveWsQueueBoxServerHeadAbsentAck,
    type WsQueueBoxServerHeadAbsentAck
} from '@shared/services/ws-queue-box-server/receipt/resolve-ws-queue-box-server-head-absent-ack.ts';
import type { WsQueueBoxServerOwnPendingReceipt } from '@shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-own-receipt-opening.ts';

import { toTestALAckPayload } from '../../al-control-test-payloads.ts';

const SERVER = 'server';
const MSG = 'delta-1';
const NOW = 1_800_000_000_000;
const PENDING: ALOutboundPendingAckSnapshot = {
    msgId: MSG,
    mode: 'receiver',
    expectedPeerIds: ['a', 'b'],
    ackedPeerIds: [],
    outsideAudiencePeerIds: [],
    timeoutMs: 2_000,
    maxAttempts: 3,
    attempts: 0,
    deadlineAtMs: NOW + 2_000
};
const OWN: WsQueueBoxServerOwnPendingReceipt = {
    message: {
        id: { v: 4, msgId: MSG, ts: NOW, senderId: SERVER, traceId: 'trace-head-absent' },
        route: { topicId: 'group-state.delta', resourceId: 'resource', contextId: 'room-1' },
        targets: { mode: 'broadcast', scope: 'room', groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' } },
        constraints: undefined,
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'delta.v1', contentType: 'application/json', resource: '{}' }
    } satisfies ALMessage,
    pending: PENDING
};

function ack(overrides: Partial<ALAckPayload>): ALAckPayload {
    return toTestALAckPayload({
        ackedMsgId: MSG,
        fromPeerId: 'a',
        toPeerId: SERVER,
        originPeerId: SERVER,
        logicalRecipientPeerId: 'a',
        carrier: 'ws',
        status: 'delivered',
        observedAtEpochMs: NOW,
        ...overrides
    });
}

function input(overrides: Partial<WsQueueBoxServerHeadAbsentAck>): WsQueueBoxServerHeadAbsentAck {
    return { ack: ack({}), serverPeerId: SERVER, own: OWN, ownOpeningOpens: true, ...overrides };
}

describe('an ACK that finds no head', () => {
    it('is counted ahead for another origin, whose admission the ingress hook proved', () => {
        // Pins a receiver's ACK that overtook its head being lost, or being held to a server row it never named.
        const receiverAck = ack({ toPeerId: 'origin', originPeerId: 'origin' });

        expect(resolveWsQueueBoxServerHeadAbsentAck(input({ ack: receiverAck, own: undefined, ownOpeningOpens: false })))
            .toBe('count-ahead');
    });

    it('is counted ahead when it is the server\'s own not-sent word for another origin, which needs no proof', () => {
        // Pins a send-time skip of a client's send that overtook its head being lost, so the receipt waited on a
        // recipient never sent.
        const notSent = ack({ fromPeerId: SERVER, toPeerId: 'origin', originPeerId: 'origin', status: 'subtree-complete-not-subscribed' });

        expect(resolveWsQueueBoxServerHeadAbsentAck(input({ ack: notSent, own: undefined, ownOpeningOpens: false })))
            .toBe('count-ahead');
    });

    it('is counted ahead when it is the server\'s not-sent word for a recipient its pending row expects', () => {
        // Pins a send-time skip of a server publication that overtook its head being lost, so the receipt waited on
        // a recipient never sent.
        const notSent = ack({ fromPeerId: SERVER, status: 'subtree-complete-not-subscribed' });

        expect(resolveWsQueueBoxServerHeadAbsentAck(input({ ack: notSent }))).toBe('count-ahead');
    });

    it('writes nothing for the server\'s not-sent word of its own publication that its pending row does not prove', () => {
        // Pins a first dequeue's drop, read before the dequeue commit writes the row, being counted ahead as a row
        // no head reads; and the same for a recipient the row does not expect, or a row that would open no head.
        const notSent = (recipient: string) => ack({ fromPeerId: SERVER, logicalRecipientPeerId: recipient, status: 'subtree-complete-not-subscribed' });

        expect([
            resolveWsQueueBoxServerHeadAbsentAck(input({ ack: notSent('a'), own: undefined, ownOpeningOpens: false })),
            resolveWsQueueBoxServerHeadAbsentAck(input({ ack: notSent('c') })),
            resolveWsQueueBoxServerHeadAbsentAck(input({ ack: notSent('a'), ownOpeningOpens: false }))
        ]).toEqual(['rejected', 'rejected', 'rejected']);
    });

    it('is counted ahead for a session the server\'s pending row expects, when that row would open', () => {
        // Pins a session's ACK that overtook its publication's head being lost, so the receipt waited for its deadline.
        expect(resolveWsQueueBoxServerHeadAbsentAck(input({}))).toBe('count-ahead');
    });

    it('is refused for a session the server\'s pending row does not expect', () => {
        // Pins a session confirming a publication it was never sent, leaving a stray confirmation row.
        expect(resolveWsQueueBoxServerHeadAbsentAck(input({ ack: ack({ fromPeerId: 'c', logicalRecipientPeerId: 'c' }) })))
            .toBe('rejected');
    });

    it('goes to the outbound owner when the row would not open, or there is no row', () => {
        // Pins the ACKs of a publication with no head possible, or none recorded, being dropped instead of counted
        // per ACK as before.
        expect([
            resolveWsQueueBoxServerHeadAbsentAck(input({ ownOpeningOpens: false })),
            resolveWsQueueBoxServerHeadAbsentAck(input({ own: undefined, ownOpeningOpens: false }))
        ]).toEqual(['outbound-owner', 'outbound-owner']);
    });
});
