import type {
    AppDataConditionalDeleteResult,
    AppDataConditionalInsertResult,
    AppDataConditionalWriteResult,
    AppDataDeleteExpiredInput,
    AppDataDeleteIfRevisionInput,
    AppDataEntry,
    AppDataEntryPageInput,
    AppDataKey,
    AppDataRepository,
    AppDataUpsertIfRevisionInput,
    AppDataUpsertInput
} from '@shared-server/app-data/app-data-repository.ts';
import type { AppDataValueCodec } from '@shared-server/app-data/app-data-value-codec.ts';
import { RallarServerAppData } from '@shared-server/app-data/rallar-server-app-data.ts';
import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Todo {
    readonly title: string;
    readonly done: boolean;
}

interface Counter {
    readonly count: number;
}

const TODO_CODEC = createTodoCodec(1);
const TODO_SCHEMA_2_CODEC = createTodoCodec(2);
const COUNTER_CODEC: AppDataValueCodec<Counter> = {
    schemaVersion: 1,
    encode: (value) => ({ count: value.count }),
    decode: (value) => {
        if (!isJsonWireObject(value) || typeof value.count !== 'number') {
            throw new TypeError('Counter app data must contain a numeric count.');
        }
        return { count: value.count };
    }
};

describe('Rallar server app data stores', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('rejects invalid codec schema versions when defining stores', () => {
        const appData = createAppData(new FakeAppDataRepository());

        expect(() =>
            appData.define('todos', {
                codec: { ...TODO_CODEC, schemaVersion: -1 }
            })
        ).toThrow(
            'Rallar server app data codec schemaVersion must be a non-negative integer.'
        );
    });

    it('stores custom data in memory and through the repository', async () => {
        const repository = new FakeAppDataRepository();
        const manager = new RepositoryManager();
        const appData = createAppData(repository, manager);
        const todos = await appData.open('todos', { codec: TODO_CODEC });

        await todos.set('1', {
            title: 'Implement server data stores',
            done: false
        });

        expect(todos.read('1')).toEqual({
            title: 'Implement server data stores',
            done: false
        });
        expect(await todos.get('1')).toEqual({
            title: 'Implement server data stores',
            done: false
        });
        expect(await todos.getEntries()).toEqual([
            ['1', {
                title: 'Implement server data stores',
                done: false
            }]
        ]);
        expect(appData.lookup('todos', { codec: TODO_CODEC })?.repositoryId).toBe(
            todos.repositoryId
        );
        expect(manager.has(todos.repositoryId)).toBe(true);
    });

    it('reuses opened stores and keeps key prefixes isolated', async () => {
        const appData = createAppData(new FakeAppDataRepository());
        const todos = await appData.open('todos', { codec: TODO_CODEC });

        expect(
            (await appData.open('todos', { codec: TODO_CODEC })).repositoryId
        ).toBe(todos.repositoryId);
        await expect(
            appData.open('todos', {
                codec: TODO_SCHEMA_2_CODEC
            })
        ).rejects.toThrow(
            'Rallar server app data store already opened with different options'
        );

        const archived = await appData.open('todos', {
            codec: TODO_CODEC,
            keyPrefix: 'archived:'
        });

        expect(archived.repositoryId).not.toBe(todos.repositoryId);
    });

    it('evicts expired repository entries lazily on read-through', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const repository = new FakeAppDataRepository();
        const appData = createAppData(repository);
        const todos = await appData.open('todos', {
            codec: TODO_CODEC,
            ttlMs: 1_000
        });

        await todos.set('1', {
            title: 'Temporary',
            done: false
        });
        vi.setSystemTime(new Date('2026-01-01T00:00:01.001Z'));

        expect(todos.read('1')).toBeUndefined();
        expect(await todos.get('1')).toBeUndefined();
        expect(
            await repository.findEntry({
                namespace: 'app',
                storeName: 'todos',
                key: '1'
            })
        ).toBeUndefined();
    });

    it('returns immediate-expiry creations without retaining them in memory', async () => {
        const todos = await createAppData(new FakeAppDataRepository()).open('todos', {
            codec: TODO_CODEC,
            ttlMs: 0
        });

        await expect(todos.setIfAbsent('1', () => ({
            title: 'Immediate expiry',
            done: false
        }))).resolves.toEqual({
            title: 'Immediate expiry',
            done: false
        });
        expect(todos.read('1')).toBeUndefined();
    });

    it('rejects persisted values from a different schema version without mutating them', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const repository = new FakeAppDataRepository();
        repository.seed({
            namespace: 'app',
            storeName: 'todos',
            key: 'old-schema',
            value: {
                title: 'Old schema todo',
                done: false
            },
            schemaVersion: 1,
            expireAtTimestamp: Date.now() + 60_000,
            updatedTimestamp: new Date().toISOString(),
            revision: 0
        });
        const appData = createAppData(repository);
        const todos = await appData.open('todos', { codec: TODO_SCHEMA_2_CODEC });

        await expect(todos.get('old-schema')).rejects.toThrow(
            'App data value app/todos/old-schema has schema version 1; expected 2.'
        );
        expect(
            await repository.findEntry({
                namespace: 'app',
                storeName: 'todos',
                key: 'old-schema'
            })
        ).toMatchObject({
            value: {
                title: 'Old schema todo',
                done: false
            },
            schemaVersion: 1,
            revision: 0
        });
    });

    it('rejects malformed current-schema values without replacing the cached value', async () => {
        const repository = new FakeAppDataRepository();
        const todos = await createAppData(repository).open('todos', {
            codec: TODO_CODEC
        });
        await todos.set('1', {
            title: 'Cached value',
            done: false
        });
        repository.seed({
            namespace: 'app',
            storeName: 'todos',
            key: '1',
            value: { title: 'Malformed value' },
            schemaVersion: 1,
            expireAtTimestamp: Date.now() + 60_000,
            updatedTimestamp: new Date().toISOString(),
            revision: 1
        });

        await expect(todos.get('1')).rejects.toThrow(
            'App data value app/todos/1 does not match its current codec.'
        );
        expect(todos.read('1')).toEqual({
            title: 'Cached value',
            done: false
        });
    });

    it('keeps read as memory-only but refreshes get from the repository by default', async () => {
        const repository = new FakeAppDataRepository();
        const left = await createAppData(repository).open('todos', { codec: TODO_CODEC });
        const right = await createAppData(repository).open('todos', { codec: TODO_CODEC });

        await left.set('1', {
            title: 'Initial',
            done: false
        });
        expect(await right.get('1')).toEqual({
            title: 'Initial',
            done: false
        });

        await left.set('1', {
            title: 'Updated elsewhere',
            done: true
        });

        expect(right.read('1')).toEqual({
            title: 'Initial',
            done: false
        });
        expect(await right.get('1')).toEqual({
            title: 'Updated elsewhere',
            done: true
        });
    });

    it('uses cached values when cache-first reads are requested explicitly', async () => {
        const repository = new FakeAppDataRepository();
        const left = await createAppData(repository).open('todos', { codec: TODO_CODEC });
        const right = await createAppData(repository).open('todos', {
            codec: TODO_CODEC,
            readConsistency: 'cache-first'
        });

        await left.set('1', {
            title: 'Initial',
            done: false
        });
        expect(await right.get('1')).toEqual({
            title: 'Initial',
            done: false
        });
        await left.set('1', {
            title: 'Updated elsewhere',
            done: true
        });

        expect(await right.get('1')).toEqual({
            title: 'Initial',
            done: false
        });
    });

    it('does not let compareAndSet overwrite a newer repository revision', async () => {
        const repository = new FakeAppDataRepository();
        const left = await createAppData(repository).open('todos', { codec: TODO_CODEC });
        const right = await createAppData(repository).open('todos', { codec: TODO_CODEC });

        await left.set('1', {
            title: 'Initial',
            done: false
        });
        const expected = await left.get('1');
        await right.set('1', {
            title: 'Updated elsewhere',
            done: true
        });

        await expect(left.compareAndSet('1', expected, {
            title: 'Stale update',
            done: true
        })).resolves.toBe(false);
        expect(await left.get('1')).toEqual({
            title: 'Updated elsewhere',
            done: true
        });
    });

    it('uses insert-if-absent so concurrent creators observe one winner', async () => {
        const repository = new FakeAppDataRepository();
        const left = await createAppData(repository).open('todos', { codec: TODO_CODEC });
        const right = await createAppData(repository).open('todos', { codec: TODO_CODEC });

        const [leftValue, rightValue] = await Promise.all([
            left.setIfAbsent('1', () => ({
                title: 'Left',
                done: false
            })),
            right.setIfAbsent('1', () => ({
                title: 'Right',
                done: false
            }))
        ]);

        expect(leftValue).toEqual(rightValue);
        expect(await left.get('1')).toEqual(leftValue);
    });

    it('hydrates large stores through bounded repository pages', async () => {
        const repository = new FakeAppDataRepository();
        for (let index = 0; index < 1_001; index += 1) {
            repository.seed({
                namespace: 'app',
                storeName: 'todos',
                key: `bulk:${String(index).padStart(4, '0')}`,
                value: {
                    title: `Todo ${index}`,
                    done: false
                },
                schemaVersion: 1,
                expireAtTimestamp: Date.now() + 60_000,
                updatedTimestamp: new Date().toISOString(),
                revision: 0
            });
        }

        const todos = await createAppData(repository).open('todos', {
            codec: TODO_CODEC,
            keyPrefix: 'bulk:'
        });

        await todos.hydrate();

        expect(todos.readEntries()).toHaveLength(1_001);
        expect(repository.findEntriesPageCalls).toBe(2);
        expect(repository.maxRowsReturnedPerFindEntriesPage).toBe(1_000);
    });

    it('retries updateOrCreate after a revision conflict', async () => {
        const repository = new FakeAppDataRepository();
        const counters = await createAppData(repository).open('counters', {
            codec: COUNTER_CODEC
        });

        await counters.set('count', { count: 0 });
        repository.conflictNextUpsertWith({
            namespace: 'app',
            storeName: 'counters',
            key: 'count',
            value: { count: 1 },
            schemaVersion: 1,
            expireAtTimestamp: Date.now() + 60_000
        });

        await expect(
            counters.updateOrCreate('count', (current) => ({
                count: (current?.count ?? 0) + 1
            }))
        ).resolves.toEqual({ count: 2 });
        expect(await counters.get('count')).toEqual({ count: 2 });
    });
});

