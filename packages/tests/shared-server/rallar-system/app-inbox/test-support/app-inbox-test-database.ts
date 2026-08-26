import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { TestClientStateEventStore } from '@shared-test/shared-server/test-client-state-event-store.ts';
import { TestGroupStateEventStore } from '@shared-test/shared-server/test-group-state-event-store.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { type AppInboxTestDatabase, type AppInboxTestDatabaseOptions, type AppInboxTestResourceRepositories } from './app-inbox-test-database-contracts.ts';
import { createAppInboxTestTransaction } from './app-inbox-test-database-transaction.ts';

export type {
    AppInboxTestDatabase,
    AppInboxTestDatabaseStage
} from './app-inbox-test-database-contracts.ts';

export function createAppInboxTestDatabase(
    inbox: Readonly<{
        getItem(key: Key): Promise<ResourceEntry | undefined>;
        enqueue(entry: ResourceEntry): Promise<ResourceEntry | undefined>;
    }>,
    results: Readonly<{
        replace(entry: ResourceEntry): Promise<ResourceEntry>;
    }>,
    options: AppInboxTestDatabaseOptions = {}
): AppInboxTestDatabase {
    const repositories: AppInboxTestResourceRepositories = { inbox, results };
    const state = {
        outboxEntries: new Map<string, ResourceEntry>(),
        clientEventStore: options.clientEventStore ?? new TestClientStateEventStore(),
        groupEventStore: new TestGroupStateEventStore()
    };
    const database = Object.assign(createAppInboxTestDatabaseRootSql(), {
        clientEventStore: state.clientEventStore,
        groupEventStore: state.groupEventStore,
        outboxEntries: state.outboxEntries
    });
    database.begin = createAppInboxTestTransaction({ repositories, options, state });
    return database;
}

function createAppInboxTestDatabaseRootSql(): PSqlSql {
    function rootSql(values: readonly PSqlParameter[]): object;
    function rootSql<Result>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Result>;
    function rootSql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ..._values: readonly PSqlParameter[]
    ): object | Promise<Result> {
        if (!('raw' in stringsOrValues)) {
            return { values: stringsOrValues };
        }
        return Promise.reject(new Error('App inbox SQL must use the supplied transaction'));
    }

    return Object.assign(rootSql, {
        begin: async <T>(_write: (sql: PSqlSql) => Promise<T>): Promise<T> => {
            throw new Error('App inbox transaction owner is not installed');
        }
    });
}
