import { describe, expect, it, vi } from 'vitest';

import {
    computeClientStateInboxMutation,
    validateClientStateInboxMutation
} from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-computation.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { createAtomicHarness } from '../app-inbox/test-support/app-inbox-transaction-test-runtime.ts';
import { emptyRead, principalCommand } from './client-mutation-compute-test-fixtures.ts';

describe('client AppInbox completion computation', () => {
    it('rejects proxy private observations without consulting candidate toJSON hooks', async () => {
        const command = await principalCommand();
        const read = {
            mutation: { command, read: emptyRead(command) },
            completionFacts: { entry: createAtomicHarness().entry, completedAtEpochMs: 2_000 }
        };
        const computed = computeClientStateInboxMutation(read);
        let serializationHooks = 0;
        const snapshot = new Proxy(computed.afterCommitResult.committedSnapshots[0], {
            get(target, property, receiver) {
                if (property === 'toJSON') {
                    serializationHooks += 1;
                    return () => target;
                }
                return Reflect.get(target, property, receiver);
            }
        });
        const candidate = { ...computed, afterCommitResult: { committedSnapshots: [snapshot] } };

        expect(validateClientStateInboxMutation(read, candidate).length).toBeGreaterThan(0);
        expect(serializationHooks).toBe(0);
    });

    it('rejects a proxy completion envelope before any candidate property access', async () => {
        const command = await principalCommand();
        const read = {
            mutation: { command, read: emptyRead(command) },
            completionFacts: { entry: createAtomicHarness().entry, completedAtEpochMs: 2_000 }
        };
        const computed = computeClientStateInboxMutation(read);
        let propertyReads = 0;
        const candidate = new Proxy(computed, {
            get(target, property, receiver) {
                propertyReads += 1;
                return Reflect.get(target, property, receiver);
            }
        });

        expect(validateClientStateInboxMutation(read, candidate).length).toBeGreaterThan(0);
        expect(propertyReads).toBe(0);
    });

    it('computes and validates persistence and private observations using only captured facts', async () => {
        const command = await principalCommand();
        const read = {
            mutation: { command, read: emptyRead(command) },
            completionFacts: { entry: createAtomicHarness().entry, completedAtEpochMs: 2_000 }
        };
        const original = JSON.stringify(read);
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
            throw new Error('Clock inside pure phase');
        });
        try {
            const computed = computeClientStateInboxMutation(read);
            expect(validateClientStateInboxMutation(read, computed)).toEqual([]);
            expect(computeClientStateInboxMutation(read)).toEqual(computed);
            expect(computed.completion.reservationFinish).toMatchObject({
                status: EntityStatus.COMPLETED,
                completedAt: new Date(2_000)
            });
            expect(JSON.parse(computed.completion.resultReplacement.resource)).toEqual(computed.completion.durableResult);
            expect(computed.clientWrites).toHaveLength(1);
            expect(computed.afterCommitResult.committedSnapshots).toEqual([computed.completion.durableResult.result.snapshot]);
            expect(JSON.stringify(read)).toBe(original);
        }
        finally {
            clock.mockRestore();
        }
    });

    it('rejects altered writes, durable completion, and private observations without replacing them', async () => {
        const command = await principalCommand();
        const read = {
            mutation: { command, read: emptyRead(command) },
            completionFacts: { entry: createAtomicHarness().entry, completedAtEpochMs: 2_000 }
        };
        const computed = computeClientStateInboxMutation(read);
        const candidate = {
            ...computed,
            clientWrites: [],
            afterCommitResult: { committedSnapshots: [] },
            completion: {
                ...computed.completion,
                reservationFinish: { ...computed.completion.reservationFinish, completedAt: new Date(3_000) }
            }
        };

        const issues = validateClientStateInboxMutation(read, candidate);

        expect(issues.some((issue) => issue.path.startsWith('computed.clientWrites.'))).toBe(true);
        expect(issues.some((issue) => issue.path.startsWith('computed.afterCommitResult.'))).toBe(true);
        expect(issues.some((issue) => issue.path === 'computed.completion.reservationFinish.completedAt')).toBe(true);
        expect(candidate.clientWrites).toEqual([]);
        expect(candidate.completion.reservationFinish.completedAt.getTime()).toBe(3_000);
    });
});
