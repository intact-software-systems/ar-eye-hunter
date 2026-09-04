import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    validateAppInboxCompletionFacts
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { EntityStatus, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { createAtomicHarness } from '../test-support/app-inbox-transaction-test-runtime.ts';

describe('AppInbox successful completion computation', () => {
    it('validates captured completion facts without inspecting the durable result', () => {
        const harness = createAtomicHarness();
        let propertyReads = 0;
        const facts = {
            ...new AppInboxTransactionWriter({ database: harness.database.sql }, { serviceId: 'server-1' })
                .readCompletionFacts(harness.context),
            completedAtEpochMs: Number.NaN,
            status: EntityStatus.COMPLETED,
            get durableResult() {
                propertyReads += 1;
                return { status: 'accepted' };
            }
        } as const;

        const issues = validateAppInboxCompletionFacts(facts);

        expect(issues.map((issue) => issue.path)).toEqual(['completedAtEpochMs']);
        expect(propertyReads).toBe(0);
    });

    it('rejects completion data for a different reservation', () => {
        const harness = createAtomicHarness();
        const writer = new AppInboxTransactionWriter({ database: harness.database.sql }, { serviceId: 'server-1' });
        const durableResult = { status: 'accepted', revision: 2 } as const;
        const input = { ...writer.readCompletionFacts(harness.context), status: EntityStatus.COMPLETED, durableResult };
        const computed = computeAppInboxCompletion(input);
        const candidate = {
            ...computed,
            reservationFinish: {
                ...computed.reservationFinish,
                expectedAttempts: computed.reservationFinish.expectedAttempts + 1
            }
        };

        const issues = validateAppInboxCompletion(input, candidate);

        expect(issues.map((issue) => issue.path)).toEqual(['computed.reservationFinish']);
        expect(harness.database.beginCalls).toBe(0);
    });

    it('validates reservation identity by value rather than object identity', () => {
        const harness = createAtomicHarness();
        const writer = new AppInboxTransactionWriter({ database: harness.database.sql }, { serviceId: 'server-1' });
        const input = {
            ...writer.readCompletionFacts(harness.context),
            status: EntityStatus.COMPLETED,
            durableResult: { status: 'accepted' }
        } as const;
        const computed = computeAppInboxCompletion(input);
        const copied = {
            ...computed,
            reservationFinish: {
                ...computed.reservationFinish,
                key: { ...computed.reservationFinish.key }
            },
            finalizedEntry: {
                ...computed.finalizedEntry,
                key: { ...computed.finalizedEntry.key }
            }
        };

        expect(validateAppInboxCompletion(input, copied)).toEqual([]);
    });

    it('captures completion facts in read and consumes the exact result in write', async () => {
        const harness = createAtomicHarness();
        let clockReads = 0;
        let readAllowed = true;
        const nowEpochMs = () => {
            if (!readAllowed) {
                throw new Error('Completion facts were read after compute');
            }
            clockReads += 1;
            return Date.parse('2026-07-22T12:00:01.000Z');
        };
        const writer = new AppInboxTransactionWriter({ database: harness.database.sql }, { serviceId: 'server-1', nowEpochMs });
        const facts = writer.readCompletionFacts(harness.context);
        const durableResult = { status: 'accepted', revision: 2 } as const;
        const input = { ...facts, status: EntityStatus.COMPLETED, durableResult };
        const computed = computeAppInboxCompletion(input);
        expect(validateAppInboxCompletion(input, computed)).toEqual([]);
        readAllowed = false;

        const result = await writer.writeComputedMutation(harness.context, computed, async () => {
            harness.database.writeMutation('group-1', { revision: 2 });
        });

        expect(result).toBe(durableResult);
        expect(clockReads).toBe(1);
        expect(harness.database.beginCalls).toBe(1);
        const key = toKeyAsString(harness.entry.key);
        expect(harness.database.state.results.get(key)?.resource).toBe(JSON.stringify(durableResult));
        expect(harness.database.state.inbox.get(key)?.status).toBe(EntityStatus.COMPLETED);
    });

    it('keeps private after-commit data separate from the computed durable result', async () => {
        const harness = createAtomicHarness();
        const writer = new AppInboxTransactionWriter({ database: harness.database.sql }, { serviceId: 'server-1' });
        const durableResult = { status: 'accepted' } as const;
        const input = { ...writer.readCompletionFacts(harness.context), status: EntityStatus.COMPLETED, durableResult };
        const computed = computeAppInboxCompletion(input);
        expect(validateAppInboxCompletion(input, computed)).toEqual([]);
        const afterCommitResult = { wakeQueue: true };

        const result = await writer.writeComputedMutationWithAfterCommitResult(
            harness.context,
            computed,
            async () => afterCommitResult
        );

        expect(result).toEqual({ durableResult, afterCommitResult });
        expect(harness.database.state.results.get(toKeyAsString(harness.entry.key))?.resource).toBe(JSON.stringify(durableResult));
    });
});
