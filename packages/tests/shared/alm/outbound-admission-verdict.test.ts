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

import {
    createInitialALDeliveryLifecycle,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALDeliveryLifecycle } from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import { ALOutboundDispatchAdmission } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
import type {
    ALOutboundSettlementEmitter,
    ALOutboundSettlementFact
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
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

        expect(computed.verdict).toEqual({
            kind: 'refused',
            reason: 'unauthorized',
            detail: 'Sender is not a room member'
        });
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

        expect(computed.verdict).toEqual({
            kind: 'deferred',
            reason: 'not-yet-in-sync',
            detail: 'Awaiting room snapshot authority'
        });
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
        admission.dispose();
    });

    it('states a predecessor superseded once across its replacement\'s enqueue and dequeue commits', async () => {
        const stores = createDefaultOutboundTestStores();
        const facts: ALOutboundSettlementFact[] = [];
        const admission = createTestOutboundDispatchAdmission(stores, (fact) => facts.push(fact));
        const old = createOutboundMessage('verdict-replaced');
        const replacement = createOutboundMessage('verdict-replacing');
        const toCommit = (
            msg: typeof old,
            replacesMsgId: string | undefined,
            intent: 'enqueue' | 'dequeue'
        ): ALOutboundDispatchAdmission.Input<OutboundTestPayload> => ({
            msg,
            planner: () => ({
                msg,
                dropReasonCode: undefined,
                persist: true,
                preparedMessages: [],
                supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'verdict-slot', replacesMsgId }
            }),
            intent,
            phase: intent === 'enqueue' ? 'immediate' : 'dequeue',
            origin: intent === 'enqueue' ? 'send' : 'drain',
            options: {}
        });

        expect((await admission.commit(toCommit(old, undefined, 'enqueue'))).committed).toBe(true);
        expect((await admission.commit(toCommit(replacement, old.id.msgId, 'enqueue'))).committed).toBe(true);
        // The dequeue commit rewrites the predecessor's replacement row over a predecessor already superseded.
        expect((await admission.commit(toCommit(replacement, old.id.msgId, 'dequeue'))).committed).toBe(true);

        expect(facts).toEqual([{
            kind: 'superseded',
            msgId: old.id.msgId,
            replacementMsgId: replacement.id.msgId,
            detail: 'A newer message replaced this one at its admission.'
        }]);
        const lifecycle = facts.reduce(
            (previous, fact) => computeALDeliveryLifecycle(previous, { ...fact, carrier: 'ws', atMs: 0 } as ALDeliverySettlement),
            createInitialALDeliveryLifecycle({
                msgId: old.id.msgId,
                typeId: old.payload.typeId,
                ackMode: 'receiver',
                expiresAtMs: undefined,
                submittedAtMs: 0
            })
        );
        expect(lifecycle.state).toBe('superseded');
        expect(lifecycle.lateSettlementCount).toBe(0);
        admission.dispose();
    });
});

function createTestOutboundDispatchAdmission(
    stores: ReturnType<typeof createDefaultOutboundTestStores>,
    settlements: ALOutboundSettlementEmitter = () => {}
): ALOutboundDispatchAdmission<OutboundTestPayload> {
    return new ALOutboundDispatchAdmission<OutboundTestPayload>({
        admissionStore: stores.admissionStore,
        workPort: createTestALOutboundWorkPort({ ...stores, nowMs: Date.now }),
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        decodePreparedMessage: decodeOutboundTestPayload,
        clock: { nowMs: Date.now },
        browserLocks: undefined,
        diagnostics: undefined,
        settlements
    });
}