class FakeAppDataRepository implements AppDataRepository {
    private readonly data = new Map<string, AppDataEntry>();
    private nextUpsertConflict?: AppDataUpsertInput;
    findEntriesPageCalls = 0;
    maxRowsReturnedPerFindEntriesPage = 0;

    seed(entry: AppDataEntry): void {
        this.data.set(
            this.toCompositeKey(entry),
            entry
        );
    }

    conflictNextUpsertWith(input: AppDataUpsertInput): void {
        this.nextUpsertConflict = input;
    }

    async findEntry(input: AppDataKey): Promise<AppDataEntry | undefined> {
        return this.data.get(this.toCompositeKey(input));
    }

    async findEntriesPage(input: AppDataEntryPageInput): Promise<readonly AppDataEntry[]> {
        this.findEntriesPageCalls += 1;
        const rows = this.listEntries(input)
            .filter((entry) => input.afterKey === undefined || entry.key > input.afterKey)
            .slice(0, Math.max(1, Math.floor(input.limit)));
        this.maxRowsReturnedPerFindEntriesPage = Math.max(
            this.maxRowsReturnedPerFindEntriesPage,
            rows.length
        );
        return rows;
    }

    private listEntries(input: AppDataEntryPageInput): readonly AppDataEntry[] {
        return [...this.data.values()]
            .filter((entry) =>
                entry.namespace === input.namespace &&
                entry.storeName === input.storeName &&
                (input.keyPrefix === undefined || entry.key.startsWith(input.keyPrefix))
            )
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async upsert(input: AppDataUpsertInput): Promise<void> {
        this.writeInput(input);
    }

    async insertIfAbsent(
        input: AppDataUpsertInput
    ): Promise<AppDataConditionalInsertResult> {
        const compositeKey = this.toCompositeKey(input);
        const current = this.data.get(compositeKey);
        if (current) {
            return {
                status: 'exists',
                current
            };
        }

        const entry = this.writeInput(input, 0);
        return {
            status: 'inserted',
            entry
        };
    }

    async upsertIfRevision(
        input: AppDataUpsertIfRevisionInput
    ): Promise<AppDataConditionalWriteResult> {
        if (this.nextUpsertConflict) {
            const conflictInput = this.nextUpsertConflict;
            this.nextUpsertConflict = undefined;
            const current = this.writeInput(conflictInput);
            return {
                status: 'conflict',
                current
            };
        }

        const compositeKey = this.toCompositeKey(input);
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== input.expectedRevision) {
            return {
                status: 'conflict',
                current
            };
        }

        const entry = this.writeInput(input, current.revision + 1);
        return {
            status: 'written',
            entry
        };
    }

