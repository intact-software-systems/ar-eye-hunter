import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { waitForRuntimeStateWriteRetry } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { selectRuntimeStateReadBatch } from '@shared-server/runtime-state/read-batch/select-runtime-state-read-batch.ts';
import { RuntimeStateJsonStore, type RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';
import {
    isRuntimeStateConditionalRepositoryLike,
    type RuntimeStateConditionalDeleteResult,
    type RuntimeStateConditionalWriteResult,
    type RuntimeStateRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('runtime-state conditional writes', () => {
    it.each(['get', 'list', 'byKeys'] as const)(
        'treats expired entry-aware %s reads as observational absence',
        async (readKind) => {
            const repository = new FakeRuntimeStateRepository();
            const store = new ExposedRuntimeStateJsonStore(repository);
            await repository.insertIfAbsent(
                'state',
                'key',
                JSON.stringify({ version: 'expired' }),
                Date.now() - 1
            );
            const before = await repository.findEntry('state', 'key');
            const writes: string[] = [];
            repository.beforeConditionalWrite = (operation) => {
                writes.push(operation);
            };

            const values = readKind === 'get'
                ? [await store.readEntry<{ version: string; }>('state', 'key')]
                    .filter((value): value is RuntimeStateEntryValue<{ version: string; }> => value !== undefined)
                : readKind === 'list'
                ? await store.readEntries<{ version: string; }>('state')
                : await store.readEntriesByKeys<{ version: string; }>(
                    'state',
                    ['key']
                );

            expect(values).toEqual([]);
            await expect(repository.findEntry('state', 'key')).resolves.toEqual(before);
            expect(writes).toEqual([]);
            expect(store.retryAttempts).toEqual([]);
            expect(store.retryDelays).toEqual([]);
        }
    );

    it('leaves an expired row untouched when later mutation validation fails', async () => {
        const repository = new FakeRuntimeStateRepository();
        const store = new ExposedRuntimeStateJsonStore(repository);
        const expiredAt = Date.now() - 1;
        await repository.insertIfAbsent(
            'state',
            'key',
            JSON.stringify({ version: 0 }),
            expiredAt
        );
        const before = await repository.findEntry('state', 'key');

        await expect(store.read('state', 'key')).resolves.toBeUndefined();
        expect(() => {
            throw new TypeError('later validation failed');
        }).toThrow('later validation failed');
        await expect(repository.findEntry('state', 'key')).resolves.toEqual(before);
        expect(store.retryAttempts).toEqual([]);
        expect(store.retryDelays).toEqual([]);
    });

    it('serializes once and delegates protected JSON writes conditionally', async () => {
        const repository = new FakeRuntimeStateRepository();
        const store = new ExposedRuntimeStateJsonStore(repository);
        let serializations = 0;
        const value = {
            toJSON() {
                serializations += 1;
                return { stored: true };
            }
        };

        await expect(
            store.insert('state', 'key', value, NEVER_EXPIRE_AT_TIMESTAMP)
        ).resolves.toEqual({ status: 'applied', revision: 0 });
        expect(serializations).toBe(1);
        await expect(
            store.update('state', 'key', value, NEVER_EXPIRE_AT_TIMESTAMP, 0)
        ).resolves.toEqual({ status: 'applied', revision: 1 });
        expect(serializations).toBe(2);
        await expect(store.delete('state', 'key', 1)).resolves.toEqual({
            status: 'applied'
        });
    });

    it('fails conditional JSON helpers fast without repository capability', async () => {
        let unconditionalWrites = 0;
        let unconditionalDeletes = 0;
        const repository: RuntimeStateRepositoryLike = {
            findEntry: () => Promise.resolve(undefined),
            findAllEntries: () => Promise.resolve([]),
            readRuntimeStateBatch: (selectors) =>
                Promise.resolve(
                    selectRuntimeStateReadBatch([], selectors)
                ),
            upsert: () => {
                unconditionalWrites += 1;
                return Promise.resolve();
            },
            deleteByKey: () => {
                unconditionalDeletes += 1;
                return Promise.resolve();
            },
            deleteExpired: () => Promise.resolve(0)
        };
        const store = new ExposedRuntimeStateJsonStore(repository);

        await expect(
            store.insert('state', 'key', { stored: true }, NEVER_EXPIRE_AT_TIMESTAMP)
        ).rejects.toThrow(/conditional runtime state repository/u);
        await expect(
            store.update(
                'state',
                'key',
                { stored: true },
                NEVER_EXPIRE_AT_TIMESTAMP,
                0
            )
        ).rejects.toThrow(/conditional runtime state repository/u);
        await expect(store.delete('state', 'key', 0)).rejects.toThrow(
            /conditional runtime state repository/u
        );
        expect(unconditionalWrites).toBe(0);
        expect(unconditionalDeletes).toBe(0);
    });

    it('omits expired last-write-wins rows without an unsafe delete fallback', async () => {
        let unconditionalDeletes = 0;
        const expiredEntry = {
            key: 'key',
            value: JSON.stringify({ version: 'expired' }),
            expireAtTimestamp: Date.now() - 1,
            updatedTimestamp: new Date().toISOString(),
            revision: 0
        } as const;
        const repository: RuntimeStateRepositoryLike = {
            findEntry: () => Promise.resolve(expiredEntry),
            findAllEntries: () => Promise.resolve([expiredEntry]),
            readRuntimeStateBatch: (selectors) =>
                Promise.resolve(
                    selectRuntimeStateReadBatch(
                        [{ namespace: 'state', entry: expiredEntry }],
                        selectors
                    )
                ),
            upsert: () => Promise.resolve(),
            deleteByKey: () => {
                unconditionalDeletes += 1;
                return Promise.resolve();
            },
            deleteExpired: () => Promise.resolve(0)
        };
        const store = new ExposedRuntimeStateJsonStore(repository);

        await expect(store.read('state', 'key')).resolves.toBeUndefined();
        expect(store.retryAttempts).toEqual([]);
        expect(store.retryDelays).toEqual([]);
        expect(unconditionalDeletes).toBe(0);
    });

    it('applies writes only when the expected revision matches', async () => {
        const repository = new FakeRuntimeStateRepository();

        expect(
            await repository.insertIfAbsent(
                'state',
                'key',
                'v1',
                NEVER_EXPIRE_AT_TIMESTAMP
            )
        ).toEqual({ status: 'applied', revision: 0 });
        expect(
            await repository.insertIfAbsent(
                'state',
                'key',
                'v2',
                NEVER_EXPIRE_AT_TIMESTAMP
            )
        ).toEqual({ status: 'conflict' });
        expect(
            await repository.upsertIfRevision(
                'state',
                'key',
                'v2',
                NEVER_EXPIRE_AT_TIMESTAMP,
                0
            )
        ).toEqual({ status: 'applied', revision: 1 });
        expect(
            await repository.upsertIfRevision(
                'state',
                'key',
                'stale',
                NEVER_EXPIRE_AT_TIMESTAMP,
                0
            )
        ).toEqual({ status: 'conflict' });
        expect(await repository.deleteIfRevision('state', 'key', 0)).toEqual({
            status: 'conflict'
        });
        expect(await repository.deleteIfRevision('state', 'key', 1)).toEqual({
            status: 'applied'
        });
    });

    it('rejects malformed conditional repository capabilities without throwing', () => {
        const baseRepository: RuntimeStateRepositoryLike = {
            findEntry: () => Promise.resolve(undefined),
            findAllEntries: () => Promise.resolve([]),
            readRuntimeStateBatch: (selectors) =>
                Promise.resolve(
                    selectRuntimeStateReadBatch([], selectors)
                ),
            upsert: () => Promise.resolve(),
            deleteByKey: () => Promise.resolve(),
            deleteExpired: () => Promise.resolve(0)
        };
        const malformedRepository = {
            ...baseRepository,
            insertIfAbsent: undefined,
            upsertIfRevision: 1,
            deleteIfRevision: null
        };

        expect(() => isRuntimeStateConditionalRepositoryLike(malformedRepository)).not.toThrow();
        expect(isRuntimeStateConditionalRepositoryLike(malformedRepository)).toBe(false);
        expect(
            isRuntimeStateConditionalRepositoryLike(
                new FakeRuntimeStateRepository()
            )
        ).toBe(true);
        expect(
            isRuntimeStateConditionalRepositoryLike(
                new PSqlRuntimeStateRepository(createResultSql(0))
            )
        ).toBe(true);
    });

    it.each(['9007199254740992', '-1', 'not-a-revision'])(
        'rejects an invalid conditional-write revision %s',
        async (revision) => {
            const repository = new PSqlRuntimeStateRepository(
                createResultSql(revision)
            );

            await expect(
                repository.insertIfAbsent(
                    'state',
                    'key',
                    'value',
                    NEVER_EXPIRE_AT_TIMESTAMP
                )
            ).rejects.toThrow(/Invalid runtime state revision/u);
        }
    );

    it('rejects negative-zero conditional-write revisions while preserving zero', async () => {
        const negativeZeroRepository = new PSqlRuntimeStateRepository(
            createResultSql(-0)
        );
        const zeroRepository = new PSqlRuntimeStateRepository(
            createResultSql(0)
        );

        await expect(
            negativeZeroRepository.insertIfAbsent(
                'state',
                'key',
                'value',
                NEVER_EXPIRE_AT_TIMESTAMP
            )
        ).rejects.toThrow(/Invalid runtime state revision/u);
        await expect(
            zeroRepository.insertIfAbsent(
                'state',
                'key',
                'value',
                NEVER_EXPIRE_AT_TIMESTAMP
            )
        ).resolves.toEqual({ status: 'applied', revision: 0 });
    });

    it('rejects an unsafe revision when loading a stored entry', async () => {
        const repository = new PSqlRuntimeStateRepository(
            createResultSql({
                store_namespace: 'state',
                store_key: 'key',
                store_value: 'value',
                updated_ts: '2026-07-18T00:00:00.000Z',
                expire_at_ts: '9999-12-31T23:59:59.999Z',
                revision: '9007199254740992'
            })
        );

        await expect(repository.findEntry('state', 'key')).rejects.toThrow(
            /Invalid runtime state revision/u
        );
    });

    it('rejects a negative-zero revision when loading a stored entry', async () => {
        const repository = new PSqlRuntimeStateRepository(
            createResultSql({
                store_namespace: 'state',
                store_key: 'key',
                store_value: 'value',
                updated_ts: '2026-07-18T00:00:00.000Z',
                expire_at_ts: '9999-12-31T23:59:59.999Z',
                revision: -0
            })
        );

        await expect(repository.findEntry('state', 'key')).rejects.toThrow(
            /Invalid runtime state revision/u
        );
    });

    it('normalizes supported PostgreSQL timestamp values and rejects invalid or ambiguous driver strings', async () => {
        const row = (updated_ts: unknown) => ({
            store_namespace: 'state',
            store_key: 'key',
            store_value: 'value',
            updated_ts,
            expire_at_ts: '9999-12-31T23:59:59.999Z',
            revision: 0
        });

        await expect(new PSqlRuntimeStateRepository(
            createResultSql(row(new Date('2026-07-19T00:30:00.000Z')))
        ).findEntry('state', 'key')).resolves.toMatchObject({
            updatedTimestamp: '2026-07-19T00:30:00.000Z'
        });
        await expect(new PSqlRuntimeStateRepository(
            createResultSql(row('2026-07-19 09:30:00+09'))
        ).findEntry('state', 'key')).resolves.toMatchObject({
            updatedTimestamp: '2026-07-19T00:30:00.000Z'
        });

        for (
            const updatedTimestamp of [
                '',
                '   ',
                'not-a-date',
                '07/19/2026 09:30:00',
                '2026-07-19T09:30:00',
                new Date(Number.NaN)
            ]
        ) {
            await expect(new PSqlRuntimeStateRepository(
                createResultSql(row(updatedTimestamp))
            ).findEntry('state', 'key')).rejects.toThrow(
                /Invalid runtime state updated_ts/u
            );
        }
    });

    it('rejects invalid upsert revisions before SQL and fake mutation', async () => {
        const invalidRevisions = [
            Number.NaN,
            Number.POSITIVE_INFINITY,
            0.5,
            -1,
            -0,
            Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER + 1
        ];

        for (const expectedRevision of invalidRevisions) {
            let sqlCalls = 0;
            const sqlRepository = new PSqlRuntimeStateRepository(
                createResultSql(1, () => {
                    sqlCalls += 1;
                })
            );
            await expect(
                sqlRepository.upsertIfRevision(
                    'state',
                    'key',
                    'changed',
                    NEVER_EXPIRE_AT_TIMESTAMP,
                    expectedRevision
                )
            ).rejects.toThrow(/Invalid runtime state upsert expected revision/u);
            expect(sqlCalls).toBe(0);

            const fakeRepository = new FakeRuntimeStateRepository();
            await fakeRepository.insertIfAbsent(
                'state',
                'key',
                'original',
                NEVER_EXPIRE_AT_TIMESTAMP
            );
            const before = await fakeRepository.findEntry('state', 'key');
            await expect(
                fakeRepository.upsertIfRevision(
                    'state',
                    'key',
                    'changed',
                    NEVER_EXPIRE_AT_TIMESTAMP,
                    expectedRevision
                )
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
            Number.MAX_SAFE_INTEGER + 1
        ];

        for (const expectedRevision of invalidRevisions) {
            let sqlCalls = 0;
            const sqlRepository = new PSqlRuntimeStateRepository(
                createResultSql(Number.MAX_SAFE_INTEGER, () => {
                    sqlCalls += 1;
                })
            );
            await expect(
                sqlRepository.deleteIfRevision(
                    'state',
                    'key',
                    expectedRevision
                )
            ).rejects.toThrow(/Invalid runtime state expected revision/u);
            expect(sqlCalls).toBe(0);

            const fakeRepository = new FakeRuntimeStateRepository();
            await fakeRepository.insertIfAbsent(
                'state',
                'key',
                'original',
                NEVER_EXPIRE_AT_TIMESTAMP
            );
            const before = await fakeRepository.findEntry('state', 'key');
            await expect(
                fakeRepository.deleteIfRevision(
                    'state',
                    'key',
                    expectedRevision
                )
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
            })
        );
        await expect(
            sqlRepository.upsertIfRevision(
                'state',
                'key',
                'changed',
                NEVER_EXPIRE_AT_TIMESTAMP,
                Number.MAX_SAFE_INTEGER
            )
        ).rejects.toThrow(/Invalid runtime state upsert expected revision/u);
        expect(sqlCalls).toBe(0);
        await expect(
            sqlRepository.deleteIfRevision(
                'state',
                'key',
                Number.MAX_SAFE_INTEGER
            )
        ).resolves.toEqual({ status: 'applied' });
        expect(sqlCalls).toBe(1);

        const fakeRepository = new FakeRuntimeStateRepository();
        fakeRepository.data.set('state::key', {
            key: 'key',
            value: 'original',
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            updatedTimestamp: '2026-07-18T00:00:00.000Z',
            revision: Number.MAX_SAFE_INTEGER
        });
        await expect(
            fakeRepository.upsertIfRevision(
                'state',
                'key',
                'changed',
                NEVER_EXPIRE_AT_TIMESTAMP,
                Number.MAX_SAFE_INTEGER
            )
        ).rejects.toThrow(/Invalid runtime state upsert expected revision/u);
        await expect(fakeRepository.findEntry('state', 'key')).resolves
            .toMatchObject({
                value: 'original',
                revision: Number.MAX_SAFE_INTEGER
            });
        await expect(
            fakeRepository.deleteIfRevision(
                'state',
                'key',
                Number.MAX_SAFE_INTEGER
            )
        ).resolves.toEqual({ status: 'applied' });
    });

    it('preserves optimistic capability and rollback across nested fake begins', async () => {
        const repository = new FakeRuntimeStateRepository();

        await repository.begin(async (transactionRepository) => {
            await transactionRepository.insertIfAbsent(
                'state',
                'outer',
                'outer',
                NEVER_EXPIRE_AT_TIMESTAMP
            );
            await expect(
                transactionRepository.begin(async (nestedRepository) => {
                    await nestedRepository.insertIfAbsent(
                        'state',
                        'rolled-back',
                        'nested',
                        NEVER_EXPIRE_AT_TIMESTAMP
                    );
                    throw new Error('rollback nested fake begin');
                })
            ).rejects.toThrow('rollback nested fake begin');
        });

        await expect(repository.findEntry('state', 'outer')).resolves.toBeDefined();
        await expect(repository.findEntry('state', 'rolled-back')).resolves
            .toBeUndefined();
    });
});

class ExposedRuntimeStateJsonStore extends RuntimeStateJsonStore {
    readonly retryAttempts: Array<0 | 1 | 2> = [];
    readonly retryDelays: number[] = [];

    read<T>(namespace: string, key: string): Promise<T | undefined> {
        return this.getValue<T>(namespace, key);
    }

    readEntry<T>(
        namespace: string,
        key: string
    ): Promise<RuntimeStateEntryValue<T> | undefined> {
        return this.getEntryValue<T>(namespace, key);
    }

    readEntries<T>(
        namespace: string
    ): Promise<readonly RuntimeStateEntryValue<T>[]> {
        return this.listEntryValues<T>(namespace);
    }

    readEntriesByKeys<T>(
        namespace: string,
        keys: readonly string[]
    ): Promise<readonly RuntimeStateEntryValue<T>[]> {
        return this.listEntryValuesByKeys<T>(namespace, keys);
    }

    insert(
        namespace: string,
        key: string,
        value: object,
        expireAtTimestamp: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        return this.putValueIfAbsent(namespace, key, value, expireAtTimestamp);
    }

    update(
        namespace: string,
        key: string,
        value: object,
        expireAtTimestamp: number,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        return this.putValueIfRevision(
            namespace,
            key,
            value,
            expireAtTimestamp,
            expectedRevision
        );
    }

    delete(
        namespace: string,
        key: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return this.deleteValueIfRevision(namespace, key, expectedRevision);
    }

    protected async waitForRuntimeStateWriteRetry(
        attempt: 0 | 1 | 2
    ): Promise<number> {
        this.retryAttempts.push(attempt);
        return await waitForRuntimeStateWriteRetry(attempt, {
            sleep: (delayMs) => {
                this.retryDelays.push(delayMs);
                return Promise.resolve();
            }
        });
    }
}

function createResultSql(
    result: unknown,
    onQuery: () => void = () => {}
): PSqlSql {
    const sql = (() => {
        onQuery();
        return Promise.resolve([
            typeof result === 'object' && result !== null
                ? result
                : { revision: result }
        ]);
    }) as unknown as PSqlSql;
    sql.begin = async <T>(
        _fn: (transactionSql: PSqlSql) => Promise<T>
    ): Promise<T> => {
        throw new Error('Test SQL does not run transactions.');
    };
    return sql;
}
