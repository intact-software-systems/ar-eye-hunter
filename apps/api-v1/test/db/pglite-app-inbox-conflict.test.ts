import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { AppInboxReservationConflictError, AppInboxType, type AppInboxExecutionMetadata } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { classifyAppInboxError } from '@shared-server/rallar-system/app-inbox/app-inbox-error-classification.ts';
import { toAppInboxResourceEntry } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { createAppInboxRetryFinalizer } from '@shared-server/rallar-system/app-inbox/app-inbox-retry-finalization.ts';
import { computeAppInboxCompletion, validateAppInboxCompletion } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { computeResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import assert from 'node:assert/strict';
import { createResourceEntry, withPGliteSql } from './pglite-auth-test-harness.ts';

for (const owner of ['handler', 'retry-finalizer'] as const) {
    Deno.test(`${owner} reservation conflict keeps typed identity without caller serialization and rolls back`, async () => {
        await withPGliteSql(async (sql) => {
            const repository = createPSqlResourceInboxRepository(sql, () => new Date());
            const enqueue = {
                type: AppInboxType.GROUP_CREATE,
                topicId: 'app-inbox.group-state',
                resourceId: `conflict-${owner}`,
                contextId: 'conflict-group',
                data: { requestId: `conflict-${owner}` }
            } as const;
            const entry: ResourceEntry = {
                ...toAppInboxResourceEntry(enqueue, 'conflict-test'),
                status: EntityStatus.RESERVED,
                dequeueAudit: { attempts: 2 }
            };
            const current = { ...entry, dequeueAudit: { attempts: 3 } };
            const dependent = createResourceEntry(`dependent-${owner}`);
            await repository.entries.write(current);
            await repository.entries.write(dependent);
            const storedCurrent = await repository.entries.findAnyByKey(entry.key);
            const storedDependent = await repository.entries.findAnyByKey(dependent.key);
            assert.ok(storedCurrent);
            assert.ok(storedDependent);
            const completedAtEpochMs = Date.now();
            const attempt = computeResourceInboxAttempt({
                entry,
                selectedLane: Reservator.FINALIZATION,
                selectedAtEpochMs: completedAtEpochMs,
                selectedDueAtEpochMs: undefined
            });
            const completionInput = {
                entry,
                completedAtEpochMs,
                status: EntityStatus.COMPLETED,
                durableResult: { accepted: true }
            } as const;
            const completion = computeAppInboxCompletion(completionInput);
            assert.deepEqual(validateAppInboxCompletion(completionInput, completion), []);
            const context: AppInboxExecutionMetadata = {
                enqueue,
                entry,
                message: decodePersistedALMessage(entry.resource),
                attemptTelemetry: attempt.telemetry
            };
            let transactions = 0;
            let serializedKeys = 0;
            const begin = sql.begin.bind(sql);
            sql.begin = async <Result>(write: (transaction: PSqlSql) => Promise<Result>): Promise<Result> => {
                transactions += 1;
                return await begin(async (transaction) => {
                    const stringify = JSON.stringify;
                    JSON.stringify = (value: Parameters<typeof JSON.stringify>[0]) => {
                        if (value === entry.key) {
                            serializedKeys += 1;
                            throw new Error('Caller key serialized inside strict transaction');
                        }
                        return stringify(value);
                    };
                    try {
                        return await write(transaction);
                    }
                    finally {
                        JSON.stringify = stringify;
                    }
                });
            };
            const operation = owner === 'handler'
                ? () =>
                    new AppInboxTransactionWriter({ database: sql }, { serviceId: 'conflict-test' })
                        .writeComputedMutation(context, completion, async (transaction) => {
                            await transaction`update resource_inbox set ri_resource = 'uncommitted'
                            where ri_resource_id = ${dependent.key.resourceId}`;
                        })
                : () =>
                    createAppInboxRetryFinalizer({ database: sql })({
                        entry,
                        processingAttempts: 1,
                        reservationAttempt: 2,
                        lane: Reservator.FINALIZATION,
                        classification: 'retryable',
                        exhausted: true,
                        failure: { source: 'finalization-recovery' },
                        queueAgeMs: 100,
                        dueAgeMs: 50,
                        selectedDueAtEpochMs: completedAtEpochMs - 50,
                        finalizedAtEpochMs: completedAtEpochMs
                    });
            await assert.rejects(operation, (error) => {
                assert.equal(serializedKeys, 0, 'Reached strict conflict branch must not serialize the caller key');
                assert.ok(error instanceof AppInboxReservationConflictError);
                assert.equal(error.name, 'AppInboxReservationConflictError');
                assert.equal(error.code, 'app-inbox-reservation-conflict');
                assert.equal(error.status, 409);
                assert.deepEqual(error.key, entry.key);
                assert.deepEqual(classifyAppInboxError(error), {
                    kind: 'retryable',
                    code: 'app-inbox-reservation-conflict',
                    message: 'AppInbox processing encountered a retryable conflict'
                });
                return true;
            });
            assert.equal(transactions, 1);
            assert.equal(serializedKeys, 0);
            assert.deepEqual(await repository.entries.findAnyByKey(entry.key), storedCurrent);
            assert.deepEqual(await repository.entries.findAnyByKey(dependent.key), storedDependent);
            const results = await sql<{ count: number; }[]>`select count(*)::integer as count from resource_inbox_results`;
            assert.equal(results[0]?.count, 0);
        });
    });
}
