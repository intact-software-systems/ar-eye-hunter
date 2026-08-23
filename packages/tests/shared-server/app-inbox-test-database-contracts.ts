import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { TestClientStateEventStore } from '@shared-test/shared-server/test-client-state-event-store.ts';
import type { TestGroupStateEventStore } from '@shared-test/shared-server/test-group-state-event-store.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export type AppInboxTestDatabase =
    & PSqlSql
    & Readonly<{
        clientEventStore: TestClientStateEventStore;
        groupEventStore: TestGroupStateEventStore;
        outboxEntries: ReadonlyMap<string, ResourceEntry>;
    }>;

export type AppInboxTestDatabaseStage = 'resource-result-replace' | 'reservation-finish' | 'transaction-commit-return';

export interface AppInboxTestDatabaseOptions {
    readonly runtimeRepository?: RuntimeStateOptimisticTransactionalRepositoryLike;
    readonly clientEventStore?: TestClientStateEventStore;
    readonly withTransaction?: <T>(write: () => Promise<T>) => Promise<T>;
    readonly shouldFailOutboxWrite?: () => boolean;
    readonly onTransactionRollback?: () => void | Promise<void>;
    readonly onStage?: (stage: AppInboxTestDatabaseStage) => void | Promise<void>;
}

export interface AppInboxTestResourceRepositories {
    readonly inbox: Readonly<{
        getItem(key: Key): Promise<ResourceEntry | undefined>;
        enqueue(entry: ResourceEntry): Promise<unknown>;
    }>;
    readonly results: Readonly<{
        replace(entry: ResourceEntry): Promise<ResourceEntry>;
    }>;
}

export interface AppInboxTestDatabaseState {
    readonly outboxEntries: Map<string, ResourceEntry>;
    readonly clientEventStore: TestClientStateEventStore;
    readonly groupEventStore: TestGroupStateEventStore;
}

export interface AppInboxTestPendingWrites {
    readonly results: ResourceEntry[];
    readonly inbox: ResourceEntry[];
    readonly outbox: Map<string, ResourceEntry>;
    readonly clientEvents: ClientEvent[];
    readonly groupEvents: GroupEvent[];
}

export interface AppInboxTestSqlExecution {
    readonly query: string;
    readonly values: readonly unknown[];
    readonly runtime: RuntimeStateOptimisticTransactionalRepositoryLike | undefined;
    readonly repositories: AppInboxTestResourceRepositories;
    readonly options: AppInboxTestDatabaseOptions;
    readonly state: AppInboxTestDatabaseState;
    readonly pending: AppInboxTestPendingWrites;
}
