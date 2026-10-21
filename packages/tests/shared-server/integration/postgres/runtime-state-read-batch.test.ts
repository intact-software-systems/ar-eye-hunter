import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { selectRuntimeStateReadBatch } from '@shared-server/runtime-state/read-batch/select-runtime-state-read-batch.ts';
import {
    createDensePrefixSuffixReadBatchFixture,
    createPrefixSuffixReadBatchFixture
} from '@shared-test/shared-server/prefix-suffix-read-batch-fixture.ts';
import { describe, expect, it } from 'vitest';
import { createRuntimeStatePostgresSql } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const POSTGRES_INTEGRATION_ENABLED = readEnv('RALLAR_POSTGRES_INTEGRATION') === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;
const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
const FLOOR_MS = Date.parse('2030-01-01T00:00:00.000Z');

type GlobalEnv = Readonly<{
    Deno?: Readonly<{
        env: Readonly<{ get(key: string): string | undefined; }>;
    }>;
    process?: Readonly<{
        env?: Readonly<Record<string, string | undefined>>;
    }>;
}>;

describe('Postgres runtime-state read batches', () => {
    postgresIt('returns exact, prefix, and missing selections as one driver row per selected entry', async () => {
        const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
        const namespace = `read-batch-${crypto.randomUUID()}`;
        const seed = new PSqlRuntimeStateRepository(sql);

        try {
            await seed.upsert(namespace, 'prefix:b', 'prefix-b', FUTURE_MS);
            await seed.upsert(namespace, 'exact', 'exact-value', FUTURE_MS);
            await seed.upsert(namespace, 'prefix:a', 'prefix-a', FUTURE_MS);
            await seed.upsert(`${namespace}:sibling`, 'prefix:a', 'sibling', FUTURE_MS);
            const driverRowCounts: number[] = [];
            const repository = new PSqlRuntimeStateRepository(
                observeDriverRowCounts(sql, driverRowCounts)
            );

            const selections = await repository.readRuntimeStateBatch(
                createSelectors(namespace)
            );

            expect(selections.map((selection) => ({
                selectorId: selection.selectorId,
                keys: selection.entries.map((entry) => entry.key)
            }))).toEqual([{
                selectorId: 'missing',
                keys: []
            }, {
                selectorId: 'prefix',
                keys: ['prefix:a', 'prefix:b']
            }, {
                selectorId: 'exact',
                keys: ['exact']
            }]);
            expect(selections[2].entries[0]).toEqual({
                key: 'exact',
                value: 'exact-value',
                expireAtTimestamp: FUTURE_MS,
                updatedTimestamp: expect.any(String),
                revision: 0
            });
            expect(Number.isFinite(Date.parse(selections[2].entries[0].updatedTimestamp))).toBe(true);
            expect(driverRowCounts).toEqual([3]);
        }
        finally {
            await sql`
        delete from runtime_state_store
        where store_namespace in (${namespace}, ${`${namespace}:sibling`})
      `;
            await sql.end();
        }
    });

    postgresIt.each([
        ['literal prefix-suffix matches in caller order and C key order', createPrefixSuffixReadBatchFixture],
        ['a dense workspace\'s prefix-suffix matches as the in-memory selection does', createDensePrefixSuffixReadBatchFixture]
    ])('selects %s', async (_label, createFixture) => {
        const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
        const namespace = `read-batch-${crypto.randomUUID()}`;
        const fixture = createFixture(namespace);
        const repository = new PSqlRuntimeStateRepository(sql);

        try {
            for (const [index, entry] of fixture.entries.entries()) {
                await repository.upsert(entry.namespace, entry.key, `value-${index}`, FUTURE_MS);
            }

            const selections = await repository.readRuntimeStateBatch(fixture.selectors);

            expect(selections.map((selection) => ({
                selectorId: selection.selectorId,
                keys: selection.entries.map((entry) => entry.key)
            }))).toEqual(fixture.expectedSelections);
        }
        finally {
            await sql`
        delete from runtime_state_store
        where store_namespace in (${namespace}, ${`${namespace}:sibling`})
      `;
            await sql.end();
        }
    });

    postgresIt('filters a prefix range by stored-value containment and by an expiry floor inside the one statement', async () => {
        const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
        const namespace = `read-batch-${crypto.randomUUID()}`;
        const seed = new PSqlRuntimeStateRepository(sql);

        try {
            for (let index = 0; index < 40; index += 1) {
                await seed.upsert(
                    namespace,
                    `principal=alice:session=closed-${String(index).padStart(2, '0')}`,
                    JSON.stringify({ status: 'disconnected', disconnectedAtEpochMs: 2 }),
                    FUTURE_MS
                );
            }
            await seed.upsert(namespace, 'principal=alice:session=open', JSON.stringify({ status: 'active', disconnectedAtEpochMs: null }), FUTURE_MS);
            await seed.upsert(namespace, 'principal=alice:session=unset', JSON.stringify({ status: 'active' }), FUTURE_MS);
            await seed.upsert(namespace, 'principal=bob:session=open', JSON.stringify({ status: 'active', disconnectedAtEpochMs: null }), FUTURE_MS);
            await seed.upsert(namespace, 'presence:at-floor', '{}', FLOOR_MS);
            await seed.upsert(namespace, 'presence:after-floor', '{}', FLOOR_MS + 1);
            const driverRowCounts: number[] = [];
            const repository = new PSqlRuntimeStateRepository(observeDriverRowCounts(sql, driverRowCounts));

            const selections = await repository.readRuntimeStateBatch(createFilteredSelectors(namespace));

            expect(selections.map((selection) => selection.entries.map((entry) => entry.key))).toEqual([
                ['principal=alice:session=open'],
                ['presence:after-floor']
            ]);
            expect(driverRowCounts).toEqual([2]);
            const stored = (await seed.findAllEntries(namespace)).map((entry) => ({ namespace, entry }));
            expect(selectRuntimeStateReadBatch(stored, createFilteredSelectors(namespace))).toEqual(selections);
        }
        finally {
            await sql`delete from runtime_state_store where store_namespace = ${namespace}`;
            await sql.end();
        }
    });

    postgresIt('plans the containment and the expiry floor as filters on the key-range index scan', async () => {
        const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
        const namespace = `read-batch-${crypto.randomUUID()}`;
        const captured: CapturedStatement[] = [];

        try {
            await sql`
                insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts)
                select ${namespace},
                       'principal=p' || lpad(ordinal::text, 4, '0') || ':session=s',
                       '{"status":"active","disconnectedAtEpochMs":null}',
                       now() + interval '1 day'
                from generate_series(1, 2000) as ordinal
            `;
            await sql`analyze runtime_state_store`;
            await new PSqlRuntimeStateRepository(captureStatements(captured)).readRuntimeStateBatch(
                createFilteredSelectors(namespace)
            );
            const [statement] = captured;
            const plan = await sql<Readonly<{ 'QUERY PLAN': string; }>[]>(
                toExplainStrings(statement.strings),
                ...statement.values
            );
            const planText = plan.map((row) => row['QUERY PLAN']).join('\n');

            expect(planText).toMatch(
                /Index Scan using runtime_state_store_namespace_key_c_ix on runtime_state_store containing_entry\n\s*Index Cond: .*store_key.*>=.*store_key.*<.*\n\s*Filter: \(\(store_value\)::jsonb @> /u
            );
            expect(planText).toMatch(
                /Index Scan using runtime_state_store_namespace_key_c_ix on runtime_state_store expiring_entry\n\s*Index Cond: .*store_key.*>=.*store_key.*<.*\n\s*Filter: .*expire_at_ts/u
            );
        }
        finally {
            await sql`delete from runtime_state_store where store_namespace = ${namespace}`;
            await sql.end();
        }
    });
});

function createFilteredSelectors(namespace: string): readonly RuntimeStateReadBatchSelector[] {
    return [{
        selectorId: 'live-sessions',
        kind: 'prefix-containing',
        namespace,
        keyPrefix: 'principal=alice:',
        storedValueContains: { status: 'active', disconnectedAtEpochMs: null }
    }, {
        selectorId: 'unpurged-presence',
        kind: 'prefix-expiring-after',
        namespace,
        keyPrefix: 'presence:',
        expiringAfterTimestamp: FLOOR_MS
    }];
}

type CapturedStatement = Readonly<{
    strings: TemplateStringsArray;
    values: readonly PSqlParameter[];
}>;

function captureStatements(captured: CapturedStatement[]): PSqlSql {
    const capturing = function (
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: PSqlParameter[]
    ): Promise<PSqlRows> | object {
        if (!isTemplateStringsArray(stringsOrValues)) {
            return {};
        }
        captured.push({ strings: stringsOrValues, values });
        return Promise.resolve([]);
    } as PSqlSql;
    capturing.begin = async () => {
        throw new Error('The captured read batch runs no transaction');
    };
    return capturing;
}

function toExplainStrings(strings: TemplateStringsArray): TemplateStringsArray {
    const explained = [`explain (costs off) ${strings[0]}`, ...strings.slice(1)];
    return Object.assign(explained, { raw: explained });
}

function createSelectors(
    namespace: string
): readonly RuntimeStateReadBatchSelector[] {
    return [{
        selectorId: 'missing',
        kind: 'key',
        namespace,
        key: 'missing'
    }, {
        selectorId: 'prefix',
        kind: 'prefix',
        namespace,
        keyPrefix: 'prefix:'
    }, {
        selectorId: 'exact',
        kind: 'key',
        namespace,
        key: 'exact'
    }];
}

function observeDriverRowCounts(
    sql: PSqlSql,
    rowCounts: number[]
): PSqlSql {
    const observed = function<Rows extends PSqlRows> (
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: PSqlParameter[]
    ): Promise<Rows> | object {
        if (!isTemplateStringsArray(stringsOrValues)) {
            return sql(stringsOrValues);
        }
        return Promise.resolve(sql<Rows>(stringsOrValues, ...values)).then((result) => {
            rowCounts.push(Array.isArray(result) ? result.length : -1);
            return result;
        });
    } as PSqlSql;
    observed.begin = sql.begin.bind(sql);
    return observed;
}

function isTemplateStringsArray(
    value: TemplateStringsArray | readonly PSqlParameter[]
): value is TemplateStringsArray {
    return Array.isArray(value) && Object.hasOwn(value, 'raw');
}

function requireDatabaseUrl(): string {
    const databaseUrl = readEnv('DATABASE_URL');
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1');
    }
    return databaseUrl;
}

function readEnv(name: string): string | undefined {
    const globals = globalThis as GlobalEnv;
    return globals.Deno?.env.get(name) ?? globals.process?.env?.[name];
}
