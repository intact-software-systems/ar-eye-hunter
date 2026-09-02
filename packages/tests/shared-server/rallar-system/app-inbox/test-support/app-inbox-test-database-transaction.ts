import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { computeGroupStateEventWrite } from '@shared-server/rallar-system/state-events/group-state-event-store.ts';
import type { RuntimeStateOptimisticTransactionRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';

import {
    type AppInboxTestDatabaseOptions,
    type AppInboxTestDatabaseState,
    type AppInboxTestPendingWrites,
    type AppInboxTestResourceRepositories
} from './app-inbox-test-database-contracts.ts';
import { createAppInboxTestDatabaseSql } from './app-inbox-test-database-sql.ts';

interface CreateAppInboxTestTransactionInput {
    readonly repositories: AppInboxTestResourceRepositories;
    readonly options: AppInboxTestDatabaseOptions;
    readonly state: AppInboxTestDatabaseState;
}

interface RunAppInboxTestTransactionInput<T> extends CreateAppInboxTestTransactionInput {
    readonly write: (transaction: PSqlSql) => Promise<T>;
    readonly runtime: RuntimeStateOptimisticTransactionRepositoryLike | undefined;
}

export function createAppInboxTestTransaction({
    repositories,
    options,
    state
}: CreateAppInboxTestTransactionInput) {
    return async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
        try {
            const execute = async (
                runtime: RuntimeStateOptimisticTransactionRepositoryLike | undefined
            ) => await runAppInboxTestTransaction({ repositories, options, state, write, runtime });
            return options.runtimeRepository
                ? await options.runtimeRepository.begin(execute)
                : await execute(undefined);
        }
        catch (error) {
            await options.onTransactionRollback?.();
            throw error;
        }
    };
}

async function runAppInboxTestTransaction<T>(
    transactionInput: RunAppInboxTestTransactionInput<T>
): Promise<T> {
    const execute = async () => await writePendingAppInboxTestTransaction(transactionInput);
    return transactionInput.options.withTransaction
        ? await transactionInput.options.withTransaction(execute)
        : await execute();
}

async function writePendingAppInboxTestTransaction<T>({
    repositories,
    options,
    state,
    write,
    runtime
}: RunAppInboxTestTransactionInput<T>): Promise<T> {
    const pending = createAppInboxTestPendingWrites(state);
    const transaction = createAppInboxTestDatabaseSql({
        repositories,
        options,
        state,
        pending,
        runtime
    });
    const output = await write(transaction);
    await options.onStage?.('transaction-commit-return');
    await publishAppInboxTestPendingWrites({ repositories, state, pending });
    return output;
}

function createAppInboxTestPendingWrites(
    state: AppInboxTestDatabaseState
): AppInboxTestPendingWrites {
    return {
        results: [],
        inbox: [],
        outbox: new Map(state.outboxEntries),
        clientEvents: [],
        groupEvents: []
    };
}

interface PublishAppInboxTestPendingWritesInput {
    readonly repositories: AppInboxTestResourceRepositories;
    readonly state: AppInboxTestDatabaseState;
    readonly pending: AppInboxTestPendingWrites;
}

async function publishAppInboxTestPendingWrites({
    repositories,
    state,
    pending
}: PublishAppInboxTestPendingWritesInput): Promise<void> {
    for (const entry of pending.results) {
        await repositories.results.replace(entry);
    }
    for (const entry of pending.inbox) {
        await repositories.inbox.enqueue(entry);
    }
    state.outboxEntries.clear();
    for (const [key, entry] of pending.outbox) {
        state.outboxEntries.set(key, entry);
    }
    for (const event of pending.clientEvents) {
        await state.clientEventStore.appendClientEvent(event);
    }
    for (const event of pending.groupEvents) {
        await state.groupEventStore.appendGroupEvent(computeGroupStateEventWrite(event));
    }
}
