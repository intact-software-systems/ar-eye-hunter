import type { ALDeliveryFailure } from '@shared/alm/delivery/al-delivery-failure.ts';
import { describe, expect, it } from 'vitest';
import { decodeAlmDeliveryResultValue } from '../../shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts';

const OBSERVATION = {
    handleId: 'handle-1',
    state: 'failed',
    submitted: true,
    enqueued: false,
    confirmedHopPeerIds: [],
    unconfirmedHopPeerIds: ['relay-session'],
    receiptMode: 'hop',
    expectedRecipientPeerIds: ['relay-session'],
    confirmedRecipientPeerIds: [],
    unconfirmedRecipientPeerIds: ['relay-session'],
    attempts: 1,
    attemptOutcomes: ['sent'],
    attemptCarriers: ['rtc'],
    reason: 'Hop relay-session refused the message: stale.'
};

describe('the typed failure a delivery observation carries (D75, C2)', () => {
    it.each(
        [
            { kind: 'refused', reason: 'capacity' },
            { kind: 'refused', reason: 'capacity', limit: 'tracks' },
            { kind: 'refused', reason: 'congested' },
            {
                kind: 'relay-rejected',
                rejection: { relay: 'trusted-server', reason: 'unauthorized' }
            },
            {
                kind: 'relay-rejected',
                rejection: { relay: 'peer', peerId: 'relay-session', reason: 'resync-required' }
            },
            { kind: 'admission-failed' },
            { kind: 'storage-unavailable', cause: 'quota' },
            { kind: 'skipped', reason: 'planner-drop' },
            { kind: 'unroutable', reason: 'no-route' },
            { kind: 'attempt-failed', outcome: 'no-targets' },
            { kind: 'receipt-exhausted', cause: 'budget' },
            {
                kind: 'receipt-exhausted',
                cause: 'hop-refused',
                hopPeerId: 'relay-session',
                nackReason: 'stale'
            },
            { kind: 'expired' }
        ] satisfies readonly ALDeliveryFailure[]
    )('reads a $kind failure as the page stated it', (failure) => {
        expect(decodeAlmDeliveryResultValue({ ...OBSERVATION, failure }).failure).toEqual(failure);
    });

    it('reads an observation without a failure as none', () => {
        expect(decodeAlmDeliveryResultValue(OBSERVATION).failure).toBeUndefined();
    });

    it.each([
        { failure: 'refused', field: 'failure.kind' },
        { failure: { kind: 'lost' }, field: 'failure.kind' },
        { failure: { kind: 'refused', reason: 'busy' }, field: 'failure.reason' },
        { failure: { kind: 'refused', reason: 'capacity', limit: 'rate' }, field: 'failure.limit' },
        { failure: { kind: 'refused', reason: 'unsupported', limit: 'bytes' }, field: 'failure.limit' },
        { failure: { kind: 'refused', reason: 'congested', limit: 'bytes' }, field: 'failure.limit' },
        {
            failure: {
                kind: 'relay-rejected',
                rejection: { relay: 'trusted-server', peerId: 'server-1', reason: 'unauthorized' }
            },
            field: 'failure.rejection'
        },
        { failure: { kind: 'storage-unavailable', cause: 'full' }, field: 'failure.cause' },
        { failure: { kind: 'skipped', reason: 'no-route' }, field: 'failure.reason' },
        { failure: { kind: 'unroutable', reason: 'planner-drop' }, field: 'failure.reason' },
        { failure: { kind: 'attempt-failed', outcome: 'sent' }, field: 'failure.outcome' },
        { failure: { kind: 'receipt-exhausted', cause: 'timeout' }, field: 'failure.cause' },
        {
            failure: { kind: 'receipt-exhausted', cause: 'hop-refused', nackReason: 'stale' },
            field: 'failure.hopPeerId'
        },
        {
            failure: {
                kind: 'receipt-exhausted',
                cause: 'hop-refused',
                hopPeerId: 'relay-session',
                nackReason: 'late'
            },
            field: 'failure.nackReason'
        }
    ])('refuses a failure whose $field is unusable', ({ failure, field }) => {
        expect(() => decodeAlmDeliveryResultValue({ ...OBSERVATION, failure }))
            .toThrowError(`The page runtime returned no usable delivery observation.${field}.`);
    });
});

describe('the durability downgrade a delivery observation carries', () => {
    it('reads the requested durability and the storage cause of a downgraded send', () => {
        const durabilityDowngrade = { requested: 'local-outbox', cause: 'quota' };

        expect(decodeAlmDeliveryResultValue({ ...OBSERVATION, durabilityDowngrade }).durabilityDowngrade)
            .toEqual(durabilityDowngrade);
    });

    it('reads a downgraded local-checkpoint send', () => {
        const durabilityDowngrade = { requested: 'local-checkpoint', cause: 'missing' };

        expect(decodeAlmDeliveryResultValue({ ...OBSERVATION, durabilityDowngrade }).durabilityDowngrade)
            .toEqual(durabilityDowngrade);
    });

    it('reads an observation without a downgrade as none', () => {
        expect(decodeAlmDeliveryResultValue(OBSERVATION).durabilityDowngrade).toBeUndefined();
    });

    it.each([
        { durabilityDowngrade: { requested: 'disk', cause: 'quota' }, field: 'durabilityDowngrade.requested' },
        { durabilityDowngrade: { requested: 'local-outbox', cause: 'full' }, field: 'durabilityDowngrade.cause' }
    ])('refuses a downgrade whose $field is unusable', ({ durabilityDowngrade, field }) => {
        expect(() => decodeAlmDeliveryResultValue({ ...OBSERVATION, durabilityDowngrade }))
            .toThrowError(`The page runtime returned no usable delivery observation.${field}.`);
    });
});
