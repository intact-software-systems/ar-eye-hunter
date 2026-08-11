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
import type {
    RuntimeStateGuardedBatch,
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchEffectResult,
    RuntimeStateGuardedBatchGuardResult,
    RuntimeStateGuardedBatchResult,
} from '@shared-server/runtime-state/RuntimeStateGuardedBatch.ts';
import {
    validateRuntimeStateGuardedBatch,
    validateRuntimeStateGuardedBatchResult,
} from '@shared-server/runtime-state/RuntimeStateGuardedBatch.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector,
} from '@shared-server/runtime-state/RuntimeStateReadBatch.ts';
import type { PSqlSql, PSqlTransactionSql } from '../PostgresSqlClient.ts';
import { readPSqlRuntimeStateBatch } from './PSqlRuntimeStateReadBatch.ts';
import {
    toExclusivePrefixEnd,
    toPgDate,
} from './PSqlRuntimeStateSqlValues.ts';

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

type RuntimeStateGuardedBatchRow = Readonly<{
    result_kind: unknown;
    effect_id: unknown;
    operation: unknown;
    store_namespace: unknown;
    store_key: unknown;
    revision: unknown;
}>;

export class PSqlRuntimeStateRepository
    implements RuntimeStateOptimisticTransactionalRepositoryLike {
    private readonly sqlState: RuntimeStateSqlState;

    public readonly sql: PSqlSql;

    constructor(
        sql: PSqlSql,
        sqlState?: RuntimeStateSqlState,
    ) {
        this.sql = sql;
        this.sqlState = sqlState ?? {
            kind: 'root',
            sql,
        };
    }

    get runtimeStateGuardedBatchCapability(): boolean {
        return this.sqlState.kind === 'transaction';
    }

    readonly runtimeStateReadBatchCapability = true as const;
    readonly runtimeStateReadBatchConsistency = 'single-database-snapshot' as const;

    async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[],
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        return await readPSqlRuntimeStateBatch(this.sql, selectors);
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

    async executeGuardedBatch(
        input: RuntimeStateGuardedBatch,
    ): Promise<RuntimeStateGuardedBatchResult> {
        const batch = validateRuntimeStateGuardedBatch(input);
        if (this.sqlState.kind !== 'transaction') {
            throw new Error(
                'Guarded runtime state batches require a transaction-scoped repository.',
            );
        }

        const rows = await this.sql<RuntimeStateGuardedBatchRow[]>`
            with guard_input as (
                select descriptor ->> 'operation' as operation,
                       descriptor ->> 'namespace' as store_namespace,
                       descriptor ->> 'key' as store_key,
                       descriptor ->> 'value' as store_value,
                       (descriptor ->> 'expireAtTimestamp')::timestamptz as expire_at_ts,
                       (descriptor ->> 'expectedRevision')::bigint as expected_revision
                from (select ${toRuntimeStateGuardedBatchSqlInput(batch.guard)}::jsonb as descriptor) guard_json
            ),
            effect_input as (
                select descriptor ->> 'effectId' as effect_id,
                       descriptor ->> 'operation' as operation,
                       descriptor ->> 'namespace' as store_namespace,
                       descriptor ->> 'key' as store_key,
                       descriptor ->> 'value' as store_value,
                       (descriptor ->> 'expireAtTimestamp')::timestamptz as expire_at_ts,
                       (descriptor ->> 'expectedRevision')::bigint as expected_revision
                from jsonb_array_elements(${batch.effects.map(toRuntimeStateGuardedBatchSqlInput)}::jsonb) descriptor
            ),
            guard_insert as (
                insert into runtime_state_store (store_namespace,
                                                 store_key,
                                                 store_value,
                                                 expire_at_ts,
                                                 updated_ts,
                                                 revision)
                select store_namespace,
                       store_key,
                       store_value,
                       expire_at_ts,
                       now(),
                       0
                from guard_input
                where operation = 'insert'
                on conflict (store_namespace, store_key) do nothing
                returning 'insert'::text as operation,
                          store_namespace,
                          store_key,
                          revision
            ),
            guard_update as (
                update runtime_state_store target
                set store_value = descriptor.store_value,
                    expire_at_ts = descriptor.expire_at_ts,
                    updated_ts = now(),
                    revision = target.revision + 1
                from guard_input descriptor
                where descriptor.operation = 'update'
                  and target.store_namespace = descriptor.store_namespace
                  and target.store_key = descriptor.store_key
                  and target.revision = descriptor.expected_revision
                returning 'update'::text as operation,
                          target.store_namespace,
                          target.store_key,
                          target.revision
            ),
            guard_delete as (
                delete from runtime_state_store target
                using guard_input descriptor
                where descriptor.operation = 'delete'
                  and target.store_namespace = descriptor.store_namespace
                  and target.store_key = descriptor.store_key
                  and target.revision = descriptor.expected_revision
                returning 'delete'::text as operation,
                          target.store_namespace,
                          target.store_key,
                          target.revision
            ),
            authority as (
                select operation, store_namespace, store_key, revision
                from guard_insert
                union all
                select operation, store_namespace, store_key, revision
                from guard_update
                union all
                select operation, store_namespace, store_key, revision
                from guard_delete
            ),
            effect_insert as (
                insert into runtime_state_store (store_namespace,
                                                 store_key,
                                                 store_value,
                                                 expire_at_ts,
                                                 updated_ts,
                                                 revision)
                select descriptor.store_namespace,
                       descriptor.store_key,
                       descriptor.store_value,
                       descriptor.expire_at_ts,
                       now(),
                       0
                from effect_input descriptor
                cross join authority
                where descriptor.operation = 'insert'
                on conflict (store_namespace, store_key) do nothing
                returning store_namespace, store_key, revision
            ),
            effect_update as (
                update runtime_state_store target
                set store_value = descriptor.store_value,
                    expire_at_ts = descriptor.expire_at_ts,
                    updated_ts = now(),
                    revision = target.revision + 1
                from effect_input descriptor
                cross join authority
                where descriptor.operation = 'update'
                  and target.store_namespace = descriptor.store_namespace
                  and target.store_key = descriptor.store_key
                  and target.revision = descriptor.expected_revision
                returning target.store_namespace,
                          target.store_key,
                          target.revision
            ),
            effect_delete as (
                delete from runtime_state_store target
                using effect_input descriptor, authority
                where descriptor.operation = 'delete'
                  and target.store_namespace = descriptor.store_namespace
                  and target.store_key = descriptor.store_key
                  and target.revision = descriptor.expected_revision
                returning target.store_namespace,
                          target.store_key,
                          target.revision
            ),
            effect_put as (
                insert into runtime_state_store (store_namespace,
                                                 store_key,
                                                 store_value,
                                                 expire_at_ts,
                                                 updated_ts,
                                                 revision)
                select descriptor.store_namespace,
                       descriptor.store_key,
                       descriptor.store_value,
                       descriptor.expire_at_ts,
                       now(),
                       0
                from effect_input descriptor
                cross join authority
                where descriptor.operation = 'put'
                on conflict (store_namespace, store_key)
                    do update set store_value = excluded.store_value,
                                  expire_at_ts = excluded.expire_at_ts,
                                  updated_ts = now(),
                                  revision = runtime_state_store.revision + 1
                returning store_namespace, store_key, revision
            ),
            effect_insert_result as (
                select descriptor.effect_id,
                       descriptor.operation,
                       mutation.store_namespace,
                       mutation.store_key,
                       mutation.revision
                from effect_insert mutation
                join effect_input descriptor
                  on descriptor.store_namespace = mutation.store_namespace
                 and descriptor.store_key = mutation.store_key
                 and descriptor.operation = 'insert'
            ),
            effect_update_result as (
                select descriptor.effect_id,
                       descriptor.operation,
                       mutation.store_namespace,
                       mutation.store_key,
                       mutation.revision
                from effect_update mutation
                join effect_input descriptor
                  on descriptor.store_namespace = mutation.store_namespace
                 and descriptor.store_key = mutation.store_key
                 and descriptor.operation = 'update'
            ),
            effect_delete_result as (
                select descriptor.effect_id,
                       descriptor.operation,
                       mutation.store_namespace,
                       mutation.store_key,
                       mutation.revision
                from effect_delete mutation
                join effect_input descriptor
                  on descriptor.store_namespace = mutation.store_namespace
                 and descriptor.store_key = mutation.store_key
                 and descriptor.operation = 'delete'
            ),
            effect_put_result as (
                select descriptor.effect_id,
                       descriptor.operation,
                       mutation.store_namespace,
                       mutation.store_key,
                       mutation.revision
                from effect_put mutation
                join effect_input descriptor
                  on descriptor.store_namespace = mutation.store_namespace
                 and descriptor.store_key = mutation.store_key
                 and descriptor.operation = 'put'
            )
            select 'guard'::text as result_kind,
                   null::text as effect_id,
                   operation,
                   store_namespace,
                   store_key,
                   revision
            from authority
            union all
            select 'effect'::text as result_kind,
                   effect_id,
                   operation,
                   store_namespace,
                   store_key,
                   revision
            from effect_insert_result
            union all
            select 'effect'::text as result_kind,
                   effect_id,
                   operation,
                   store_namespace,
                   store_key,
                   revision
            from effect_update_result
            union all
            select 'effect'::text as result_kind,
                   effect_id,
                   operation,
                   store_namespace,
                   store_key,
                   revision
            from effect_delete_result
            union all
            select 'effect'::text as result_kind,
                   effect_id,
                   operation,
                   store_namespace,
                   store_key,
                   revision
            from effect_put_result
        `;

        return toRuntimeStateGuardedBatchResult(batch, rows);
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

export type RuntimeStateExpiryEvictionHandle = Readonly<{
    firstRun: Promise<number>;
    stop(): void;
}>;

export type RuntimeStateExpiryEvictionOptions = Readonly<{
    intervalMs?: number;
    excludedNamespaces?: readonly string[];
    retryIntervalMs?: number;
    schedule?: (
        callback: () => void | Promise<void>,
        delayMs: number,
    ) => unknown;
    cancel?: (handle: unknown) => void;
    onError?: (error: unknown) => void;
}>;

export function initRuntimeStateExpiryEviction(
    repository: Pick<PSqlRuntimeStateRepository, 'deleteAllExpired'>,
    intervalMs?: number,
): RuntimeStateExpiryEvictionHandle;
export function initRuntimeStateExpiryEviction(
    repository: Pick<PSqlRuntimeStateRepository, 'deleteAllExpired'>,
    options?: RuntimeStateExpiryEvictionOptions,
): RuntimeStateExpiryEvictionHandle;
export function initRuntimeStateExpiryEviction(
    repository: Pick<PSqlRuntimeStateRepository, 'deleteAllExpired'>,
    options?: RuntimeStateExpiryEvictionOptions | number,
): RuntimeStateExpiryEvictionHandle;
export function initRuntimeStateExpiryEviction(
    repository: Pick<PSqlRuntimeStateRepository, 'deleteAllExpired'>,
    optionsOrInterval: RuntimeStateExpiryEvictionOptions | number = {},
): RuntimeStateExpiryEvictionHandle {
    const options = typeof optionsOrInterval === 'number'
        ? { intervalMs: optionsOrInterval }
        : optionsOrInterval;
    const intervalMs = options.intervalMs ??
        RUNTIME_STATE_EXPIRY_EVICTION_INTERVAL_MS;
    const retryIntervalMs = options.retryIntervalMs ?? 10_000;
    validateExpiryWorkerDelay(intervalMs, 'interval');
    validateExpiryWorkerDelay(retryIntervalMs, 'retry interval');
    const schedule = options.schedule ?? ((callback, delayMs) => {
        const handle = setTimeout(() => void callback(), delayMs);
        (handle as { unref?: () => void }).unref?.();
        return handle;
    });
    const cancel = options.cancel ?? ((handle: unknown) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
    let stopped = false;
    let running = false;
    let scheduledHandle: unknown;
    let failureCount = 0;
    let firstRunSettled = false;
    let resolveFirstRun!: (removed: number) => void;
    let rejectFirstRun!: (error: unknown) => void;
    const firstRun = new Promise<number>((resolve, reject) => {
        resolveFirstRun = resolve;
        rejectFirstRun = reject;
    });
    const scheduleRun = (delayMs: number): void => {
        if (stopped) return;
        let handle: unknown;
        handle = schedule(async () => {
            if (scheduledHandle === handle) scheduledHandle = undefined;
            await run();
        }, delayMs);
        scheduledHandle = handle;
        (handle as { unref?: () => void }).unref?.();
    };
    const run = async (): Promise<void> => {
        if (stopped || running) return;
        running = true;
        let failed = false;
        try {
            const removed = await evictExpiredRuntimeStateRows(repository, {
                excludedNamespaces: options.excludedNamespaces,
            });
            failureCount = 0;
            if (!firstRunSettled) {
                firstRunSettled = true;
                resolveFirstRun(removed);
            }
        } catch (error) {
            failed = true;
            failureCount += 1;
            if (!firstRunSettled) {
                firstRunSettled = true;
                rejectFirstRun(error);
            }
            try {
                options.onError?.(error);
            } catch {
                // Observability must not disable generic expiry ownership.
            }
        } finally {
            running = false;
            if (stopped) return;
            scheduleRun(failed
                ? Math.min(
                    retryIntervalMs * 2 ** Math.min(failureCount - 1, 1),
                    20_000,
                )
                : intervalMs);
        }
    };
    void run();
    return {
        firstRun,
        stop: () => {
            if (stopped) return;
            stopped = true;
            if (scheduledHandle !== undefined) {
                cancel(scheduledHandle);
                scheduledHandle = undefined;
            }
        },
    };
}

function validateExpiryWorkerDelay(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`Runtime state expiry ${label} is invalid`);
    }
}

function toRuntimeStateGuardedBatchResult(
    batch: RuntimeStateGuardedBatch,
    rows: readonly RuntimeStateGuardedBatchRow[],
): RuntimeStateGuardedBatchResult {
    requireDenseGuardedBatchRows(rows);
    let guardRow: ParsedRuntimeStateGuardedBatchRow | undefined;
    const effectRows = new Map<string, ParsedRuntimeStateGuardedBatchRow>();
    for (const inputRow of rows) {
        const row = parseRuntimeStateGuardedBatchRow(inputRow);
        if (row.resultKind === 'guard') {
            if (row.effectId !== null || guardRow !== undefined) {
                throw invalidGuardedBatchDatabaseResult(
                    'expected exactly one unique guard row',
                );
            }
            guardRow = row;
            continue;
        }
        if (row.effectId === null || effectRows.has(row.effectId)) {
            throw invalidGuardedBatchDatabaseResult(
                'effect rows require unique effect IDs',
            );
        }
        effectRows.set(row.effectId, row);
    }

    if (guardRow === undefined) {
        if (effectRows.size > 0) {
            throw invalidGuardedBatchDatabaseResult(
                'effects applied without guard authority',
            );
        }
        return validateRuntimeStateGuardedBatchResult(batch, {
            guard: {
                status: 'conflict',
                operation: batch.guard.operation,
                namespace: batch.guard.namespace,
                key: batch.guard.key,
                reason: 'condition-not-met',
            },
            effects: batch.effects.map((effect) => ({
                status: 'skipped',
                effectId: effect.effectId,
                operation: effect.operation,
                namespace: effect.namespace,
                key: effect.key,
                reason: 'guard-conflict',
            })),
        });
    }

    const guardResult = toAppliedGuardedBatchGuardResult(batch, guardRow);
    const effects = batch.effects.map((effect) => {
        const row = effectRows.get(effect.effectId);
        if (row === undefined) {
            if (effect.operation === 'put') {
                throw invalidGuardedBatchDatabaseResult(
                    `put effect did not return a row: ${effect.effectId}`,
                );
            }
            return {
                status: 'conflict',
                effectId: effect.effectId,
                operation: effect.operation,
                namespace: effect.namespace,
                key: effect.key,
                reason: 'condition-not-met',
            } as const;
        }
        effectRows.delete(effect.effectId);
        return toAppliedGuardedBatchEffectResult(effect, row);
    });
    if (effectRows.size > 0) {
        throw invalidGuardedBatchDatabaseResult('received an unexpected effect row');
    }

    return validateRuntimeStateGuardedBatchResult(batch, {
        guard: guardResult,
        effects,
    });
}

function toRuntimeStateGuardedBatchSqlInput(
    input: RuntimeStateGuardedBatch['guard'] | RuntimeStateGuardedBatchEffect,
): Readonly<Record<string, unknown>> {
    return 'expireAtTimestamp' in input
        ? {
            ...input,
            expireAtTimestamp: new Date(input.expireAtTimestamp).toISOString(),
        }
        : { ...input };
}

type ParsedRuntimeStateGuardedBatchRow = Readonly<{
    resultKind: 'guard' | 'effect';
    effectId: string | null;
    operation: 'insert' | 'update' | 'delete' | 'put';
    namespace: string;
    key: string;
    revision: number;
}>;

function parseRuntimeStateGuardedBatchRow(
    row: RuntimeStateGuardedBatchRow,
): ParsedRuntimeStateGuardedBatchRow {
    const resultKind = row.result_kind;
    if (resultKind !== 'guard' && resultKind !== 'effect') {
        throw invalidGuardedBatchDatabaseResult('result kind is invalid');
    }
    const effectId = row.effect_id;
    if (effectId !== null && (typeof effectId !== 'string' || effectId.length === 0)) {
        throw invalidGuardedBatchDatabaseResult('effect ID is invalid');
    }
    const operation = row.operation;
    if (
        operation !== 'insert' &&
        operation !== 'update' &&
        operation !== 'delete' &&
        operation !== 'put'
    ) {
        throw invalidGuardedBatchDatabaseResult('operation is invalid');
    }
    if (typeof row.store_namespace !== 'string' || row.store_namespace.length === 0) {
        throw invalidGuardedBatchDatabaseResult('namespace is invalid');
    }
    if (typeof row.store_key !== 'string' || row.store_key.length === 0) {
        throw invalidGuardedBatchDatabaseResult('key is invalid');
    }
    if (typeof row.revision !== 'number' && typeof row.revision !== 'string') {
        throw invalidGuardedBatchDatabaseResult('revision is invalid');
    }

    return {
        resultKind,
        effectId,
        operation,
        namespace: row.store_namespace,
        key: row.store_key,
        revision: parseRuntimeStateRevision(row.revision),
    };
}

function toAppliedGuardedBatchGuardResult(
    batch: RuntimeStateGuardedBatch,
    row: ParsedRuntimeStateGuardedBatchRow,
): RuntimeStateGuardedBatchGuardResult {
    requireGuardedBatchRowMatch(batch.guard, row, 'guard');
    return batch.guard.operation === 'delete'
        ? {
            status: 'applied',
            operation: batch.guard.operation,
            namespace: batch.guard.namespace,
            key: batch.guard.key,
            matchedRevision: row.revision,
        }
        : {
            status: 'applied',
            operation: batch.guard.operation,
            namespace: batch.guard.namespace,
            key: batch.guard.key,
            resultingRevision: row.revision,
        };
}

function toAppliedGuardedBatchEffectResult(
    effect: RuntimeStateGuardedBatchEffect,
    row: ParsedRuntimeStateGuardedBatchRow,
): RuntimeStateGuardedBatchEffectResult {
    requireGuardedBatchRowMatch(effect, row, `effect ${effect.effectId}`);
    if (row.effectId !== effect.effectId) {
        throw invalidGuardedBatchDatabaseResult(
            `effect ID does not match: ${effect.effectId}`,
        );
    }
    return effect.operation === 'delete'
        ? {
            status: 'applied',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            matchedRevision: row.revision,
        }
        : {
            status: 'applied',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            resultingRevision: row.revision,
        };
}

function requireGuardedBatchRowMatch(
    expected: Readonly<{
        operation: string;
        namespace: string;
        key: string;
    }>,
    row: ParsedRuntimeStateGuardedBatchRow,
    label: string,
): void {
    if (
        row.operation !== expected.operation ||
        row.namespace !== expected.namespace ||
        row.key !== expected.key
    ) {
        throw invalidGuardedBatchDatabaseResult(
            `${label} operation or identity does not match`,
        );
    }
}

function requireDenseGuardedBatchRows(
    rows: readonly RuntimeStateGuardedBatchRow[],
): void {
    if (!Array.isArray(rows)) {
        throw invalidGuardedBatchDatabaseResult('rows must be an array');
    }
    for (let index = 0; index < rows.length; index += 1) {
        if (!Object.hasOwn(rows, index)) {
            throw invalidGuardedBatchDatabaseResult('rows must be dense');
        }
    }
}

function invalidGuardedBatchDatabaseResult(reason: string): Error {
    return new Error(`Invalid runtime state guarded batch database result: ${reason}`);
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
