import { describe, expect, it, vi } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundCapturedPolicy, ALStoredOutboundMessage } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type { ALOutboundComputedDto } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import {
    leavesSequencePending,
    toALOutboundFailedTrackIndexEndCause,
    toALOutboundTrackIndexEnd,
    writeALOutboundTrackIndexEnd
} from '@shared/alm/outbound/lane/write-al-outbound-track-index-end.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';

const ADMITTED: ALDeliveryAdmissionVerdict = { kind: 'admitted', durable: true, queuedAttempts: 1 };
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const POLICY: ALOutboundCapturedPolicy = {
    persist: true,
    ackTracking: null,
    retryTracking: null,
    repairTracking: null,
    supersedenceTracking: null,
    admittedAudience: ['b']
};
const { admittedAudience: _admittedAudience, ...AUDIENCE_FREE } = POLICY;

function trackedMessage(seq: number): ALMessage {
    const message = newALBroadcastMessage('a', newALRoute('room.round.event', ROOM.groupId, `event-${seq}`), 'room', 'round.event.v1', {}, { groupRef: ROOM });
    return { ...message, ordering: { orderingKey: 'game-1', epoch: 1, seq } };
}

/** A dequeue's commit with the verdict, writing the row's sent admission with these positions and policy. */
function committed(
    verdict: ALDeliveryAdmissionVerdict,
    sent?: Readonly<{ sentPositions: Readonly<Record<string, number>> | null; policy: ALOutboundCapturedPolicy; }>
): ALOutboundComputedDto<string> {
    const msg = trackedMessage(2);
    const mutations = sent === undefined ? [] : [{
        kind: 'set-sent-message' as const,
        reference: {
            key: { topicId: 'AL_OUTBOUND_MESSAGE', resourceId: 'scope', contextId: msg.id.msgId },
            typeId: 'AL_OUTBOUND_MESSAGE',
            scope: 'scope',
            msgId: msg.id.msgId,
            senderId: 'a',
            identity: msg.id.msgId,
            expiresAtMs: 1
        },
        policy: sent.policy,
        sentPositions: sent.sentPositions,
        creationExpiry: 'creation-expiry',
        snapshot: { msgId: msg.id.msgId, msg, outboxKey: msg.route, supersedenceKey: null }
    }];
    return { msg, verdict, entries: [], trackedReceiptAlgo: 'none', bundle: { senderId: 'a', mutations, durableEffects: [] } };
}

function storedRow(sentPositions: Readonly<Record<string, number>> | null, policy = POLICY): ALStoredOutboundMessage {
    const msg = trackedMessage(2);
    return {
        msgId: msg.id.msgId,
        reference: {
            key: { topicId: 'AL_OUTBOUND_MESSAGE', resourceId: 'scope', contextId: msg.id.msgId },
            typeId: 'AL_OUTBOUND_MESSAGE',
            scope: 'scope',
            msgId: msg.id.msgId,
            senderId: 'a',
            identity: msg.id.msgId,
            expiresAtMs: 1
        },
        supersedenceKey: undefined,
        unicastPeerId: null,
        orderingTrackKey: 'game-1:a:1',
        orderingSeq: 2,
        sentPositions,
        policy,
        creationExpiry: 'creation-expiry'
    };
}

