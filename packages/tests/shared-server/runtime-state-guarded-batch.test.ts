import { describe, expect, it } from 'vitest';
import type {
    PSqlSql,
    PSqlTransactionSql,
} from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
    isRuntimeStateGuardedBatchRepositoryLike,
    type RuntimeStateGuardedBatch,
    type RuntimeStateGuardedBatchResult,
    validateRuntimeStateGuardedBatch,
    validateRuntimeStateGuardedBatchResult,
} from '@shared-server/runtime-state/RuntimeStateGuardedBatch.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');

describe('runtime-state guarded batches', () => {
    it('accepts dense mandatory descriptors at operation-specific revision bounds', () => {
        const batch = createBatch();

        expect(validateRuntimeStateGuardedBatch(batch)).toEqual(batch);
        expect(validateRuntimeStateGuardedBatch({
            guard: {
                operation: 'delete',
                namespace: 'guard',
                key: 'delete',
                expectedRevision: Number.MAX_SAFE_INTEGER,
            },
            effects: [{
                effectId: 'maximum-update',
                operation: 'update',
                namespace: 'effect',
                key: 'maximum-update',
                expectedRevision: Number.MAX_SAFE_INTEGER - 1,
                value: 'updated',
                expireAtTimestamp: FUTURE_MS,
            }],
        })).toBeDefined();
    });

    it.each([
        ['put guard', {
            guard: {
                operation: 'put',
                namespace: 'guard',
                key: 'root',
                value: 'root',
                expireAtTimestamp: FUTURE_MS,
            },
            effects: [createInsertEffect('effect', 'one')],
        }],
        ['empty effects', {
            guard: createInsertGuard(),
            effects: [],
        }],
        ['non-array effects', {
            guard: createInsertGuard(),
            effects: {},
        }],
        ['duplicate effect IDs', {
            guard: createInsertGuard(),
            effects: [
                createInsertEffect('duplicate', 'one'),
                createInsertEffect('duplicate', 'two'),
            ],
        }],
        ['duplicate identities', {
            guard: createInsertGuard(),
            effects: [{
                ...createInsertEffect('duplicate-identity', 'root'),
                namespace: 'guard',
            }],
        }],
        ['unknown operation', {
            guard: createInsertGuard(),
            effects: [{
                effectId: 'unknown',
                operation: 'merge',
                namespace: 'effect',
                key: 'unknown',
                value: 'value',
                expireAtTimestamp: FUTURE_MS,
            }],
        }],
    ])('rejects %s before SQL', (_label, input) => {
        expect(() => validateRuntimeStateGuardedBatch(input)).toThrow(
            /runtime state guarded batch/iu,
        );
    });

    it('rejects sparse effects and invalid mandatory scalar values', () => {
        const sparseEffects = new Array(2);
        sparseEffects[0] = createInsertEffect('one', 'one');

        expect(() => validateRuntimeStateGuardedBatch({
            guard: createInsertGuard(),
            effects: sparseEffects,
        })).toThrow(/dense/iu);

        for (const mutation of [
            { field: 'namespace', value: '' },
            { field: 'key', value: '' },
            { field: 'value', value: 1 },
            { field: 'expireAtTimestamp', value: Number.NaN },
            { field: 'effectId', value: '' },
        ] as const) {
            const effect = {
                ...createInsertEffect('valid', 'valid'),
                [mutation.field]: mutation.value,
            };
            expect(() => validateRuntimeStateGuardedBatch({
                guard: createInsertGuard(),
                effects: [effect],
            })).toThrow(/runtime state guarded batch/iu);
        }
    });

    it.each([
        ['update', -0],
        ['update', -1],
        ['update', 0.5],
        ['update', Number.MAX_SAFE_INTEGER],
        ['delete', -0],
        ['delete', -1],
        ['delete', Number.MAX_SAFE_INTEGER + 1],
    ] as const)(
        'rejects invalid %s expected revision %s before SQL',
        (operation, expectedRevision) => {
            const guard = operation === 'update'
                ? {
                    operation,
                    namespace: 'guard',
                    key: 'root',
                    expectedRevision,
                    value: 'updated',
                    expireAtTimestamp: FUTURE_MS,
                }
                : {
                    operation,
                    namespace: 'guard',
                    key: 'root',
                    expectedRevision,
                };

            expect(() => validateRuntimeStateGuardedBatch({
                guard,
                effects: [createInsertEffect('effect', 'one')],
            })).toThrow(/expected revision/iu);
        },
    );

    it('validates a dense exact result in descriptor order', () => {
        const batch = createBatch();
        const result: RuntimeStateGuardedBatchResult = {
            guard: {
                status: 'applied',
                operation: 'update',
                namespace: 'guard',
                key: 'root',
                resultingRevision: 1,
            },
            effects: [{
                status: 'applied',
                effectId: 'insert',
                operation: 'insert',
                namespace: 'effect',
                key: 'insert',
                resultingRevision: 0,
            }, {
                status: 'applied',
                effectId: 'update',
                operation: 'update',
                namespace: 'effect',
                key: 'update',
                resultingRevision: 1,
            }, {
                status: 'applied',
                effectId: 'delete',
                operation: 'delete',
                namespace: 'effect',
                key: 'delete',
                matchedRevision: Number.MAX_SAFE_INTEGER,
            }, {
                status: 'applied',
                effectId: 'put',
                operation: 'put',
                namespace: 'effect',
                key: 'put',
                resultingRevision: 0,
            }],
        };

        expect(validateRuntimeStateGuardedBatchResult(batch, result)).toEqual(result);
    });

    it('accepts explicit guard-conflict skips and rejects sparse or inexact results', () => {
        const batch = createBatch();
        const result: RuntimeStateGuardedBatchResult = {
            guard: {
                status: 'conflict',
                operation: 'update',
                namespace: 'guard',
                key: 'root',
                reason: 'condition-not-met',
            },
            effects: batch.effects.map((effect) => ({
                status: 'skipped' as const,
                effectId: effect.effectId,
                operation: effect.operation,
                namespace: effect.namespace,
                key: effect.key,
                reason: 'guard-conflict' as const,
            })),
        };

        expect(validateRuntimeStateGuardedBatchResult(batch, result)).toEqual(result);

        for (const malformed of [
            { ...result, effects: result.effects.slice(0, -1) },
            {
                ...result,
                effects: result.effects.map((effect, index) =>
                    index === 0 ? { ...effect, effectId: 'unexpected' } : effect
                ),
            },
            {
                ...result,
                guard: { ...result.guard, key: 'unexpected' },
            },
        ]) {
            expect(() => validateRuntimeStateGuardedBatchResult(batch, malformed))
                .toThrow(/runtime state guarded batch result/iu);
        }
    });

    it('rejects a missing put receipt and an invalid operation-specific revision', () => {
        const batch: RuntimeStateGuardedBatch = {
            guard: createInsertGuard(),
            effects: [{
                effectId: 'put',
                operation: 'put',
                namespace: 'effect',
                key: 'put',
                value: 'put',
                expireAtTimestamp: FUTURE_MS,
            }],
        };

        expect(() => validateRuntimeStateGuardedBatchResult(batch, {
            guard: {
                status: 'applied',
                operation: 'insert',
                namespace: 'guard',
                key: 'root',
                resultingRevision: 0,
            },
            effects: [{
                status: 'conflict',
                effectId: 'put',
                operation: 'put',
                namespace: 'effect',
                key: 'put',
                reason: 'condition-not-met',
            }],
        })).toThrow(/put/iu);

        expect(() => validateRuntimeStateGuardedBatchResult(batch, {
            guard: {
                status: 'applied',
                operation: 'insert',
                namespace: 'guard',
                key: 'root',
                resultingRevision: 1,
            },
            effects: [{
                status: 'applied',
                effectId: 'put',
                operation: 'put',
                namespace: 'effect',
                key: 'put',
                resultingRevision: 0,
            }],
        })).toThrow(/revision/iu);
    });

    it('exposes guarded batches only on transaction-scoped PostgreSQL repositories', async () => {
        const captured: CapturedQuery[] = [];
        const sql = createTransactionalSql(captured, []);
        const repository = new PSqlRuntimeStateRepository(sql);

        expect(isRuntimeStateGuardedBatchRepositoryLike(repository)).toBe(false);
        await expect(repository.executeGuardedBatch(createBatch())).rejects.toThrow(
            /transaction/iu,
        );

        await repository.begin(async (transactionRepository) => {
            expect(isRuntimeStateGuardedBatchRepositoryLike(transactionRepository))
                .toBe(true);
        });
        expect(captured).toEqual([]);
    });

    it('rejects malformed guarded-batch capabilities without throwing', () => {
        for (const candidate of [
            null,
            {},
            { runtimeStateGuardedBatchCapability: false, executeGuardedBatch() {} },
            { runtimeStateGuardedBatchCapability: true, executeGuardedBatch: null },
        ]) {
            expect(() => isRuntimeStateGuardedBatchRepositoryLike(candidate))
                .not.toThrow();
            expect(isRuntimeStateGuardedBatchRepositoryLike(candidate)).toBe(false);
        }
    });

    it('uses one fixed parameterized guard-dependent statement without lock syntax', async () => {
        const batch: RuntimeStateGuardedBatch = {
            guard: {
                operation: 'update',
                namespace: 'guard-secret',
                key: 'root-secret',
                expectedRevision: 0,
                value: 'guard-value-secret',
                expireAtTimestamp: FUTURE_MS,
            },
            effects: [createInsertEffect('effect-secret', 'insert-secret')],
        };
        const captured: CapturedQuery[] = [];
        const sql = createTransactionalSql(captured, [{
            result_kind: 'guard',
            effect_id: null,
            operation: 'update',
            store_namespace: 'guard-secret',
            store_key: 'root-secret',
            revision: 1,
        }, {
            result_kind: 'effect',
            effect_id: 'effect-secret',
            operation: 'insert',
            store_namespace: 'effect',
            store_key: 'insert-secret',
            revision: 0,
        }]);
        const repository = new PSqlRuntimeStateRepository(sql);

        const result = await repository.begin(async (transactionRepository) => {
            if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
                throw new Error('Expected guarded batch capability.');
            }
            return await transactionRepository.executeGuardedBatch(batch);
        });

        expect(result).toEqual({
            guard: {
                status: 'applied',
                operation: 'update',
                namespace: 'guard-secret',
                key: 'root-secret',
                resultingRevision: 1,
            },
            effects: [{
                status: 'applied',
                effectId: 'effect-secret',
                operation: 'insert',
                namespace: 'effect',
                key: 'insert-secret',
                resultingRevision: 0,
            }],
        });
        expect(captured).toHaveLength(1);
        const [query] = captured;
        expect(query.source).toMatch(/guard_insert\s+as/iu);
        expect(query.source).toMatch(/guard_update\s+as/iu);
        expect(query.source).toMatch(/guard_delete\s+as/iu);
        expect(query.source).toMatch(/authority\s+as/iu);
        for (const cte of ['effect_insert', 'effect_update', 'effect_delete', 'effect_put']) {
            const cteSource = query.source.match(
                new RegExp(`${cte}\\s+as\\s*\\(([\\s\\S]*?)\\n\\s*\\)`, 'iu'),
            )?.[1] ?? '';
            expect(cteSource).toMatch(/authority/iu);
        }
        expect(query.source).not.toMatch(
            /for\s+update|pg_advisory|lockKey/iu,
        );
        for (const secret of [
            'guard-secret',
            'root-secret',
            'guard-value-secret',
            'effect-secret',
            'insert-secret',
        ]) {
            expect(query.source).not.toContain(secret);
        }
        const jsonValues = query.values.map((value) =>
            JSON.parse(value as string) as unknown
        );
        expect(jsonValues).toContainEqual({
            ...batch.guard,
            expireAtTimestamp: new Date(FUTURE_MS).toISOString(),
        });
        expect(jsonValues).toContainEqual(batch.effects.map((effect) =>
            'expireAtTimestamp' in effect
                ? {
                    ...effect,
                    expireAtTimestamp: new Date(
                        effect.expireAtTimestamp,
                    ).toISOString(),
                }
                : effect
        ));
    });

    it.each([
        ['an effect without guard authority', [{
            result_kind: 'effect',
            effect_id: 'insert',
            operation: 'insert',
            store_namespace: 'effect',
            store_key: 'insert',
            revision: 0,
        }]],
        ['a duplicate guard row', [{
            result_kind: 'guard',
            effect_id: null,
            operation: 'update',
            store_namespace: 'guard',
            store_key: 'root',
            revision: 1,
        }, {
            result_kind: 'guard',
            effect_id: null,
            operation: 'update',
            store_namespace: 'guard',
            store_key: 'root',
            revision: 1,
        }]],
        ['an unexpected effect identity', [{
            result_kind: 'guard',
            effect_id: null,
            operation: 'update',
            store_namespace: 'guard',
            store_key: 'root',
            revision: 1,
        }, {
            result_kind: 'effect',
            effect_id: 'insert',
            operation: 'insert',
            store_namespace: 'effect',
            store_key: 'unexpected',
            revision: 0,
        }]],
    ])('rejects database results containing %s', async (_label, rows) => {
        const repository = new PSqlRuntimeStateRepository(
            createTransactionalSql([], rows),
        );

        await expect(repository.begin(async (transactionRepository) => {
            if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
                throw new Error('Expected guarded batch capability.');
            }
            return await transactionRepository.executeGuardedBatch(createBatch());
        })).rejects.toThrow(/guarded batch database result/iu);
    });
});

