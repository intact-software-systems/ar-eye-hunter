import {
    describe,
    expect,
    it
} from 'vitest';
import { createOutboundCanonicalEntry } from './outbound-runtime-test-fixture.ts';

import type { ALOutboundMessageReadDto } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { validateALOutboundDispatch } from '@shared/alm/outbound/validate-al-outbound-dispatch.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { createDefaultOutboundTestAdmissionStore, createOutboundMessage } from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound dispatch value ownership', () => {
    it('rejects a mismatched queue resource before admitting message ownership or work', async () => {
        const store = createDefaultOutboundTestAdmissionStore();
        const message = createOutboundMessage('intended-message');
        const wrongEntry = QueueBoxUtilities.toResourceEntryFromMsg(createOutboundMessage('other-message'), 'outbox');
        const admission = new ALOutboundDispatchAdmission<OutboundTestPayload>({
            admissionStore: store,
            toOutboxEntry: () => wrongEntry,
            decodePreparedMessage: decodeOutboundTestPayload,
            clock: { nowMs: Date.now },
            browserLocks: undefined,
            diagnostics: undefined
        });

        const result = await admission.commit({
            msg: message,
            planner: () => ({ msg: message, persist: true, preparedMessages: [] }),
            intent: 'enqueue',
            phase: 'immediate',
            options: {}
        });

        expect(result.computed.status).toBe('failed');
        expect(result.computed.reason).toBe('Outbound queue candidate differs from its message');
        expect(result.committed).toBe(false);
        expect(await store.readSentMessage(message.id.msgId)).toBeUndefined();
        expect(await store.peekNextEffectReadyAt()).toBeUndefined();
        admission.dispose();
    });

    it('computes from captured values and preserves the candidate through a real successful and conflicting commit', async () => {
        const store = createDefaultOutboundTestAdmissionStore();
        const message = createOutboundMessage('immutable-dispatch');
        const read = await store.readOutgoingMessage({
            msg: message,
            planner: () => ({
                msg: message,
                persist: true,
                preparedMessages: [] as readonly OutboundTestPayload[],
                supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-value' }
            }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const outboxEntry = QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox');
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
        expect(computed.status).toBe('enqueued');
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

        expect(await store.commitBundle(computed.bundle, decodeOutboundTestPayload)).toBe('committed');
        expect(await store.commitBundle(computed.bundle, decodeOutboundTestPayload)).toBe('conflict');
        expect(JSON.stringify(computed)).toBe(beforeCommit);
        const stored = await store.readSentMessage(message.id.msgId);
        expect(JSON.stringify(stored?.msg)).toBe(JSON.stringify(message));
        expect(stored?.outboxKey).toEqual(outboxEntry.key);
    });

    it.each(['enqueue', 'dequeue'] as const)('retains the observed outbox entry instead of rebuilding it during %s', async (intent) => {
        const store = createDefaultOutboundTestAdmissionStore();
        const message = createOutboundMessage('observed-outbox');
        const observedOutboxEntry = freezeValues(QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox'));
        const admission = new ALOutboundDispatchAdmission<OutboundTestPayload>({
            admissionStore: store,
            toOutboxEntry: () => {
                throw new Error('Captured entries must not be rebuilt');
            },
            decodePreparedMessage: decodeOutboundTestPayload,
            clock: { nowMs: Date.now },
            browserLocks: undefined,
            diagnostics: undefined
        });
        const result = await admission.commit({
            msg: message,
            planner: () => ({ msg: message, persist: true, preparedMessages: [{ resourceId: message.route.resourceId }] }),
            intent,
            phase: intent === 'enqueue' ? 'immediate' : 'dequeue',
            options: { observedOutboxEntry }
        });
        expect(result.committed).toBe(true);
        expect(result.computed.status).toBe('enqueued');
        if (intent === 'enqueue') {
            expect(result.computed.entries).toEqual([{ ...observedOutboxEntry, status: 'COMPLETED' }]);
            expect(result.computed.entries[0].resource).toBe(observedOutboxEntry.resource);
        }
        expect(result.computed.bundle?.durableEffects[0].expireAtTimestamp).toBe(observedOutboxEntry.audit.expiryTs.epochMilliseconds);
        admission.dispose();
    });

    it('uses the fresh repair count to stop an exhausted repair without creating work', async () => {
        const store = createDefaultOutboundTestAdmissionStore();
        const message = createOutboundMessage('exhausted-repair');
        const observed = await store.readOutgoingMessage({
            msg: message,
            planner: () => ({
                msg: message,
                persist: false,
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
            outboxEntry: createOutboundCanonicalEntry(store, read.msg),
            dispatchAtMs: 1_000,
            intent: 'repair',
            phase: 'immediate',
            options: { repairBudget: { priorAttempts: 1, maxAttempts: 3 } }
        });

        expect(computed.status).toBe('skipped');
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
