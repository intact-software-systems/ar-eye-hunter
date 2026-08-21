import { InMemoryClientStateEventStore, InMemoryGroupStateEventStore } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
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
        enqueue(entry: ResourceEntry): Promise<unknown>;
    }>,
    results: Readonly<{
        replace(entry: ResourceEntry): Promise<ResourceEntry>;
    }>,
    options: AppInboxTestDatabaseOptions = {}
): AppInboxTestDatabase {
    const repositories: AppInboxTestResourceRepositories = { inbox, results };
    const state = {
        outboxEntries: new Map<string, ResourceEntry>(),
        clientEventStore: options.clientEventStore ?? new InMemoryClientStateEventStore(),
        groupEventStore: new InMemoryGroupStateEventStore()
    };
    const database = (async () => {
        throw new Error('App inbox SQL must use the supplied transaction');
    }) as unknown as AppInboxTestDatabase;
    database.begin = createAppInboxTestTransaction({ repositories, options, state });
    Object.defineProperties(database, {
        clientEventStore: { value: state.clientEventStore },
        groupEventStore: { value: state.groupEventStore },
        outboxEntries: { value: state.outboxEntries }
    });
    return database;
}
