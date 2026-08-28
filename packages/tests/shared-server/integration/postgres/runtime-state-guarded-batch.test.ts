import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { describe, expect, it } from 'vitest';
import { createRuntimeStatePostgresSql } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const POSTGRES_INTEGRATION_ENABLED = readEnv('RALLAR_POSTGRES_INTEGRATION') === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;
const FUTURE_MS = Date.parse('2100-01-02T03:04:05.678Z');

type GlobalEnv = Readonly<{
    Deno?: Readonly<{
        env: Readonly<{
            get(key: string): string | undefined;
        }>;
    }>;
    process?: Readonly<{
        env?: Readonly<Record<string, string | undefined>>;
    }>;
}>;

describe('Postgres runtime-state guarded batches', () => {
    postgresIt(
        'executes a non-empty guarded batch through postgres.js',
        async () => {
            const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
            const repository = new PSqlRuntimeStateRepository(sql);
            const namespace = `guarded-batch-${crypto.randomUUID()}`;

            try {
                const result = await repository.begin(async (transactionRepository) => {
                    return await transactionRepository.executeGuardedBatch({
                        guard: {
                            operation: 'insert',
                            namespace,
                            key: 'guard',
                            value: 'guard-value',
                            expireAtTimestamp: FUTURE_MS
                        },
                        effects: [
                            {
                                effectId: 'insert-effect',
                                operation: 'insert',
                                namespace,
                                key: 'effect',
                                value: 'effect-value',
                                expireAtTimestamp: FUTURE_MS
                            }
                        ]
                    });
                });

                expect(result).toEqual({
                    guard: {
                        status: 'applied',
                        operation: 'insert',
                        namespace,
                        key: 'guard',
                        resultingRevision: 0
                    },
                    effects: [
                        {
                            status: 'applied',
                            effectId: 'insert-effect',
                            operation: 'insert',
                            namespace,
                            key: 'effect',
                            resultingRevision: 0
                        }
                    ]
                });
            }
            finally {
                await sql`
                delete from runtime_state_store
                where store_namespace = ${namespace}
            `;
                await sql.end();
            }
        }
    );
    // Product decision 36 asks `reset` to clear the series in one transaction:
    // the group row and both layout tombstones commit together or not at all.
    // The batch does not roll itself back — a conflicting effect is reported,
    // not thrown — so the all-or-nothing property lives in the caller's
    // rejection, which is what `writeGroupMutation` does for every effect that
    // is not applied. This proves that contract against a real transaction;
    // the in-memory fake applies effects in sequence and cannot show it.
    postgresIt(
        'rolls the whole batch back when the caller rejects a conflicting effect',
        async () => {
            const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
            const repository = new PSqlRuntimeStateRepository(sql);
            const namespace = `guarded-batch-rollback-${crypto.randomUUID()}`;

            try {
                const conflicts = await repository.begin(async (transactionRepository) => {
                    const result = await transactionRepository.executeGuardedBatch({
                        guard: {
                            operation: 'insert',
                            namespace,
                            key: 'guard',
                            value: 'guard-value',
                            expireAtTimestamp: FUTURE_MS
                        },
                        effects: [
                            {
                                effectId: 'first-effect',
                                operation: 'insert',
                                namespace,
                                key: 'first',
                                value: 'first-value',
                                expireAtTimestamp: FUTURE_MS
                            },
                            {
                                // No row exists at this revision, so the second
                                // effect must conflict after the first applied.
                                effectId: 'conflicting-effect',
                                operation: 'update',
                                namespace,
                                key: 'second',
                                value: 'second-value',
                                expectedRevision: 7,
                                expireAtTimestamp: FUTURE_MS
                            }
                        ]
                    });
                    // What `writeGroupMutation` does with the same result.
                    if (result.effects.some((effect) => effect.status !== 'applied')) {
                        throw new RuntimeStateWriteConflictError();
                    }
                    return false;
                }).catch((error: unknown) => error instanceof RuntimeStateWriteConflictError);

                expect(conflicts).toBe(true);
                // Nothing survives the rejection: not the guard, and not the
                // effect that had already applied when the conflict was found.
                await expect(repository.findEntry(namespace, 'guard')).resolves.toBeUndefined();
                await expect(repository.findEntry(namespace, 'first')).resolves.toBeUndefined();
            }
            finally {
                await sql.end();
            }
        }
    );
});

function requireDatabaseUrl(): string {
    const databaseUrl = readEnv('DATABASE_URL');
    if (!databaseUrl) {
        throw new Error(
            'DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1'
        );
    }
    return databaseUrl;
}

function readEnv(key: string): string | undefined {
    const globals = globalThis as GlobalEnv;
    return globals.Deno?.env.get(key) ?? globals.process?.env?.[key];
}
