import { describe, expect, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type {
    PSqlSql,
    PSqlTransactionSql,
} from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
    isRuntimeStateConditionalRepositoryLike,
    type RuntimeStateRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('runtime-state conditional writes', () => {
    it('applies writes only when the expected revision matches', async () => {
        const repository = new FakeRuntimeStateRepository();

        expect(
            await repository.insertIfAbsent(
                'state',
                'key',
                'v1',
                NEVER_EXPIRE_AT_TIMESTAMP,
            ),
        ).toEqual({ status: 'applied', revision: 0 });
        expect(
            await repository.insertIfAbsent(
                'state',
                'key',
                'v2',
                NEVER_EXPIRE_AT_TIMESTAMP,
            ),
        ).toEqual({ status: 'conflict' });
        expect(
            await repository.upsertIfRevision(
                'state',
                'key',
                'v2',
                NEVER_EXPIRE_AT_TIMESTAMP,
                0,
            ),
        ).toEqual({ status: 'applied', revision: 1 });
        expect(
            await repository.upsertIfRevision(
                'state',
                'key',
                'stale',
                NEVER_EXPIRE_AT_TIMESTAMP,
                0,
            ),
        ).toEqual({ status: 'conflict' });
        expect(await repository.deleteIfRevision('state', 'key', 0)).toEqual({
            status: 'conflict',
        });
        expect(await repository.deleteIfRevision('state', 'key', 1)).toEqual({
            status: 'applied',
        });
    });

    it('rejects malformed conditional repository capabilities without throwing', () => {
        const baseRepository: RuntimeStateRepositoryLike = {
            findEntry: () => Promise.resolve(undefined),
            findAllEntries: () => Promise.resolve([]),
            upsert: () => Promise.resolve(),
            deleteByKey: () => Promise.resolve(),
            deleteExpired: () => Promise.resolve(0),
        };
        const malformedRepository = {
            ...baseRepository,
            insertIfAbsent: undefined,
            upsertIfRevision: 1,
            deleteIfRevision: null,
        };

        expect(() =>
            isRuntimeStateConditionalRepositoryLike(malformedRepository)
        ).not.toThrow();
        expect(isRuntimeStateConditionalRepositoryLike(malformedRepository)).toBe(false);
        expect(
            isRuntimeStateConditionalRepositoryLike(
                new FakeRuntimeStateRepository(),
            ),
        ).toBe(true);
        expect(
            isRuntimeStateConditionalRepositoryLike(
                new PSqlRuntimeStateRepository(createResultSql(0)),
            ),
        ).toBe(true);
    });

    it.each(['9007199254740992', '-1', 'not-a-revision'])(
        'rejects an invalid conditional-write revision %s',
        async (revision) => {
            const repository = new PSqlRuntimeStateRepository(
                createResultSql(revision),
            );

            await expect(
                repository.insertIfAbsent(
                    'state',
                    'key',
                    'value',
                    NEVER_EXPIRE_AT_TIMESTAMP,
                ),
            ).rejects.toThrow(/Invalid runtime state revision/u);
        },
    );

    it('rejects an unsafe revision when loading a stored entry', async () => {
        const repository = new PSqlRuntimeStateRepository(
            createResultSql({
                store_namespace: 'state',
                store_key: 'key',
                store_value: 'value',
                updated_ts: '2026-07-18T00:00:00.000Z',
                expire_at_ts: '9999-12-31T23:59:59.999Z',
                revision: '9007199254740992',
            }),
        );

        await expect(repository.findEntry('state', 'key')).rejects.toThrow(
            /Invalid runtime state revision/u,
        );
    });

    it('rejects invalid upsert revisions before SQL and fake mutation', async () => {
        const invalidRevisions = [
            Number.NaN,
            Number.POSITIVE_INFINITY,
            0.5,
            -1,
            -0,
            Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER + 1,
        ];

        for (const expectedRevision of invalidRevisions) {
            let sqlCalls = 0;
            const sqlRepository = new PSqlRuntimeStateRepository(
                createResultSql(1, () => {
                    sqlCalls += 1;
                }),
            );
            await expect(
                sqlRepository.upsertIfRevision(
                    'state',
                    'key',
                    'changed',
                    NEVER_EXPIRE_AT_TIMESTAMP,
                    expectedRevision,
                ),
            ).rejects.toThrow(/Invalid runtime state upsert expected revision/u);
            expect(sqlCalls).toBe(0);

            const fakeRepository = new FakeRuntimeStateRepository();
            await fakeRepository.insertIfAbsent(
                'state',
                'key',
                'original',
                NEVER_EXPIRE_AT_TIMESTAMP,
            );
            const before = await fakeRepository.findEntry('state', 'key');
            await expect(
                fakeRepository.upsertIfRevision(
                    'state',
                    'key',
                    'changed',
                    NEVER_EXPIRE_AT_TIMESTAMP,
                    expectedRevision,
                ),
            ).rejects.toThrow(/Invalid runtime state upsert expected revision/u);
            await expect(fakeRepository.findEntry('state', 'key')).resolves
                .toEqual(before);
        }
    });

    it('rejects invalid delete revisions before SQL and fake mutation', async () => {
        const invalidRevisions = [
            Number.NaN,
            Number.POSITIVE_INFINITY,
            0.5,
            -1,
            -0,
            Number.MAX_SAFE_INTEGER + 1,
        ];

        for (const expectedRevision of invalidRevisions) {
            let sqlCalls = 0;
            const sqlRepository = new PSqlRuntimeStateRepository(
                createResultSql(Number.MAX_SAFE_INTEGER, () => {
                    sqlCalls += 1;
                }),
            );
            await expect(
                sqlRepository.deleteIfRevision(
                    'state',
                    'key',
                    expectedRevision,
                ),
            ).rejects.toThrow(/Invalid runtime state expected revision/u);
            expect(sqlCalls).toBe(0);

            const fakeRepository = new FakeRuntimeStateRepository();
            await fakeRepository.insertIfAbsent(
                'state',
                'key',
                'original',
                NEVER_EXPIRE_AT_TIMESTAMP,
            );
            const before = await fakeRepository.findEntry('state', 'key');
            await expect(
                fakeRepository.deleteIfRevision(
                    'state',
                    'key',
                    expectedRevision,
                ),
            ).rejects.toThrow(/Invalid runtime state expected revision/u);
            await expect(fakeRepository.findEntry('state', 'key')).resolves
                .toEqual(before);
        }
    });

    it('allows delete but prevents increment at MAX_SAFE_INTEGER', async () => {
        let sqlCalls = 0;
        const sqlRepository = new PSqlRuntimeStateRepository(
            createResultSql(Number.MAX_SAFE_INTEGER, () => {
                sqlCalls += 1;
            }),
        );
        await expect(
            sqlRepository.upsertIfRevision(
                'state',
                'key',
                'changed',
                NEVER_EXPIRE_AT_TIMESTAMP,
                Number.MAX_SAFE_INTEGER,
            ),
        ).rejects.toThrow(/Invalid runtime state upsert expected revision/u);
        expect(sqlCalls).toBe(0);
        await expect(
            sqlRepository.deleteIfRevision(
                'state',
                'key',
                Number.MAX_SAFE_INTEGER,
            ),
        ).resolves.toEqual({ status: 'applied' });
        expect(sqlCalls).toBe(1);

        const fakeRepository = new FakeRuntimeStateRepository();
        fakeRepository.data.set('state::key', {
            key: 'key',
            value: 'original',
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            updatedTimestamp: '2026-07-18T00:00:00.000Z',
            revision: Number.MAX_SAFE_INTEGER,
        });
        await expect(
            fakeRepository.upsertIfRevision(
                'state',
                'key',
                'changed',
                NEVER_EXPIRE_AT_TIMESTAMP,
                Number.MAX_SAFE_INTEGER,
            ),
        ).rejects.toThrow(/Invalid runtime state upsert expected revision/u);
        await expect(fakeRepository.findEntry('state', 'key')).resolves
            .toMatchObject({
                value: 'original',
                revision: Number.MAX_SAFE_INTEGER,
            });
        await expect(
            fakeRepository.deleteIfRevision(
                'state',
                'key',
                Number.MAX_SAFE_INTEGER,
            ),
        ).resolves.toEqual({ status: 'applied' });
    });

    it('preserves optimistic capability and rollback across nested fake begins', async () => {
        const repository = new FakeRuntimeStateRepository();

        await repository.begin(async (transactionRepository) => {
            await transactionRepository.insertIfAbsent(
                'state',
                'outer',
                'outer',
                NEVER_EXPIRE_AT_TIMESTAMP,
            );
            await expect(
                transactionRepository.begin(async (nestedRepository) => {
                    await nestedRepository.insertIfAbsent(
                        'state',
                        'rolled-back',
                        'nested',
                        NEVER_EXPIRE_AT_TIMESTAMP,
                    );
                    throw new Error('rollback nested fake begin');
                }),
            ).rejects.toThrow('rollback nested fake begin');
        });

        await expect(repository.findEntry('state', 'outer')).resolves.toBeDefined();
        await expect(repository.findEntry('state', 'rolled-back')).resolves
            .toBeUndefined();
    });
});

function createResultSql(
    result: unknown,
    onQuery: () => void = () => {},
): PSqlSql {
    const sql = (() => {
        onQuery();
        return Promise.resolve([
            typeof result === 'object' && result !== null
                ? result
                : { revision: result },
        ]);
    }) as unknown as PSqlSql;
    sql.begin = async <T>(
        _fn: (transactionSql: PSqlTransactionSql) => Promise<T>,
    ): Promise<T> => {
        throw new Error('Test SQL does not run transactions.');
    };
    return sql;
}