function createInsertGuard(): RuntimeStateGuardedBatch['guard'] {
    return {
        operation: 'insert',
        namespace: 'guard',
        key: 'root',
        value: 'root',
        expireAtTimestamp: FUTURE_MS,
    };
}

function createInsertEffect(
    effectId: string,
    key: string,
): RuntimeStateGuardedBatch['effects'][number] {
    return {
        effectId,
        operation: 'insert',
        namespace: 'effect',
        key,
        value: key,
        expireAtTimestamp: FUTURE_MS,
    };
}

function createBatch(): RuntimeStateGuardedBatch {
    return {
        guard: {
            operation: 'update',
            namespace: 'guard',
            key: 'root',
            expectedRevision: 0,
            value: 'root-updated',
            expireAtTimestamp: FUTURE_MS,
        },
        effects: [{
            effectId: 'insert',
            operation: 'insert',
            namespace: 'effect',
            key: 'insert',
            value: 'inserted',
            expireAtTimestamp: FUTURE_MS,
        }, {
            effectId: 'update',
            operation: 'update',
            namespace: 'effect',
            key: 'update',
            expectedRevision: 0,
            value: 'updated',
            expireAtTimestamp: FUTURE_MS,
        }, {
            effectId: 'delete',
            operation: 'delete',
            namespace: 'effect',
            key: 'delete',
            expectedRevision: Number.MAX_SAFE_INTEGER,
        }, {
            effectId: 'put',
            operation: 'put',
            namespace: 'effect',
            key: 'put',
            value: 'put',
            expireAtTimestamp: FUTURE_MS,
        }],
    };
}

type CapturedQuery = Readonly<{
    source: string;
    values: readonly unknown[];
}>;

function createTransactionalSql(
    captured: CapturedQuery[],
    resultRows: readonly unknown[],
): PSqlSql {
    const transactionSql = ((
        strings: TemplateStringsArray,
        ...values: unknown[]
    ) => {
        captured.push({ source: strings.join('?'), values });
        return Promise.resolve(resultRows);
    }) as unknown as PSqlTransactionSql & Readonly<{
        savepoint<T>(fn: (sql: PSqlTransactionSql) => Promise<T>): Promise<T>;
    }>;
    transactionSql.begin = async <T>(
        fn: (sql: PSqlTransactionSql) => Promise<T>,
    ): Promise<T> => await fn(transactionSql);
    transactionSql.savepoint = async <T>(
        fn: (sql: PSqlTransactionSql) => Promise<T>,
    ): Promise<T> => await fn(transactionSql);

    const rootSql = (() => {
        throw new Error('Root SQL should not be called.');
    }) as unknown as PSqlSql;
    rootSql.begin = async <T>(
        fn: (sql: PSqlTransactionSql) => Promise<T>,
    ): Promise<T> => await fn(transactionSql);
    return rootSql;
}
