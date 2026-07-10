import type {
    RuntimeStateEntry,
    RuntimeStateTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';
import type { PSqlSql, PSqlTransactionSql } from '../PostgresSqlClient.ts';

const RUNTIME_STATE_EXPIRY_EVICTION_INTERVAL_MS = 60_000;

type RuntimeStateRow = Readonly<{
    store_namespace: string;
    store_key: string;
    store_value: string;
    updated_ts: string;
    expire_at_ts: string;
    revision: number | string;
}>;

export class PSqlRuntimeStateRepository implements RuntimeStateTransactionalRepositoryLike {
    constructor(public readonly sql: PSqlSql) {}

    async begin<T>(
        fn: (repository: RuntimeStateTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        return (await this.sql.begin(
            async (sql: PSqlTransactionSql) =>
                await fn(new PSqlRuntimeStateRepository(sql)),
        )) as T;
    }

    async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        const rows = await this.sql<RuntimeStateRow[]>`
            select store_value, store_namespace, store_key, updated_ts, expire_at_ts, revision
            from runtime_state_store
            where store_namespace = ${namespace}
              and store_key = ${key}
            limit 1
        `;

        return rows[0] ? toEntry(rows[0]) : undefined;
    }

    async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        const rows = await this.sql<RuntimeStateRow[]>`
            select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
            from runtime_state_store
            where store_namespace = ${namespace}
            order by store_key
        `;

        return rows.map(toEntry);
    }

    async findEntriesByPrefix(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        if (keyPrefix.length === 0) {
            return await this.findAllEntries(namespace);
        }

        const prefixEnd = toExclusivePrefixEnd(keyPrefix);
        const rows = await this.sql<RuntimeStateRow[]>`
            select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
            from runtime_state_store
            where store_namespace = ${namespace}
              and store_key >= ${keyPrefix}
              and store_key < ${prefixEnd}
            order by store_key
        `;

        return rows.map(toEntry);
    }

    async findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: Readonly<{
            afterKey?: string;
            limit: number;
        }>,
    ): Promise<readonly RuntimeStateEntry[]> {
        const limit = Math.max(1, Math.floor(options.limit));
        if (keyPrefix.length === 0) {
            const rows = options.afterKey === undefined
                ? await this.sql<RuntimeStateRow[]>`
                    select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
                    from runtime_state_store
                    where store_namespace = ${namespace}
                    order by store_key
                    limit ${limit}
                `
                : await this.sql<RuntimeStateRow[]>`
                    select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
                    from runtime_state_store
                    where store_namespace = ${namespace}
                      and store_key > ${options.afterKey}
                    order by store_key
                    limit ${limit}
                `;

            return rows.map(toEntry);
        }

        const prefixEnd = toExclusivePrefixEnd(keyPrefix);
        const rows = options.afterKey === undefined
            ? await this.sql<RuntimeStateRow[]>`
                select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
                from runtime_state_store
                where store_namespace = ${namespace}
                  and store_key >= ${keyPrefix}
                  and store_key < ${prefixEnd}
                order by store_key
                limit ${limit}
            `
            : await this.sql<RuntimeStateRow[]>`
                select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
                from runtime_state_store
                where store_namespace = ${namespace}
                  and store_key >= ${keyPrefix}
                  and store_key < ${prefixEnd}
                  and store_key > ${options.afterKey}
                order by store_key
                limit ${limit}
            `;

        return rows.map(toEntry);
    }

    async lockKey(namespace: string, key: string): Promise<void> {
        await this.sql`
            select pg_advisory_xact_lock(hashtextextended(${`${namespace}:${key}`}, 0))
        `;
    }

    async upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
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

    async deleteByKey(namespace: string, key: string): Promise<void> {
        await this.sql`
            delete
            from runtime_state_store
            where store_namespace = ${namespace}
              and store_key = ${key}
        `;
    }

    async deleteExpired(namespace: string): Promise<number> {
        const rows = await this.sql<{ store_key: string }[]>`
            delete
            from runtime_state_store
            where store_namespace = ${namespace}
              and expire_at_ts <= now()
            returning store_key
        `;

        return rows.length;
    }

    async deleteAllExpired(): Promise<number> {
        const rows = await this.sql<{ store_namespace: string; store_key: string }[]>`
            delete
            from runtime_state_store
            where expire_at_ts <= now()
            returning store_namespace, store_key
        `;

        return rows.length;
    }
}

export { PSqlRuntimeStateRepository as RuntimeStateRepository };

export async function evictExpiredRuntimeStateRows(
    repository: Pick<PSqlRuntimeStateRepository, 'deleteAllExpired'>,
): Promise<number> {
    const removed = await repository.deleteAllExpired();
    if (removed > 0) {
        console.log(`Evicted expired runtime_state_store rows: ${removed}`);
    }

    return removed;
}

export async function initRuntimeStateExpiryEviction(
    repository: Pick<PSqlRuntimeStateRepository, 'deleteAllExpired'>,
    intervalMs: number = RUNTIME_STATE_EXPIRY_EVICTION_INTERVAL_MS,
): Promise<void> {
    await tryRunInIntervals(
        async () => {
            await evictExpiredRuntimeStateRows(repository);
        },
        intervalMs,
    );
}

function toEntry(row: RuntimeStateRow): RuntimeStateEntry {
    const expireAtTimestamp = Date.parse(row.expire_at_ts);
    if (!Number.isFinite(expireAtTimestamp)) {
        throw new Error(
            `Invalid expire_at_ts for runtime_state_store row ${row.store_namespace}/${row.store_key}`,
        );
    }

    return {
        key: row.store_key,
        value: row.store_value,
        expireAtTimestamp,
        updatedTimestamp: row.updated_ts,
        revision: Number(row.revision),
    };
}

function toExclusivePrefixEnd(prefix: string): string {
    if (prefix.length === 0) {
        throw new Error('Runtime state prefix must not be empty.');
    }

    const lastIndex = prefix.length - 1;
    const lastCode = prefix.charCodeAt(lastIndex);
    if (lastCode >= 0xffff) {
        throw new Error(`Runtime state prefix has no safe upper bound: ${prefix}`);
    }
    return `${prefix.slice(0, lastIndex)}${String.fromCharCode(lastCode + 1)}`;
}

function toPgDate(timestamp: number): Date {
    if (!Number.isFinite(timestamp)) {
        throw new Error('expireAtTimestamp must be a finite number');
    }

    return new Date(timestamp);
}