describe('the terminal ends of a dequeued tracked row', () => {
    const msg = trackedMessage(2);
    const end = { trackKey: 'game-1:a:1', seq: 2, msgId: msg.id.msgId };

    it.each([
        ['superseded at its read', 'superseded' as const],
        ['failed for good', 'failed' as const],
        ['admitted', committed(ADMITTED)],
        ['duplicate', committed({ kind: 'duplicate' })],
        ['refused', committed({ kind: 'refused', reason: 'congested', detail: 'busy' })],
        ['superseded at its commit', committed({ kind: 'superseded', detail: 'replaced' })],
        ['expired', committed({ kind: 'expired', detail: 'Message expired or is too stale' })],
        ['unroutable rate-limited', committed({ kind: 'unroutable', reason: 'rate-limited', detail: 'limited' })],
        ['unroutable circuit-open', committed({ kind: 'unroutable', reason: 'circuit-open', detail: 'open' })],
        ['failed', committed({ kind: 'failed', detail: 'broken' })]
    ])('names its sequence when it ends %s', (_name, cause) => {
        expect(toALOutboundTrackIndexEnd(msg, cause)).toEqual(end);
    });

    it.each([
        ['deferred', committed({ kind: 'deferred', reason: 'not-yet-in-sync', detail: 'later' })],
        ['pending', committed({ kind: 'pending' })],
        ['unroutable no-route', committed({ kind: 'unroutable', reason: 'no-route', detail: 'nobody' })],
        ['not completed', undefined]
    ])('names nothing for a row that still retries: %s', (_name, cause) => {
        expect(toALOutboundTrackIndexEnd(msg, cause)).toBeUndefined();
    });

    it('names nothing for an untracked row or a row with no message', () => {
        expect(toALOutboundTrackIndexEnd({ ...msg, ordering: undefined }, 'failed')).toBeUndefined();
        expect(toALOutboundTrackIndexEnd(undefined, 'failed')).toBeUndefined();
    });

    it('ends a failure only when the work handler settles it non-retryable', () => {
        expect(toALOutboundFailedTrackIndexEndCause(new NonRetryableException('gone'))).toBe('failed');
        expect(toALOutboundFailedTrackIndexEndCause(new ALAdmissionCorruptionError('key', new TypeError('bad')))).toBe('failed');
        expect(toALOutboundFailedTrackIndexEndCause(new Error('transient'))).toBeUndefined();
    });
});

describe('whether a terminal end leaves its sequence pending', () => {
    it('leaves it pending for a row with no stored row or no recorded positions', () => {
        expect(leavesSequencePending('failed', undefined)).toBe(true);
        expect(leavesSequencePending(committed({ kind: 'refused', reason: 'congested', detail: 'busy' }), storedRow(null))).toBe(true);
        expect(leavesSequencePending(committed(ADMITTED), storedRow(null))).toBe(true);
    });

    it('keeps the index of a row that recorded, and of a delivered row that was never to record', () => {
        expect(leavesSequencePending('superseded', storedRow({ b: 1 }))).toBe(false);
        expect(leavesSequencePending(committed(ADMITTED), storedRow(null, AUDIENCE_FREE))).toBe(false);
        expect(leavesSequencePending(committed({ kind: 'duplicate' }), storedRow(null, AUDIENCE_FREE))).toBe(false);
    });
});

describe('the index end write', () => {
    const msg = trackedMessage(2);

    it('clears the sequence a row ended without recording, reading the stored row its commit did not write', async () => {
        const store = { readStoredMessage: vi.fn(async () => undefined), commitOrderingMessageEnd: vi.fn(async () => 'deleted' as const) };

        await writeALOutboundTrackIndexEnd(store, msg, committed({ kind: 'failed', detail: 'broken' }));

        expect(store.readStoredMessage).toHaveBeenCalledWith(msg.id.msgId);
        expect(store.commitOrderingMessageEnd).toHaveBeenCalledWith({ trackKey: 'game-1:a:1', seq: 2, msgId: msg.id.msgId });
    });

    it('keeps the sequence of a row its own commit recorded, without a read', async () => {
        const store = { readStoredMessage: vi.fn(async () => undefined), commitOrderingMessageEnd: vi.fn(async () => 'deleted' as const) };

        await writeALOutboundTrackIndexEnd(store, msg, committed(ADMITTED, { sentPositions: { b: 1 }, policy: POLICY }));

        expect(store.readStoredMessage).not.toHaveBeenCalled();
        expect(store.commitOrderingMessageEnd).not.toHaveBeenCalled();
    });

    it('settles a store failure of the end as a logged value, so the row keeps the outcome it had', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const store = {
            readStoredMessage: vi.fn(async () => undefined),
            commitOrderingMessageEnd: vi.fn(async (): Promise<'deleted'> => {
                throw new Error('store down');
            })
        };

        await expect(writeALOutboundTrackIndexEnd(store, msg, 'failed')).resolves.toBeUndefined();
        expect(consoleError).toHaveBeenCalledWith('Outbound track index end failed', expect.objectContaining({ msgId: msg.id.msgId }));
        consoleError.mockRestore();
    });
});
