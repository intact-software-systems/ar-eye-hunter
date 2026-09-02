import { AppInboxReservationConflictError } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { classifyAppInboxError } from '@shared-server/rallar-system/app-inbox/app-inbox-error-classification.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { EntityStatus, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

import { createAtomicHarness } from '../test-support/app-inbox-transaction-test-runtime.ts';

describe('AppInboxTransactionWriter atomic finalization', () => {
    it('commits mutation, outbox, result, and completion in one transaction', async () => {
        const harness = createAtomicHarness();
        const receipt = { status: 'accepted', revision: 2 } as const;

        const result = await harness.service.commit(harness.context, receipt, async (transaction) => {
            expect(transaction).toBe(harness.database.activeTransaction);
            harness.database.writeMutation('group-1', { revision: 2 });
            harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
        });

        expect(result).toEqual(receipt);
        expect(harness.database.beginCalls).toBe(1);
        expect(harness.database.state.mutations.get('group-1')).toEqual({ revision: 2 });
        expect(harness.database.state.outbox.get('outbox-1')).toEqual({ groupId: 'group-1' });
        expect(
            JSON.parse(harness.database.state.results.get(toKeyAsString(harness.entry.key))!.resource)
        ).toEqual(receipt);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(
            EntityStatus.COMPLETED
        );
    });

    it.each(['dependent-write', 'outbox-write'] as const)(
        'rolls the mutation back when the %s fails',
        async (failurePhase) => {
            const harness = createAtomicHarness();

            await expect(
                harness.service.commit(harness.context, { status: 'accepted' }, async () => {
                    harness.database.writeMutation('group-1', { revision: 2 });
                    if (failurePhase === 'dependent-write') {
                        throw new Error('dependent write failed');
                    }
                    harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
                    throw new Error('outbox write failed');
                })
            ).rejects.toThrow(`${failurePhase.split('-')[0]} write failed`);

            expect(harness.database.state.mutations.size).toBe(0);
            expect(harness.database.state.outbox.size).toBe(0);
            expect(harness.database.state.results.size).toBe(0);
            expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(
                EntityStatus.RESERVED
            );
        }
    );

    it('rolls every successful write back when the result write fails', async () => {
        const harness = createAtomicHarness({ failResultWrite: true });

        await expect(
            harness.service.commit(harness.context, { status: 'accepted' }, async () => {
                harness.database.writeMutation('group-1', { revision: 2 });
                harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
            })
        ).rejects.toThrow('result write failed');

        expect(harness.database.state.mutations.size).toBe(0);
        expect(harness.database.state.outbox.size).toBe(0);
        expect(harness.database.state.results.size).toBe(0);
    });

    it('rolls every successful write back when reservation ownership changed', async () => {
        const harness = createAtomicHarness({ loseReservation: true });

        await expect(
            harness.service.commit(harness.context, { status: 'accepted' }, async () => {
                harness.database.writeMutation('group-1', { revision: 2 });
                harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
            })
        ).rejects.toBeInstanceOf(AppInboxReservationConflictError);
        await expect(
            harness.service.commit(harness.context, null, async () => {})
        ).rejects.toMatchObject({ code: 'app-inbox-reservation-conflict' });

        expect(harness.database.state.mutations.size).toBe(0);
        expect(harness.database.state.outbox.size).toBe(0);
        expect(harness.database.state.results.size).toBe(0);
    });

    it('writes terminal policy denial result and FAILED completion atomically', async () => {
        const harness = createAtomicHarness();
        const denial = new GroupPolicyDeniedError({
            allowed: false,
            code: 'group-policy-denied',
            message: 'membership is required',
            details: { groupId: 'group-1' }
        });

        const classification = classifyAppInboxError(denial);
        expect(classification).toMatchObject({ kind: 'terminal' });
        if (classification.kind !== 'terminal') {
            throw new Error('Expected terminal denial');
        }
        const failureInput = {
            entry: harness.entry,
            durableResult: classification.result,
            status: EntityStatus.FAILED,
            completedAtEpochMs: Date.parse('2026-07-22T12:00:01.000Z')
        };
        const computed = computeAppInboxCompletion(failureInput);
        expect(validateAppInboxCompletion(failureInput, computed)).toEqual([]);
        await harness.service.fail(harness.context, computed);

        const stored = harness.database.state.results.get(toKeyAsString(harness.entry.key));
        expect(stored?.status).toBe(EntityStatus.FAILED);
        expect(JSON.parse(stored!.resource)).toMatchObject({
            code: 'group-policy-denied',
            message: 'membership is required'
        });
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(
            EntityStatus.FAILED
        );
    });

    it('classifies CAS conflicts as retryable without writing a result', async () => {
        const harness = createAtomicHarness();
        const conflict = Object.assign(new Error('conditional write lost'), {
            code: 'runtime-state-write-conflict',
            status: 503
        });

        expect(classifyAppInboxError(conflict)).toEqual({
            kind: 'retryable',
            code: 'runtime-state-write-conflict',
            message: 'AppInbox processing encountered a retryable conflict'
        });
        expect(harness.database.state.results.size).toBe(0);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(
            EntityStatus.RESERVED
        );

        expect(
            classifyAppInboxError(new AppInboxReservationConflictError(harness.entry.key))
        ).toMatchObject({
            kind: 'retryable',
            code: 'app-inbox-reservation-conflict'
        });
    });

    it('records transaction and write timing for the winning attempt', async () => {
        const timing: RallarTimingEvent[] = [];
        const harness = createAtomicHarness({ timing: (event) => timing.push(event) });

        await harness.service.commit(harness.context, { status: 'accepted' }, async () => {});

        expect(timing.filter((event) => event.operation === 'transaction')).toHaveLength(1);
        expect(timing.filter((event) => event.operation === 'write')).toHaveLength(1);
        for (const event of timing) {
            expect(event.details).toMatchObject({ attempt: 7 });
            expect(event.details).not.toHaveProperty('plan');
        }
    });
});
