import { describe, expect, it } from 'vitest';

import type { ALAckPayload } from '@shared/al-contracts/al-control.ts';
import type { ALReceiptRecordHead } from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import type { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    isWsQueueBoxServerCountableAck,
    isWsQueueBoxServerNotSentAck,
    toWsQueueBoxServerAckConfirmation,
    toWsQueueBoxServerCountedAck
} from '@shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-counted-ack.ts';

import { toTestALAckPayload } from '../../al-control-test-payloads.ts';

const SERVER = 'server';
const NOW = 1_800_000_000_000;
const OPENING = {
    originPeerId: 'origin',
    msgId: 'm-1',
    traceId: 'trace-counted-ack',
    expectedRecipientPeerIds: ['a'],
    neverSentRecipientPeerIds: [],
    snapshotVersion: 3,
    deadlineAtMs: NOW + 7_000
};

function ack(overrides: Partial<ALAckPayload>): ALAckPayload {
    return toTestALAckPayload({
        ackedMsgId: 'm-1',
        fromPeerId: 'a',
        toPeerId: 'origin',
        originPeerId: 'origin',
        logicalRecipientPeerId: 'a',
        carrier: 'ws',
        status: 'delivered',
        observedAtEpochMs: NOW,
        ...overrides
    });
}

function view(phase: 'open' | 'complete', complete: boolean): ALReceiptRecord.View {
    const head: ALReceiptRecordHead = phase === 'open'
        ? { phase, opening: OPENING }
        : { phase, opening: OPENING, confirmedRecipientPeerIds: ['a'], outsideAudienceRecipientPeerIds: [], endedAtEpochMs: NOW };
    return { head, tally: { confirmedRecipientPeerIds: ['a'], outsideAudienceRecipientPeerIds: [], complete } };
}

describe('the count of an ACK', () => {
    it('counts an ACK addressed to its origin that is its recipient\'s own word or the server\'s not-sent', () => {
        // Pins a relayed word, or one addressed past its origin, written as the recipient's own confirmation.
        expect([
            isWsQueueBoxServerCountableAck(ack({}), SERVER),
            isWsQueueBoxServerCountableAck(ack({ fromPeerId: SERVER, status: 'subtree-complete-not-subscribed' }), SERVER),
            isWsQueueBoxServerCountableAck(ack({ fromPeerId: 'relay' }), SERVER),
            isWsQueueBoxServerCountableAck(ack({ toPeerId: SERVER }), SERVER)
        ]).toEqual([true, true, false, false]);
    });

    it('states the server\'s not-sent, a recipient\'s confirmation, or a recipient outside', () => {
        // Pins the server's word that it sent a recipient nothing being counted as that recipient's confirmation, and
        // a hop-end ACK that delivered nothing confirming its recipient.
        const notSent = ack({ fromPeerId: SERVER, status: 'subtree-complete-not-subscribed' });

        expect([
            isWsQueueBoxServerNotSentAck(notSent, SERVER),
            toWsQueueBoxServerAckConfirmation(notSent, SERVER).kind,
            toWsQueueBoxServerAckConfirmation(ack({}), SERVER),
            toWsQueueBoxServerAckConfirmation(ack({ status: 'subtree-complete-not-subscribed' }), SERVER).kind
        ]).toEqual([
            true,
            'not-sent',
            { originPeerId: 'origin', msgId: 'm-1', recipientPeerId: 'a', kind: 'confirmed' },
            'outside'
        ]);
    });

    it('is complete only for a view still open whose tally is complete', () => {
        // Pins a count that read an ended head being acted on as a completion, ending the receipt twice.
        expect([
            toWsQueueBoxServerCountedAck(Either.ofRight({ disposition: 'counted', view: view('open', true) })).outcome,
            toWsQueueBoxServerCountedAck(Either.ofRight({ disposition: 'counted', view: view('open', false) })).outcome,
            toWsQueueBoxServerCountedAck(Either.ofRight({ disposition: 'counted', view: view('complete', true) })).outcome,
            toWsQueueBoxServerCountedAck(Either.ofRight({ disposition: 'ahead' })),
            toWsQueueBoxServerCountedAck(Either.ofLeft({ kind: 'conflict' })),
            toWsQueueBoxServerCountedAck(Either.ofLeft({ kind: 'head-absent' }))
        ]).toEqual([
            'complete',
            'partial',
            'partial',
            { outcome: 'partial', view: undefined },
            { outcome: 'conflict', view: undefined },
            { outcome: 'rejected', view: undefined }
        ]);
    });
});
