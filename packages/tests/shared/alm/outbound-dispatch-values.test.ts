import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALOutboundMessageReadDto } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { validateALOutboundDispatch } from '@shared/alm/outbound/validate-al-outbound-dispatch.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createDefaultOutboundTestStores,
    createOutboundCanonicalEntry,
    createOutboundMessage,
    peekOutboundWorkReadyAt,
    readOutboundTestAdmission
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound dispatch value ownership', () => {
    it('creates a canonical row at the millisecond of the explicitly captured instant', () => {
        const stores = createDefaultOutboundTestStores();
        const message = createOutboundMessage('explicit-creation-instant');
        const createdAt = Temporal.Instant.from('2026-01-01T23:59:59.123456789Z');

        const entry = createOutboundCanonicalEntry(stores.admissionStore, message, createdAt);

        expect(entry.audit.createdTs.toString()).toBe('2026-01-01T23:59:59.123');
        expect(entry.audit.date.toString()).toBe('23:59:59.123');
    });

    it.each([
        { dispatchAtMs: 1_999, expired: false },
        { dispatchAtMs: 2_000, expired: true }
    ])('captures separate creation and dispatch clocks after a paused read at $dispatchAtMs', async ({ dispatchAtMs, expired }) => {
        vi.useFakeTimers({ toFake: ['Date'], now: 1_000 });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const stores = createDefaultOutboundTestStores();
        const message = createOutboundMessage('deferred-clock', { ttlMs: 1_000 });
        const captured = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        let createdAt = Temporal.Instant.from('2026-01-01T00:00:00.000000001Z');
        let nowMs = 1_000;
        const read = stores.admissionStore.readOutgoingMessage.bind(stores.admissionStore);
        const observedRead = vi.spyOn(stores.admissionStore, 'readOutgoingMessage').mockImplementation(async (input) => {
            const result = await read(input);
            captured.resolve();
            await resume.promise;
            return result;
        });
        onTestFinished(() => observedRead.mockRestore());
        const pending = readOutboundTestAdmission({
            store: stores.admissionStore,
            message,
            creationNow: () => createdAt,
            clock: { nowMs: () => nowMs }
        });
        onTestFinished(async () => {
            resume.resolve();
            await Promise.allSettled([pending]);
        });
        await captured.promise;
        createdAt = Temporal.Instant.from('2026-01-01T23:59:59.123456789Z');
        nowMs = dispatchAtMs;
        resume.resolve();

        if (expired) {
            await expect(pending).rejects.toThrow('Expected outbound admission, received expired');
        }
        else {
            const bundle = await pending;
            expect(bundle.canonicalEntry?.audit.createdTs.toString()).toBe('2026-01-01T23:59:59.123');
            expect(bundle.canonicalEntry?.audit.expiryTs.epochMilliseconds).toBe(2_000);
        }
        expect(Date.now()).toBe(1_000);
    });

    it('rejects a mismatched queue resource before admitting message ownership or work', async () => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('intended-message');
        const wrongEntry = QueueBoxUtilities.toResourceEntryFromMsg(createOutboundMessage('other-message'), 'outbox', Temporal.Now.instant());
        const admission = new ALOutboundDispatchAdmission<OutboundTestPayload>({
            lane: 'durable',
            admissionStore: store,
            toOutboxEntry: () => wrongEntry,
            decodePreparedMessage: decodeOutboundTestPayload,
            clock: { nowMs: Date.now },
            browserLocks: undefined,
            diagnostics: undefined,
            settlements: () => {}
        });

        const result = await admission.commit({
            msg: message,
            planner: () => ({ msg: message, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
            intent: 'enqueue',
            phase: 'immediate',
            origin: 'send',
            options: {}
        });

        expect(result.computed.verdict.kind).toBe('failed');
        expect(result.computed.reason).toBe('Outbound queue candidate differs from its message');
        expect(result.committed).toBe(false);
        expect(await store.readSentMessage(message.id.msgId)).toBeUndefined();
        expect(await peekOutboundWorkReadyAt(stores.workQueue, store.namespace)).toBeUndefined();
        admission.dispose();
    });

    it('computes from captured values and preserves the candidate through a real successful and conflicting commit', async () => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('immutable-dispatch');
        const read = await store.readOutgoingMessage({
            msg: message,
            planner: () => ({
                msg: message,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [] as readonly OutboundTestPayload[],
                supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-value' }
            }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const outboxEntry = QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox', Temporal.Now.instant());
        const input = freezeValues({
            read,
            outboxEntry,
            dispatchAtMs: 1_000,
            intent: 'enqueue' as const,
            phase: 'immediate' as const,
            options: {}
        });

        const computed = freezeValues(computeALOutboundDispatch(input));
        expect(computed).toEqual(computeALOutboundDispatch(input));
        expect(computed.verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(computed.bundle?.canonicalEntry).toEqual(outboxEntry);
        expect(computed.bundle?.durableEffects).toEqual([]);
        if (!computed.bundle) {
            throw new Error('Durable dispatch must produce a commit candidate');
        }
        const beforeCommit = JSON.stringify(computed);
        const tampered = {
            ...computed,
            bundle: {
                ...computed.bundle,
                mutations: computed.bundle.mutations.map((mutation) =>
                    mutation.kind === 'set-supersedence-latest'
                        ? { ...mutation, expected: { kind: 'latest' as const, latestMsgId: 'unread', latestTs: 0, updatedAtMs: 0 } }
                        : mutation
                )
            }
        };
        expect(validateALOutboundDispatch(read, tampered).left).toContainEqual(expect.objectContaining({ code: 'malformed' }));

        expect(await store.commitBundle(computed.bundle)).toBe('committed');
        expect(await store.commitBundle(computed.bundle)).toBe('conflict');
        expect(JSON.stringify(computed)).toBe(beforeCommit);
        const stored = await store.readSentMessage(message.id.msgId);
        expect(JSON.stringify(stored?.msg)).toBe(JSON.stringify(message));
        expect(stored?.outboxKey).toEqual(outboxEntry.key);
    });

    it.each(['enqueue', 'dequeue'] as const)('retains the observed outbox entry instead of rebuilding it during %s', async (intent) => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('observed-outbox');
        const observedOutboxEntry = freezeValues(QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox', Temporal.Now.instant()));
        const admission = new ALOutboundDispatchAdmission<OutboundTestPayload>({
            lane: 'durable',
            admissionStore: store,
            toOutboxEntry: () => {
                throw new Error('Captured entries must not be rebuilt');
            },
            decodePreparedMessage: decodeOutboundTestPayload,
            clock: { nowMs: Date.now },
            browserLocks: undefined,
            diagnostics: undefined,
            settlements: () => {}
        });
        const result = await admission.commit({
            msg: message,
            planner: () => ({ msg: message, dropReasonCode: undefined, lane: 'durable', preparedMessages: [{ resourceId: message.route.resourceId }] }),
            intent,
            phase: intent === 'enqueue' ? 'immediate' : 'dequeue',
            origin: intent === 'enqueue' ? 'send' : 'drain',
            options: { observedOutboxEntry }
        });
        expect(result.committed).toBe(true);
        expect(result.computed.verdict).toMatchObject({ kind: 'admitted', durable: true });
        if (intent === 'enqueue') {
            expect(result.computed.entries).toEqual([{ ...observedOutboxEntry, status: 'COMPLETED' }]);
            expect(result.computed.entries[0].resource).toBe(observedOutboxEntry.resource);
        }
        expect(result.computed.bundle?.durableEffects[0].expireAtTimestamp).toBe(observedOutboxEntry.audit.expiryTs.epochMilliseconds);
        admission.dispose();
    });

    it('uses the fresh repair count to stop an exhausted repair without creating work', async () => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('exhausted-repair');
        const observed = await store.readOutgoingMessage({
            msg: message,
            planner: () => ({
                msg: message,
                dropReasonCode: undefined,
                lane: 'volatile',
                preparedMessages: [{ resourceId: 'exhausted-repair' }]
            }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const read: ALOutboundMessageReadDto<OutboundTestPayload> = freezeValues({
            ...observed,
            repairAttempt: { msgId: message.id.msgId, attempts: 3 }
        });

        const computed = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg, Temporal.Now.instant()),
            dispatchAtMs: 1_000,
            intent: 'repair',
            phase: 'immediate',
            options: { repairBudget: { priorAttempts: 1, maxAttempts: 3 } }
        });

        expect(computed.verdict.kind).toBe('skipped');
        expect(computed.bundle).toBeUndefined();
        expect(computed.entries).toEqual([]);
    });
});

function freezeValues<T>(value: T): T {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            freezeValues(child);
        }
        Object.freeze(value);
    }
    return value;
}
