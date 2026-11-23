import { describe, expect, it } from 'vitest';

import type { ALNackPayload } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import type { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import {
    isWsQueueBoxServerOwnOutsideAudienceNack,
    toWsQueueBoxServerOutsideAudienceConfirmation,
    toWsQueueBoxServerUnrecordedOutsideConfirmations
} from '@shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-outside-audience-confirmation.ts';

const SERVER = 'server';
const NOW = 1_800_000_000_000;
const OPENING = {
    originPeerId: SERVER,
    msgId: 'delta-1',
    traceId: 'trace-outside-audience',
    expectedRecipientPeerIds: ['a', 'b', 'c'],
    neverSentRecipientPeerIds: [],
    snapshotVersion: 0,
    deadlineAtMs: NOW + 7_000
};
const PENDING: ALOutboundPendingAckSnapshot = {
    msgId: 'delta-1',
    mode: 'receiver',
    expectedPeerIds: ['a', 'b', 'c'],
    ackedPeerIds: [],
    outsideAudiencePeerIds: [],
    timeoutMs: 2_000,
    maxAttempts: 3,
    attempts: 0,
    deadlineAtMs: NOW + 2_000
};

function nack(overrides: Partial<ALNackPayload>): ALNackPayload {
    return {
        msgId: 'delta-1',
        fromPeerId: 'b',
        toPeerId: SERVER,
        logicalRecipientPeerId: 'b',
        originPeerId: SERVER,
        reason: 'before-entry',
        observedAtEpochMs: NOW,
        proof: null,
        ...overrides
    };
}

describe('an outside-audience NACK of a server publication', () => {
    it('is a NACK about the server\'s own publication, addressed to it, for an outside-audience reason', () => {
        // Pins another origin's NACK, or one that asks a repair, being written as an outside recipient of the server's.
        expect([
            isWsQueueBoxServerOwnOutsideAudienceNack(nack({}), SERVER),
            isWsQueueBoxServerOwnOutsideAudienceNack(nack({ reason: 'not-subscribed' }), SERVER),
            isWsQueueBoxServerOwnOutsideAudienceNack(nack({ originPeerId: 'origin' }), SERVER),
            isWsQueueBoxServerOwnOutsideAudienceNack(nack({ toPeerId: 'relay' }), SERVER),
            isWsQueueBoxServerOwnOutsideAudienceNack(nack({ reason: 'resync-required' }), SERVER)
        ]).toEqual([true, true, false, false, false]);
    });

    it('is counted at the window for each expected recipient the row places outside and the tally does not name', () => {
        // Pins a NACK the row admitted whose record write was lost never being counted, so the receipt waited for its
        // deadline; and a recipient the tally already names, or the head never expected, being written again.
        const view: ALReceiptRecord.View = {
            head: { phase: 'open', opening: OPENING },
            tally: { confirmedRecipientPeerIds: ['a'], outsideAudienceRecipientPeerIds: ['c'], complete: false }
        };

        expect([
            toWsQueueBoxServerUnrecordedOutsideConfirmations(view, { ...PENDING, outsideAudiencePeerIds: ['a', 'b', 'c', 'x'] }),
            toWsQueueBoxServerUnrecordedOutsideConfirmations(view, PENDING),
            toWsQueueBoxServerUnrecordedOutsideConfirmations(view, undefined)
        ]).toEqual([[{ originPeerId: SERVER, msgId: 'delta-1', recipientPeerId: 'b', kind: 'outside' }], [], []]);
    });

    it('is the record\'s outside confirmation of the recipient it names', () => {
        // Pins the NACK's sender, not its logical recipient, being recorded outside.
        expect(toWsQueueBoxServerOutsideAudienceConfirmation(nack({ fromPeerId: 'relay' }))).toEqual({
            originPeerId: SERVER,
            msgId: 'delta-1',
            recipientPeerId: 'b',
            kind: 'outside'
        });
    });
});
