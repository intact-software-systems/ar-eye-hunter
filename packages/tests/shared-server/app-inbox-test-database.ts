import { Temporal } from '@js-temporal/polyfill';
import type { EntityStatus, Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type {
    PSqlSql,
    PSqlTransactionSql,
} from '@shared-server/postgres/PostgresSqlClient.ts';
import type { AppInboxTransactionRepositories } from '@shared-server/rallar-system/services/AppInboxService.ts';

export type AppInboxTestDatabase = PSqlSql & Readonly<{
    appInboxTransactionRepositories: AppInboxTransactionRepositories;
}>;

export function createAppInboxTestDatabase(
    inbox: Readonly<{
        getItem(key: Key): Promise<ResourceEntry | undefined>;
        enqueue(entry: ResourceEntry): Promise<unknown>;
    }>,
    results: Readonly<{
        replace(entry: ResourceEntry): Promise<ResourceEntry>;
    }>,
): AppInboxTestDatabase {
    const database = (async () => {
        throw new Error('Unexpected raw SQL in app inbox unit test');
    }) as unknown as AppInboxTestDatabase;
    database.begin = async <T>(
        write: (transaction: PSqlTransactionSql) => Promise<T>,
    ) => await write(database);
    Object.defineProperty(database, 'appInboxTransactionRepositories', {
        value: () => ({
            resourceInboxResults: results,
            resourceInbox: {
                finishReserved: async (
                    key: Key,
                    expectedAttempts: number,
                    status: EntityStatus,
                    completedAt: Date,
                ) => {
                    const current = await inbox.getItem(key);
                    if (
                        !current ||
                        current.status !== 'RESERVED' ||
                        current.dequeueAudit.attempts !== expectedAttempts
                    ) return false;
                    await inbox.enqueue({
                        ...current,
                        status,
                        dequeueAudit: {
                            ...current.dequeueAudit,
                            endTs: Temporal.Instant.fromEpochMilliseconds(
                                completedAt.getTime(),
                            ),
                            nextTs: undefined,
                        },
                    });
                    return true;
                },
            },
        }),
    });
    return database;
}
