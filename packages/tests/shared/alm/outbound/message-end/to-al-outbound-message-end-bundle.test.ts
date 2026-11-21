import { describe, expect, it } from 'vitest';

import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import type { ALStoredOutboundMessage } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type { ALOutboundFirstHopWaitSnapshot } from '@shared/alm/outbound/first-hop/compute-al-outbound-first-hop-wait.ts';
import { toALOutboundMessageEndBundle } from '@shared/alm/outbound/message-end/to-al-outbound-message-end-bundle.ts';
import {
    toALOutboundAckTimeoutEffectId,
    toALOutboundFirstHopTimeoutEffectId
} from '@shared/alm/outbound/to-al-outbound-effect-id.ts';

const STORED: ALStoredOutboundMessage = {
    msgId: 'ending',
    reference: {
        key: { topicId: 'AL_OUTBOUND_MESSAGE', resourceId: 'scope', contextId: 'ending' },
        typeId: 'AL_OUTBOUND_MESSAGE',
        scope: 'scope',
        msgId: 'ending',
        senderId: 'sender',
        identity: 'ending',
        expiresAtMs: 60_000
    },
    supersedenceKey: undefined,
    unicastPeerId: null,
    orderingTrackKey: null,
    orderingSeq: null,
    sentPositions: null,
    policy: {
        persist: true,
        ackTracking: null,
        retryTracking: null,
        repairTracking: null,
        supersedenceTracking: null
    },
    creationExpiry: 'creation-expiry',
    ended: false
};

const OPEN_RECEIPT: ALOutboundPendingAckSnapshot = {
    msgId: 'ending',
    mode: 'receiver',
    expectedPeerIds: ['peer-1'],
    ackedPeerIds: [],
    outsideAudiencePeerIds: [],
    timeoutMs: 2_000,
    maxAttempts: 3,
    attempts: 1,
    deadlineAtMs: 4_000
};

const FIRST_HOP_WAIT: ALOutboundFirstHopWaitSnapshot = {
    msgId: 'ending',
    timeoutMs: 2_000,
    maxAttempts: 3,
    attempts: 0,
    deadlineAtMs: 2_000,
    attemptIdentity: 'first',
    phase: 'immediate'
};

describe('the bundle that ends a message', () => {
    it('keeps the open receipt row, ends the repair count, the wait and both timers, and marks the row, under the given fence', () => {
        const bundle = toALOutboundMessageEndBundle({
            senderId: 'sender',
            msgId: 'ending',
            stored: STORED,
            expectedVersion: 7,
            openReceipt: OPEN_RECEIPT,
            firstHopWait: FIRST_HOP_WAIT
        });

        expect(bundle.senderId).toBe('sender');
        expect(bundle.expectedVersion).toBe(7);
        expect(bundle.mutations).toEqual([
            { kind: 'delete-repair-attempt', msgId: 'ending' },
            { kind: 'end-sent-message', stored: STORED },
            { kind: 'delete-first-hop-wait', msgId: 'ending' }
        ]);
        expect(bundle.endedTimeoutEffectIds).toEqual([
            toALOutboundAckTimeoutEffectId(OPEN_RECEIPT),
            toALOutboundFirstHopTimeoutEffectId(FIRST_HOP_WAIT)
        ]);
        expect(bundle.durableEffects).toEqual([]);
    });

    it('with neither an open receipt nor a wait, ends the repair count and marks the row, and ends no timer', () => {
        const bundle = toALOutboundMessageEndBundle({
            senderId: 'sender',
            msgId: 'ending',
            stored: STORED,
            expectedVersion: undefined,
            openReceipt: undefined,
            firstHopWait: undefined
        });

        expect(bundle.mutations.map((mutation) => mutation.kind)).toEqual([
            'delete-repair-attempt',
            'end-sent-message'
        ]);
        expect(bundle.endedTimeoutEffectIds).toEqual([]);
    });

    it('for a message the sender holds no row of, keeps the receipt row, ends the repair count, the wait and both timers and marks nothing', () => {
        const bundle = toALOutboundMessageEndBundle({
            senderId: 'sender',
            msgId: 'ending',
            stored: undefined,
            expectedVersion: 7,
            openReceipt: OPEN_RECEIPT,
            firstHopWait: FIRST_HOP_WAIT
        });

        expect(bundle.mutations).toEqual([
            { kind: 'delete-repair-attempt', msgId: 'ending' },
            { kind: 'delete-first-hop-wait', msgId: 'ending' }
        ]);
        expect(bundle.endedTimeoutEffectIds).toEqual([
            toALOutboundAckTimeoutEffectId(OPEN_RECEIPT),
            toALOutboundFirstHopTimeoutEffectId(FIRST_HOP_WAIT)
        ]);
    });
});
