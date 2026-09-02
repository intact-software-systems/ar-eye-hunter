import type {
    RuntimeStateGuardedBatchResult,
    RuntimeStateGuardedBatchTransaction,
    RuntimeStateGuardedBatchWrite
} from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateGuardedBatchTransactionalRepositoryLike,
    RuntimeStateOptimisticTransactionRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import {
    assertRuntimeStateExpectedRevision,
    assertRuntimeStateUpsertExpectedRevision
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '../read-batch/runtime-state-read-batch.ts';
import { writeRuntimeStateGuardedBatch } from './write-runtime-state-guarded-batch.ts';
import { readRuntimeStateBatch } from './read-runtime-state-batch.ts';
import {
    decodeRuntimeStateRevision,
    decodeRuntimeStateRow,
    type RuntimeStateDatabaseRow
} from './runtime-state-row-codec.ts';
import { toExclusivePrefixEnd, toPgDate } from './runtime-state-sql-values.ts';

interface RuntimeStateSavepointSql extends PSqlSql {
    savepoint<T>(fn: (sql: PSqlSql) => Promise<T>): Promise<T>;
}

type RuntimeStateSqlState =
    | Readonly<{ kind: 'root'; sql: PSqlSql; }>
    | Readonly<{ kind: 'transaction'; sql: PSqlSql; }>;

export function createTransactionBoundPSqlRuntimeStateRepository(
    transaction: PSqlSql
): PSqlRuntimeStateRepository {
    return new PSqlRuntimeStateRepository(transaction, {
        kind: 'transaction',
        sql: transaction
    });
}

export class PSqlRuntimeStateRepository
    implements RuntimeStateGuardedBatchTransactionalRepositoryLike, RuntimeStateGuardedBatchTransaction {
    private readonly sqlState: RuntimeStateSqlState;

    public readonly sql: PSqlSql;

    constructor(sql: PSqlSql, sqlState?: RuntimeStateSqlState) {
        this.sql = sql;
        this.sqlState = sqlState ?? {
            kind: 'root',
            sql
        };
    }

    async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        return await readRuntimeStateBatch(this.sql, selectors);
    }

    async begin<T>(
        fn: (
            repository: RuntimeStateOptimisticTransactionRepositoryLike
        ) => Promise<T>
    ): Promise<T> {
        if (this.sqlState.kind === 'transaction') {
            const savepointSql = requireSavepointSql(this.sqlState.sql);
            return await savepointSql.savepoint(async (sql) => {
                const savepointSql = requireSavepointSql(sql);
                return await fn(
                    new PSqlRuntimeStateRepository(savepointSql, {
                        kind: 'transaction',
                        sql: savepointSql
                    })
                );
            });
        }

        return await this.sqlState.sql.begin(async (sql: PSqlSql) => {
            const transactionSql = requireSavepointSql(sql);
            return await fn(createTransactionBoundPSqlRuntimeStateRepository(transactionSql));
        });
    }

    async writeGuardedBatch(
        computed: RuntimeStateGuardedBatchWrite
    ): Promise<RuntimeStateGuardedBatchResult> {
        if (this.sqlState.kind !== 'transaction') {
            throw new Error(
                'Guarded runtime state batches require a transaction-scoped repository.'
            );
        }
        return await writeRuntimeStateGuardedBatch(this.sql, computed);
    }

    async findEntry(
        namespace: string,
        key: string
    ): Promise<RuntimeStateEntry | undefined> {
        const rows = await this.sql<RuntimeStateDatabaseRow[]>`
            select store_value, store_namespace, store_key, updated_ts, expire_at_ts, revision
            from runtime_state_store
            where store_namespace = ${namespace}
              and store_key = ${key}
            limit 1
        `;

        return rows[0] ? decodeRuntimeStateRow(rows[0]) : undefined;
    }

    async findAllEntries(
        namespace: string
    ): Promise<readonly RuntimeStateEntry[]> {
        const rows = await this.sql<RuntimeStateDatabaseRow[]>`
            select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
            from runtime_state_store
            where store_namespace = ${namespace}
            order by store_key
        `;

        return rows.map(decodeRuntimeStateRow);
    }

    async findEntriesByPrefix(
        namespace: string,
        keyPrefix: string
    ): Promise<readonly RuntimeStateEntry[]> {
        if (keyPrefix.length === 0) {
            return await this.findAllEntries(namespace);
        }

        const prefixEnd = toExclusivePrefixEnd(keyPrefix);
        const rows = await this.sql<RuntimeStateDatabaseRow[]>`
            select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
            from runtime_state_store
            where store_namespace = ${namespace}
              and store_key collate "C" >= ${keyPrefix}
              and store_key collate "C" < ${prefixEnd}
            order by store_key collate "C"
        `;

        return rows.map(decodeRuntimeStateRow);
    }

    async findEntriesByKeys(
        namespace: string,
        keys: readonly string[]
    ): Promise<readonly RuntimeStateEntry[]> {
        if (keys.length === 0) {
            return [];
        }

        const rows = await this.sql<RuntimeStateDatabaseRow[]>`
            select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
            from runtime_state_store
            where store_namespace = ${namespace}
              and store_key in ${this.sql([...new Set(keys)])}
            order by store_key collate "C"
        `;

        return rows.map(decodeRuntimeStateRow);
    }

    async findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: Readonly<{
            afterKey?: string;
            limit: number;
        }>
    ): Promise<readonly RuntimeStateEntry[]> {
        const limit = Math.max(1, Math.floor(options.limit));
        if (keyPrefix.length === 0) {
            const rows = options.afterKey === undefined
                ? await this.sql<RuntimeStateDatabaseRow[]>`
                    select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
                    from runtime_state_store
                    where store_namespace = ${namespace}
                    order by store_key collate "C"
                    limit ${limit}
                `
                : await this.sql<RuntimeStateDatabaseRow[]>`
                    select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
                    from runtime_state_store
                    where store_namespace = ${namespace}
                      and store_key collate "C" > ${options.afterKey}
                    order by store_key collate "C"
                    limit ${limit}
                `;

            return rows.map(decodeRuntimeStateRow);
        }

        const prefixEnd = toExclusivePrefixEnd(keyPrefix);
        const rows = options.afterKey === undefined
            ? await this.sql<RuntimeStateDatabaseRow[]>`
                select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
                from runtime_state_store
                where store_namespace = ${namespace}
                  and store_key collate "C" >= ${keyPrefix}
                  and store_key collate "C" < ${prefixEnd}
                order by store_key collate "C"
                limit ${limit}
            `
            : await this.sql<RuntimeStateDatabaseRow[]>`
                select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
                from runtime_state_store
                where store_namespace = ${namespace}
                  and store_key collate "C" >= ${keyPrefix}
                  and store_key collate "C" < ${prefixEnd}
                  and store_key collate "C" > ${options.afterKey}
                order by store_key collate "C"
                limit ${limit}
            `;

        return rows.map(decodeRuntimeStateRow);
    }

    async upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<void> {
        await this.sql`
            insert into runtime_state_store (store_namespace,
                                             store_key,
                                             store_value,
                                             expire_at_ts,
                                             updated_ts,
                                             revision)
            values (${namespace},
                    ${key},
                    ${value},
                    ${toPgDate(expireAtTimestamp)},
                    now(),
                    0)
            on conflict (store_namespace, store_key)
                do update set store_value  = excluded.store_value,
                              expire_at_ts = excluded.expire_at_ts,
                              updated_ts   = now(),
                              revision     = runtime_state_store.revision + 1
        `;
    }

    async insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        const rows = await this.sql<Array<{ revision: number | string; }>>`
            insert into runtime_state_store (store_namespace,
                                             store_key,
                                             store_value,
                                             expire_at_ts,
                                             updated_ts,
                                             revision)
            values (${namespace},
                    ${key},
                    ${value},
                    ${toPgDate(expireAtTimestamp)},
                    now(),
                    0)
            on conflict (store_namespace, store_key) do nothing
            returning revision
        `;

        return rows[0]
            ? {
                status: 'applied',
                revision: decodeRuntimeStateRevision(rows[0].revision)
            }
            : { status: 'conflict' };
    }

    async upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        assertRuntimeStateUpsertExpectedRevision(expectedRevision);
        const rows = await this.sql<Array<{ revision: number | string; }>>`
            update runtime_state_store
            set store_value = ${value},
                expire_at_ts = ${toPgDate(expireAtTimestamp)},
                updated_ts = now(),
                revision = revision + 1
            where store_namespace = ${namespace}
              and store_key = ${key}
              and revision = ${expectedRevision}
            returning revision
        `;

        return rows[0]
            ? {
                status: 'applied',
                revision: decodeRuntimeStateRevision(rows[0].revision)
            }
            : { status: 'conflict' };
    }

    async deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        assertRuntimeStateExpectedRevision(expectedRevision);
        const rows = await this.sql<Array<{ revision: number | string; }>>`
            delete from runtime_state_store
            where store_namespace = ${namespace}
              and store_key = ${key}
              and revision = ${expectedRevision}
            returning revision
        `;

        return rows[0] ? { status: 'applied' } : { status: 'conflict' };
    }

    async deleteByKey(namespace: string, key: string): Promise<void> {
        await this.sql`
            delete
            from runtime_state_store
            where store_namespace = ${namespace}
              and store_key = ${key}
        `;
    }

    async deleteExpired(namespace: string): Promise<number> {
        const rows = await this.sql<{ store_key: string; }[]>`
            delete
            from runtime_state_store
            where store_namespace = ${namespace}
              and expire_at_ts <= now()
            returning store_key
        `;

        return rows.length;
    }

    async deleteAllExpired(
        excludedNamespaces: readonly string[] = []
    ): Promise<number> {
        const rows = excludedNamespaces.length === 0
            ? await this.sql<{ store_namespace: string; store_key: string; }[]>`
                delete
                from runtime_state_store
                where expire_at_ts <= now()
                returning store_namespace, store_key
            `
            : await this.sql<{ store_namespace: string; store_key: string; }[]>`
                delete
                from runtime_state_store
                where expire_at_ts <= now()
                  and store_namespace not in ${this.sql(excludedNamespaces)}
                returning store_namespace, store_key
            `;

        return rows.length;
    }
}

function requireSavepointSql(sql: PSqlSql): RuntimeStateSavepointSql {
    if (!isRuntimeStateSavepointSql(sql)) {
        throw new Error(
            'Runtime state transaction SQL client must provide savepoint().'
        );
    }
    return sql;
}

function isRuntimeStateSavepointSql(
    sql: PSqlSql
): sql is RuntimeStateSavepointSql {
    return 'savepoint' in sql && typeof sql.savepoint === 'function';
}
