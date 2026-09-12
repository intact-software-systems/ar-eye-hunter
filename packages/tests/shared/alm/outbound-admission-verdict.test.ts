import { createTestALOutboundWorkPort } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import {
    createDefaultOutboundTestStores,
    createOutboundCanonicalEntry,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';

import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { ALOutboundDispatchAdmission } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
import type { ALOutboundEnqueueStatus } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { toALOutboundEnqueueStatus } from '@shared/alm/outbound/to-al-outbound-enqueue-status.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound admission verdict', () => {
    it('admits durably with the queued attempt count for a persisted plan with one prepared attempt', async () => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('verdict-admitted-durable');
        const read = await store.readOutgoingMessage({
            msg: message,
            planner: () => ({
                msg: message,
                dropReasonCode: undefined,
                persist: true,
                preparedMessages: [{ resourceId: 'first-attempt' }]
            }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const computed = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
            dispatchAtMs: Date.now(),
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });

        expect(computed.verdict).toEqual({ kind: 'admitted', durable: true, queuedAttempts: 1 });
        expect(computed.status).toBe('enqueued');
    });

    it('admits volatilely with the queued attempt count for a plan that does not persist', async () => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('verdict-admitted-volatile');
        const read = await store.readOutgoingMessage({
            msg: message,
            planner: () => ({
                msg: message,
                dropReasonCode: undefined,
                persist: false,
                preparedMessages: [{ resourceId: 'first-attempt' }]
            }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const computed = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
            dispatchAtMs: Date.now(),
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });

        expect(computed.verdict).toEqual({ kind: 'admitted', durable: false, queuedAttempts: 1 });
        expect(computed.status).toBe('accepted');
    });

    // A dequeue attempt (unlike enqueue) has no later worker to await: no prepared recipient and no
    // persistence request together mean the message truly has nowhere to go right now.
    it('is unroutable with no-route for a dequeue attempt with no prepared attempts and no persistence', async () => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('verdict-no-route');
        const read = await store.readOutgoingMessage({
            msg: message,
            planner: () => ({ msg: message, dropReasonCode: undefined, persist: false, preparedMessages: [] }),
            observedCanonicalEntry: undefined,
            intent: 'dequeue'
        });
        const computed = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
            dispatchAtMs: Date.now(),
            intent: 'dequeue',
            phase: 'dequeue',
            options: {}
        });

        expect(computed.verdict).toEqual({
            kind: 'unroutable',
            reason: 'no-route',
            detail: `No outbound transport route for message ${message.id.msgId}`
        });
        expect(computed.status).toBe('no-route');
    });

    it('is expired when the message deadline has already elapsed', async () => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('verdict-expired', { ttlMs: 1_000 });
        const read = await store.readOutgoingMessage({
            msg: message,
            planner: () => ({ msg: message, dropReasonCode: undefined, persist: true, preparedMessages: [] }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const computed = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
            dispatchAtMs: Date.now() + 1_000_000,
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });

        expect(computed.verdict).toEqual({ kind: 'expired', detail: 'Message expired or is too stale' });
        expect(computed.status).toBe('expired');
    });

    it('is refused as unauthorized when the planner drops the message with that code', async () => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('verdict-unauthorized');
        const read = await store.readOutgoingMessage({
            msg: message,
            planner: () => ({
                msg: message,
                dropReason: 'Sender is not a room member',
                dropReasonCode: 'unauthorized',
                persist: false,
                preparedMessages: []
            }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const computed = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
            dispatchAtMs: Date.now(),
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });

        // A defect the survey found: today this collapses to the same 'skipped' status as `deferred`.
        expect(computed.verdict).toEqual({
            kind: 'refused',
            reason: 'unauthorized',
            detail: 'Sender is not a room member'
        });
        expect(computed.status).toBe('skipped');
    });

    it('is deferred as not-yet-in-sync when the planner drops the message with that code', async () => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('verdict-not-yet-in-sync');
        const read = await store.readOutgoingMessage({
            msg: message,
            planner: () => ({
                msg: message,
                dropReason: 'Awaiting room snapshot authority',
                dropReasonCode: 'not-yet-in-sync',
                persist: false,
                preparedMessages: []
            }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const computed = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
            dispatchAtMs: Date.now(),
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });

        // A defect the survey found: today this collapses to the same 'skipped' status as `refused`.
        expect(computed.verdict).toEqual({
            kind: 'deferred',
            reason: 'not-yet-in-sync',
            detail: 'Awaiting room snapshot authority'
        });
        expect(computed.status).toBe('skipped');
    });

    it('is duplicate when a persistent message is committed a second time', async () => {
        const stores = createDefaultOutboundTestStores();
        const admission = createTestOutboundDispatchAdmission(stores);
        const message = createOutboundMessage('verdict-duplicate');
        const planner = () => ({
            msg: message,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: [] as readonly OutboundTestPayload[]
        });
        const commitInput = { msg: message, planner, intent: 'enqueue' as const, phase: 'immediate' as const, origin: 'send' as const, options: {} };

        const first = await admission.commit(commitInput);
        expect(first.committed).toBe(true);
        const second = await admission.commit(commitInput);

        expect(second.computed.verdict).toEqual({ kind: 'duplicate' });
        expect(second.computed.status).toBe('duplicate');
        admission.dispose();
    });

    it('is superseded when an older ordered message is committed after a newer one', async () => {
        const stores = createDefaultOutboundTestStores();
        const admission = createTestOutboundDispatchAdmission(stores);
        const supersedenceTracking = { enabled: true, algo: 'latest-wins' as const, key: 'verdict-presence' };
        const newer = { ...createOutboundMessage('verdict-newer'), ordering: { orderingKey: 'presence', epoch: 0, seq: 2 } };
        const older = { ...createOutboundMessage('verdict-older'), ordering: { orderingKey: 'presence', epoch: 0, seq: 1 } };
        const toPlan = (msg: typeof newer) => () => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: [] as readonly OutboundTestPayload[],
            supersedenceTracking
        });

        const first = await admission.commit({
            msg: newer,
            planner: toPlan(newer),
            intent: 'enqueue',
            phase: 'immediate',
            origin: 'send',
            options: {}
        });
        expect(first.committed).toBe(true);
        const second = await admission.commit({
            msg: older,
            planner: toPlan(older),
            intent: 'enqueue',
            phase: 'immediate',
            origin: 'send',
            options: {}
        });

        expect(second.computed.verdict).toEqual({
            kind: 'superseded',
            detail: `Skipping superseded outbound message ${older.id.msgId}`
        });
        expect(second.computed.status).toBe('superseded');
        admission.dispose();
    });

    it.each(
        [
            [{ kind: 'admitted', durable: true, queuedAttempts: 1 }, 'enqueued'],
            [{ kind: 'admitted', durable: false, queuedAttempts: 1 }, 'accepted'],
            [{ kind: 'duplicate' }, 'duplicate'],
            [{ kind: 'pending' }, 'pending-admission'],
            [{ kind: 'deferred', reason: 'not-yet-in-sync', detail: 'd' }, 'skipped'],
            [{ kind: 'refused', reason: 'unauthorized', detail: 'd' }, 'skipped'],
            [{ kind: 'refused', reason: 'malformed', detail: 'd' }, 'failed'],
            [{ kind: 'unroutable', reason: 'no-route', detail: 'd' }, 'no-route'],
            [{ kind: 'unroutable', reason: 'rate-limited', detail: 'd' }, 'rate-limited'],
            [{ kind: 'unroutable', reason: 'circuit-open', detail: 'd' }, 'circuit-open'],
            [{ kind: 'superseded', detail: 'd' }, 'superseded'],
            [{ kind: 'expired', detail: 'd' }, 'expired'],
            [{ kind: 'skipped', reason: 'planner-drop', detail: 'd' }, 'skipped'],
            [{ kind: 'failed', detail: 'd' }, 'failed']
        ] satisfies ReadonlyArray<readonly [ALDeliveryAdmissionVerdict, ALOutboundEnqueueStatus]>
    )(
        'derives status %j -> %s',
        (verdict, status) => {
            expect(toALOutboundEnqueueStatus(verdict)).toBe(status);
        }
    );
});

function createTestOutboundDispatchAdmission(
    stores: ReturnType<typeof createDefaultOutboundTestStores>
): ALOutboundDispatchAdmission<OutboundTestPayload> {
    return new ALOutboundDispatchAdmission<OutboundTestPayload>({
        admissionStore: stores.admissionStore,
        workPort: createTestALOutboundWorkPort({ ...stores, nowMs: Date.now }),
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        decodePreparedMessage: decodeOutboundTestPayload,
        clock: { nowMs: Date.now },
        browserLocks: undefined,
        diagnostics: undefined
    });
}
