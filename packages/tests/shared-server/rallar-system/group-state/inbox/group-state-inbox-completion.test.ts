import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxExecutionMetadata } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import * as completion from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { toAuthorisedWsClientConnection } from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it, vi } from 'vitest';
import { processNext, requireQueuedType } from '../../app-inbox/test-support/app-inbox-queue-entry-test-helpers.ts';
import { createAppInboxWsCloseHarness, createAuthorisedWsCloseFacts } from '../../app-inbox/test-support/app-inbox-ws-close-test-harness.ts';
import { createGroupStateTransactionBoundaryHarness } from './group-state-transaction-boundary-fixture.ts';

describe('group AppInbox completion ownership', () => {
    it('rejects altered completion bytes before opening the domain transaction', async () => {
        const harness = await createGroupStateTransactionBoundaryHarness();
        const original = completion.computeAppInboxCompletion;
        const compute = vi.spyOn(completion, 'computeAppInboxCompletion').mockImplementation(
            <Result>(input: completion.AppInboxCompletionInput<Result>): completion.AppInboxCompletionComputed<Result> => {
                const computed = original(input);
                return {
                    ...computed,
                    resultReplacement: { ...computed.resultReplacement, resource: '{"tampered":true}' }
                };
            }
        );
        try {
            await expect(harness.handler.processGroupStateMutation(harness.context)).rejects.toThrow(
                'AppInbox computed.resultReplacement.resource differs from the computed value'
            );

            expect(harness.reachedStages).toEqual([]);
            expect(await harness.repository.readSnapshot(harness.groupRef)).toBeUndefined();
            expect(await harness.results.findByKey(harness.context.entry.key)).toBeUndefined();
        }
        finally {
            compute.mockRestore();
        }
    });

    it('completes group session cleanup with validated completion data even when no groups are active', async () => {
        const harness = await createAppInboxWsCloseHarness();
        const facts = createAuthorisedWsCloseFacts(harness.authSession, 'completion-cleanup', 1);
        const originalValidate = completion.validateAppInboxCompletion;
        let validationCount = 0;
        const validate = vi.spyOn(completion, 'validateAppInboxCompletion').mockImplementation(
            <Result>(input: completion.AppInboxCompletionInput<Result>, computed: completion.AppInboxCompletionComputed<Result>) => {
                validationCount += 1;
                expect(computed.durableResult).toEqual({
                    status: 'inactive',
                    sessionId: harness.authSession.sessionId,
                    generationId: facts.generationId,
                    affectedGroups: 0
                });
                return originalValidate(input, computed);
            }
        );
        try {
            await harness.group.enqueueGroupSessionCleanup({
                connection: toAuthorisedWsClientConnection(facts),
                disconnectedAtEpochMs: facts.disconnectedAtEpochMs,
                reason: facts.reason
            });
            await processNext(harness.reader);

            expect((await requireQueuedType(harness.queue, AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP)).status).toBe(
                EntityStatus.COMPLETED
            );
            expect(validationCount).toBe(1);
        }
        finally {
            validate.mockRestore();
        }
    });

    it('computes and validates completion before invoking the writer', async () => {
        const harness = await createGroupStateTransactionBoundaryHarness();
        const stages: string[] = [];
        const originalReadFacts = harness.transactionWriter.readCompletionFacts.bind(harness.transactionWriter);
        const readFacts = vi.spyOn(harness.transactionWriter, 'readCompletionFacts').mockImplementation((context) => {
            stages.push('read');
            return originalReadFacts(context);
        });
        const originalCompute = completion.computeAppInboxCompletion;
        const compute = vi.spyOn(completion, 'computeAppInboxCompletion').mockImplementation(
            <Result>(input: completion.AppInboxCompletionInput<Result>) => {
                stages.push('compute');
                return originalCompute(input);
            }
        );
        const originalValidate = completion.validateAppInboxCompletion;
        const validate = vi.spyOn(completion, 'validateAppInboxCompletion').mockImplementation(
            <Result>(input: completion.AppInboxCompletionInput<Result>, computed: completion.AppInboxCompletionComputed<Result>) => {
                stages.push('validate');
                return originalValidate(input, computed);
            }
        );
        const originalWrite = harness.transactionWriter.writeMutation.bind(harness.transactionWriter);
        let written: object | undefined;
        const write = vi.spyOn(harness.transactionWriter, 'writeMutation').mockImplementation(
            async <Result>(
                context: AppInboxExecutionMetadata,
                computed: completion.AppInboxCompletionComputed<Result>,
                operation: (transaction: PSqlSql) => Promise<void>
            ) => {
                stages.push('write');
                written = computed;
                return await originalWrite(context, computed, operation);
            }
        );
        try {
            const result = await harness.handler.processGroupStateMutation(harness.context);

            expect(stages).toEqual(['read', 'compute', 'validate', 'write']);
            expect(written).toMatchObject({ durableResult: result });
            expect((await harness.results.findByKey(harness.context.entry.key))?.resource).toBe(JSON.stringify(result));
        }
        finally {
            readFacts.mockRestore();
            compute.mockRestore();
            validate.mockRestore();
            write.mockRestore();
        }
    });
});
