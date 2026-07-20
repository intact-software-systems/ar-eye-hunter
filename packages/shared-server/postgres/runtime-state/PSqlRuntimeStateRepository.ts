import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import {
    assertRuntimeStateExpectedRevision,
    assertRuntimeStateUpsertExpectedRevision,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';
import type { PSqlSql, PSqlTransactionSql } from '../PostgresSqlClient.ts';

const RUNTIME_STATE_EXPIRY_EVICTION_INTERVAL_MS = 60_000;

type RuntimeStateRow = Readonly<{
    store_namespace: string;
    store_key: string;
    store_value: string;
    updated_ts: unknown;
    expire_at_ts: unknown;
    revision: number | string;
}>;

type RuntimeStateSavepointSql = PSqlTransactionSql & Readonly<{
    savepoint<T>(
        fn: (sql: PSqlTransactionSql) => Promise<T>,
    ): Promise<T>;
}>;

type RuntimeStateSqlState =
    | Readonly<{ kind: 'root'; sql: PSqlSql }>
    | Readonly<{ kind: 'transaction'; sql: RuntimeStateSavepointSql }>;

export class PSqlRuntimeStateRepository
    implements RuntimeStateOptimisticTransactionalRepositoryLike {
    private readonly sqlState: RuntimeStateSqlState;

    constructor(
        public readonly sql: PSqlSql,
        sqlState?: RuntimeStateSqlState,
    ) {
        this.sqlState = sqlState ?? {
            kind: 'root',
            sql,
        };
    }

    async begin<T>(
        fn: (
            repository: RuntimeStateOptimisticTransactionalRepositoryLike,
        ) => Promise<T>,
    ): Promise<T> {
        if (this.sqlState.kind === 'transaction') {
            return await this.sqlState.sql.savepoint(async (sql) => {
                const savepointSql = requireSavepointSql(sql);
                return await fn(new PSqlRuntimeStateRepository(savepointSql, {
                    kind: 'transaction',
                    sql: savepointSql,
                }));
            });
        }

        return await this.sqlState.sql.begin(
            async (sql: PSqlTransactionSql) => {
                const transactionSql = requireSavepointSql(sql);
                return await fn(new PSqlRuntimeStateRepository(transactionSql, {
                    kind: 'transaction',
                    sql: transactionSql,
                }));
            },
        );
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
              and store_key collate "C" >= ${keyPrefix}
              and store_key collate "C" < ${prefixEnd}
            order by store_key collate "C"
        `;

        return rows.map(toEntry);
    }

    async findEntriesByKeys(
        namespace: string,
        keys: readonly string[],
    ): Promise<readonly RuntimeStateEntry[]> {
        if (keys.length === 0) {
            return [];
        }

        const rows = await this.sql<RuntimeStateRow[]>`
            select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
            from runtime_state_store
            where store_namespace = ${namespace}
              and store_key in ${this.sql([...new Set(keys)])}
            order by store_key collate "C"
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
                    order by store_key collate "C"
                    limit ${limit}
                `
                : await this.sql<RuntimeStateRow[]>`
                    select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
                    from runtime_state_store
                    where store_namespace = ${namespace}
                      and store_key collate "C" > ${options.afterKey}
                    order by store_key collate "C"
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
                  and store_key collate "C" >= ${keyPrefix}
                  and store_key collate "C" < ${prefixEnd}
                order by store_key collate "C"
                limit ${limit}
            `
            : await this.sql<RuntimeStateRow[]>`
                select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
                from runtime_state_store
                where store_namespace = ${namespace}
                  and store_key collate "C" >= ${keyPrefix}
                  and store_key collate "C" < ${prefixEnd}
                  and store_key collate "C" > ${options.afterKey}
                order by store_key collate "C"
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

    async insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        const rows = await this.sql<Array<{ revision: number | string }>>`
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
                revision: parseRuntimeStateRevision(rows[0].revision),
            }
            : { status: 'conflict' };
    }

    async upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        assertRuntimeStateUpsertExpectedRevision(expectedRevision);
        const rows = await this.sql<Array<{ revision: number | string }>>`
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
                revision: parseRuntimeStateRevision(rows[0].revision),
            }
            : { status: 'conflict' };
    }

    async deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        assertRuntimeStateExpectedRevision(expectedRevision);
        const rows = await this.sql<Array<{ revision: number | string }>>`
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
        const rows = await this.sql<{ store_key: string }[]>`
            delete
            from runtime_state_store
            where store_namespace = ${namespace}
              and expire_at_ts <= now()
            returning store_key
        `;

        return rows.length;
    }

    async deleteAllExpired(
        excludedNamespaces: readonly string[] = [],
    ): Promise<number> {
        const rows = excludedNamespaces.length === 0
            ? await this.sql<{ store_namespace: string; store_key: string }[]>`
                delete
                from runtime_state_store
                where expire_at_ts <= now()
                returning store_namespace, store_key
            `
            : await this.sql<{ store_namespace: string; store_key: string }[]>`
                delete
                from runtime_state_store
                where expire_at_ts <= now()
                  and store_namespace not in ${this.sql(excludedNamespaces)}
                returning store_namespace, store_key
            `;

        return rows.length;
    }
}

export { PSqlRuntimeStateRepository as RuntimeStateRepository };

export async function evictExpiredRuntimeStateRows(
    repository: Pick<PSqlRuntimeStateRepository, 'deleteAllExpired'>,
    options: Readonly<{
        excludedNamespaces?: readonly string[];
    }> = {},
): Promise<number> {
    const removed = await repository.deleteAllExpired(
        options.excludedNamespaces ?? [],
    );
    if (removed > 0) {
        console.log(`Evicted expired runtime_state_store rows: ${removed}`);
    }

    return removed;
}

export async function initRuntimeStateExpiryEviction(
    repository: Pick<PSqlRuntimeStateRepository, 'deleteAllExpired'>,
    options: Readonly<{
        intervalMs?: number;
        excludedNamespaces?: readonly string[];
    }> = {},
): Promise<void> {
    await tryRunInIntervals(
        async () => {
            await evictExpiredRuntimeStateRows(repository, {
                excludedNamespaces: options.excludedNamespaces,
            });
        },
        options.intervalMs ?? RUNTIME_STATE_EXPIRY_EVICTION_INTERVAL_MS,
    );
}

function toEntry(row: RuntimeStateRow): RuntimeStateEntry {
    const expireAtTimestamp = toRuntimeStateDriverDate(
        row.expire_at_ts,
        'expire_at_ts',
    ).getTime();

    return {
        key: row.store_key,
        value: row.store_value,
        expireAtTimestamp,
        updatedTimestamp: toRuntimeStateUpdatedTimestamp(row.updated_ts),
        revision: parseRuntimeStateRevision(row.revision),
    };
}

function toRuntimeStateUpdatedTimestamp(value: unknown): string {
    return toRuntimeStateDriverDate(value, 'updated_ts').toISOString();
}

function toRuntimeStateDriverDate(value: unknown, label: string): Date {
    if (typeof value === 'string') {
        const match = RUNTIME_STATE_UPDATED_TIMESTAMP_PATTERN.exec(value);
        if (!match || !isValidTimestampMatch(match)) {
            throw new Error(`Invalid runtime state ${label} string`);
        }
        const timestamp = Date.parse(value);
        if (!Number.isFinite(timestamp)) {
            throw new Error(`Invalid runtime state ${label} string`);
        }
        return new Date(timestamp);
    }

    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return new Date(value.getTime());
    }

    throw new Error(`Invalid runtime state ${label} driver value`);
}

const RUNTIME_STATE_UPDATED_TIMESTAMP_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/u;

function isValidTimestampMatch(match: RegExpExecArray): boolean {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
        return false;
    }
    const daysInMonth = month === 2
        ? (isLeapYear(year) ? 29 : 28)
        : [4, 6, 9, 11].includes(month) ? 30 : 31;
    if (day < 1 || day > daysInMonth) return false;
    const zone = match[8];
    if (zone === 'Z') return true;
    const zoneDigits = zone.slice(1).replace(':', '');
    const zoneHour = Number(zoneDigits.slice(0, 2));
    const zoneMinute = zoneDigits.length > 2 ? Number(zoneDigits.slice(2)) : 0;
    return zoneHour <= 23 && zoneMinute <= 59;
}

function isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseRuntimeStateRevision(value: number | string): number {
    if (typeof value === 'string' && !/^(0|[1-9]\d*)$/u.test(value)) {
        throw new Error(`Invalid runtime state revision: ${value}`);
    }

    const revision = typeof value === 'number' ? value : Number(value);
    if (
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        Object.is(revision, -0)
    ) {
        throw new Error(`Invalid runtime state revision: ${value}`);
    }

    return revision;
}

function requireSavepointSql(
    sql: PSqlTransactionSql,
): RuntimeStateSavepointSql {
    const candidate = sql as PSqlTransactionSql &
        Readonly<{ savepoint?: unknown }>;
    if (typeof candidate.savepoint !== 'function') {
        throw new Error(
            'Runtime state transaction SQL client must provide savepoint().',
        );
    }

    return candidate as RuntimeStateSavepointSql;
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