    async deleteByKey(input: AppDataKey): Promise<boolean> {
        return this.data.delete(this.toCompositeKey(input));
    }

    async deleteIfRevision(input: AppDataDeleteIfRevisionInput): Promise<AppDataConditionalDeleteResult> {
        const compositeKey = this.toCompositeKey(input);
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== input.expectedRevision) {
            return {
                status: 'conflict',
                current
            };
        }

        this.data.delete(compositeKey);
        return {
            status: 'deleted',
            entry: current
        };
    }

    async deleteExpired(input: AppDataDeleteExpiredInput): Promise<number> {
        let removed = 0;
        for (const [key, entry] of this.data.entries()) {
            if (
                entry.namespace === input.namespace &&
                (input.storeName === undefined || entry.storeName === input.storeName) &&
                entry.expireAtTimestamp <= input.expireAtOrBeforeTimestamp
            ) {
                this.data.delete(key);
                removed += 1;
            }
        }

        return removed;
    }

    private toCompositeKey(input: AppDataKey): string {
        return `${input.namespace}:${input.storeName}:${input.key}`;
    }

    private writeInput(input: AppDataUpsertInput, revision?: number): AppDataEntry {
        const compositeKey = this.toCompositeKey(input);
        const current = this.data.get(compositeKey);
        const entry = {
            namespace: input.namespace,
            storeName: input.storeName,
            key: input.key,
            value: input.value,
            schemaVersion: input.schemaVersion,
            expireAtTimestamp: input.expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: revision ?? (current ? current.revision + 1 : 0)
        };
        this.data.set(compositeKey, entry);
        return entry;
    }
}

function createAppData(
    repository: AppDataRepository,
    repositories: RepositoryManager = new RepositoryManager()
): RallarServerAppData {
    return new RallarServerAppData({
        repositories,
        repository,
        nowEpochMs: Date.now
    });
}

function createTodoCodec(schemaVersion: number): AppDataValueCodec<Todo> {
    return {
        schemaVersion,
        encode: (value) => ({
            title: value.title,
            done: value.done
        }),
        decode: decodeTodo
    };
}

function decodeTodo(value: JsonWireValue): Todo {
    if (
        !isJsonWireObject(value) ||
        typeof value.title !== 'string' ||
        typeof value.done !== 'boolean'
    ) {
        throw new TypeError('Todo app data must contain title and done fields.');
    }
    return {
        title: value.title,
        done: value.done
    };
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
