import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type {
    AppDataConditionalDeleteResult,
    AppDataConditionalInsertResult,
    AppDataConditionalRepositoryLike,
    AppDataConditionalWriteResult,
    AppDataEntryPageOptions,
    AppDataEntry,
    AppDataUpsertInput,
    AppDataUpsertIfRevisionInput,
} from '@shared-server/app-data/AppDataRepository.ts';
import { createRallarServerApplication } from '@shared-server/rallar-facade/RallarServerApplication.ts';
import { RallarServerDataFacade } from '@shared-server/rallar-facade/RallarServer.ts';

type Todo = Readonly<{
    title: string;
    done: boolean;
}>;

describe('Rallar server app data stores', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('requires an app data repository before opening stores', async () => {
        const facade = new RallarServerDataFacade(new RepositoryManager());

        await expect(facade.open<Todo>('todos')).rejects.toThrow(
            'Rallar server app data repository is not configured.',
        );
    });

    it('stores custom data in memory and through the repository', async () => {
        const repository = new FakeAppDataRepository();
        const manager = new RepositoryManager();
        const facade = new RallarServerDataFacade(manager, repository);
        const todos = await facade.open<Todo>('todos');

        await todos.set('1', {
            title: 'Implement server data stores',
            done: false,
        });

        expect(todos.read('1')).toEqual({
            title: 'Implement server data stores',
            done: false,
        });
        expect(await todos.get('1')).toEqual({
            title: 'Implement server data stores',
            done: false,
        });
        expect(await todos.getEntries()).toEqual([
            ['1', {
                title: 'Implement server data stores',
                done: false,
            }],
        ]);
        expect(facade.lookupStore<Todo>('todos')?.repositoryId).toBe(
            todos.repositoryId,
        );
        expect(manager.has(todos.repositoryId)).toBe(true);
    });

    it('reuses opened stores and keeps key prefixes isolated', async () => {
        const facade = new RallarServerDataFacade(
            new RepositoryManager(),
            new FakeAppDataRepository(),
        );
        const todos = await facade.open<Todo>('todos', {
            schemaVersion: 1,
        });

        expect(
            (await facade.open<Todo>('todos', { schemaVersion: 1 })).repositoryId,
        ).toBe(todos.repositoryId);
        await expect(
            facade.open<Todo>('todos', {
                schemaVersion: 2,
            }),
        ).rejects.toThrow(
            'Rallar server app data store already opened with different options',
        );

        const archived = await facade.open<Todo>('todos', {
            keyPrefix: 'archived:',
            schemaVersion: 1,
        });

        expect(archived.repositoryId).not.toBe(todos.repositoryId);
    });

    it('evicts expired repository entries lazily on read-through', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const repository = new FakeAppDataRepository();
        const facade = new RallarServerDataFacade(
            new RepositoryManager(),
            repository,
        );
        const todos = await facade.open<Todo>('todos', {
            ttlMs: 1_000,
        });

        await todos.set('1', {
            title: 'Temporary',
            done: false,
        });
        vi.setSystemTime(new Date('2026-01-01T00:00:01.001Z'));

        expect(todos.read('1')).toBeUndefined();
        expect(await todos.get('1')).toBeUndefined();
        expect(await repository.findEntry('app', 'todos', '1')).toBeUndefined();
    });

    it('migrates legacy values with a lightweight callback and persists the result', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const repository = new FakeAppDataRepository();
        repository.seed({
            namespace: 'app',
            storeName: 'todos',
            key: 'legacy',
            value: {
                text: 'Migrated todo',
            },
            schemaVersion: 1,
            expireAtTimestamp: Date.now() + 60_000,
            updatedTimestamp: new Date().toISOString(),
            revision: 0,
        });
        const facade = new RallarServerDataFacade(
            new RepositoryManager(),
            repository,
        );
        const todos = await facade.open<Todo>('todos', {
            schemaVersion: 2,
            migrate: (value, context) => {
                expect(context).toMatchObject({
                    key: 'legacy',
                    fromVersion: 1,
                    toVersion: 2,
                });
                return {
                    title: (value as { text: string }).text,
                    done: false,
                };
            },
        });

        expect(await todos.get('legacy')).toEqual({
            title: 'Migrated todo',
            done: false,
        });
        expect(await repository.findEntry('app', 'todos', 'legacy')).toMatchObject({
            value: {
                title: 'Migrated todo',
                done: false,
            },
            schemaVersion: 2,
            revision: 1,
        });
    });

    it('propagates app data repositories through server applications', async () => {
        const repository = new FakeAppDataRepository();
        const runtime = {
            wsQBoxServerService: {
                name: 'server-1',
                onAnyInboxMessageDo: vi.fn().mockReturnThis(),
                removeAnyInboxMessageCallback: vi.fn(),
            } as unknown as WsQueueBoxServerService,
        };
        const server = createRallarServerApplication<
            typeof runtime,
            Record<string, never>
        >({
            runtime,
            appData: {
                repository,
            },
        });
        const todos = await server.data.open<Todo>('todos');

        await todos.set('1', {
            title: 'From application facade',
            done: true,
        });

        expect(await repository.findEntry('app', 'todos', '1')).toMatchObject({
            value: {
                title: 'From application facade',
                done: true,
            },
        });
    });

    it('keeps read as memory-only but refreshes get from the repository by default', async () => {
        const repository = new FakeAppDataRepository();
        const left = await new RallarServerDataFacade(
            new RepositoryManager(),
            repository,
        ).open<Todo>('todos');
        const right = await new RallarServerDataFacade(
            new RepositoryManager(),
            repository,
        ).open<Todo>('todos');

        await left.set('1', {
            title: 'Initial',
            done: false,
        });
        expect(await right.get('1')).toEqual({
            title: 'Initial',
            done: false,
        });

        await left.set('1', {
            title: 'Updated elsewhere',
            done: true,
        });

        expect(right.read('1')).toEqual({
            title: 'Initial',
            done: false,
        });
        expect(await right.get('1')).toEqual({
            title: 'Updated elsewhere',
            done: true,
        });
    });

    it('allows cache-first server reads as an explicit compatibility mode', async () => {
        const repository = new FakeAppDataRepository();
        const left = await new RallarServerDataFacade(
            new RepositoryManager(),
            repository,
        ).open<Todo>('todos');
        const right = await new RallarServerDataFacade(
            new RepositoryManager(),
            repository,
        ).open<Todo>('todos', {
            readConsistency: 'cache-first',
        });

        await left.set('1', {
            title: 'Initial',
            done: false,
        });
        expect(await right.get('1')).toEqual({
            title: 'Initial',
            done: false,
        });
        await left.set('1', {
            title: 'Updated elsewhere',
            done: true,
        });

        expect(await right.get('1')).toEqual({
            title: 'Initial',
            done: false,
        });
    });

    it('does not let compareAndSet overwrite a newer repository revision', async () => {
        const repository = new FakeAppDataRepository();
        const left = await new RallarServerDataFacade(
            new RepositoryManager(),
            repository,
        ).open<Todo>('todos');
        const right = await new RallarServerDataFacade(
            new RepositoryManager(),
            repository,
        ).open<Todo>('todos');

        await left.set('1', {
            title: 'Initial',
            done: false,
        });
        const expected = await left.get('1');
        await right.set('1', {
            title: 'Updated elsewhere',
            done: true,
        });

        await expect(left.compareAndSet('1', expected, {
            title: 'Stale update',
            done: true,
        })).resolves.toBe(false);
        expect(await left.get('1')).toEqual({
            title: 'Updated elsewhere',
            done: true,
        });
    });

    it('uses insert-if-absent so concurrent creators observe one winner', async () => {
        const repository = new FakeAppDataRepository();
        const left = await new RallarServerDataFacade(
            new RepositoryManager(),
            repository,
        ).open<Todo>('todos');
        const right = await new RallarServerDataFacade(
            new RepositoryManager(),
            repository,
        ).open<Todo>('todos');

        const [leftValue, rightValue] = await Promise.all([
            left.setIfAbsent('1', () => ({
                title: 'Left',
                done: false,
            })),
            right.setIfAbsent('1', () => ({
                title: 'Right',
                done: false,
            })),
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
                    done: false,
                },
                schemaVersion: 1,
                expireAtTimestamp: Date.now() + 60_000,
                updatedTimestamp: new Date().toISOString(),
                revision: 0,
            });
        }

        const todos = await new RallarServerDataFacade(
            new RepositoryManager(),
            repository,
        ).open<Todo>('todos', {
            keyPrefix: 'bulk:',
        });

        await todos.hydrate();

        expect(todos.readEntries()).toHaveLength(1_001);
        expect(repository.findEntriesCalls).toBe(0);
        expect(repository.findEntriesPageCalls).toBe(2);
        expect(repository.maxRowsReturnedPerFindEntriesPage).toBe(1_000);
    });

    it('retries updateOrCreate after a revision conflict', async () => {
        const repository = new FakeAppDataRepository();
        const counters = await new RallarServerDataFacade(
            new RepositoryManager(),
            repository,
        ).open<{ count: number }>('counters');

        await counters.set('count', { count: 0 });
        repository.conflictNextUpsertWith({
            namespace: 'app',
            storeName: 'counters',
            key: 'count',
            value: { count: 1 },
            schemaVersion: 1,
            expireAtTimestamp: Date.now() + 60_000,
        });

        await expect(
            counters.updateOrCreate('count', (current) => ({
                count: (current?.count ?? 0) + 1,
            })),
        ).resolves.toEqual({ count: 2 });
        expect(await counters.get('count')).toEqual({ count: 2 });
    });
});

class FakeAppDataRepository implements AppDataConditionalRepositoryLike {
    private readonly data = new Map<string, AppDataEntry>();
    private nextUpsertConflict?: AppDataUpsertInput;
    findEntriesCalls = 0;
    findEntriesPageCalls = 0;
    maxRowsReturnedPerFindEntriesPage = 0;

    seed(entry: AppDataEntry): void {
        this.data.set(
            this.toCompositeKey(entry.namespace, entry.storeName, entry.key),
            entry,
        );
    }

    conflictNextUpsertWith(input: AppDataUpsertInput): void {
        this.nextUpsertConflict = input;
    }

    async findEntry(
        namespace: string,
        storeName: string,
        key: string,
    ): Promise<AppDataEntry | undefined> {
        return this.data.get(this.toCompositeKey(namespace, storeName, key));
    }

    async findEntries(
        namespace: string,
        storeName: string,
        keyPrefix?: string,
    ): Promise<readonly AppDataEntry[]> {
        this.findEntriesCalls += 1;
        return this.listEntries(namespace, storeName, keyPrefix);
    }

    async findEntriesPage(
        namespace: string,
        storeName: string,
        options: AppDataEntryPageOptions,
    ): Promise<readonly AppDataEntry[]> {
        this.findEntriesPageCalls += 1;
        const rows = this.listEntries(namespace, storeName, options.keyPrefix)
            .filter((entry) =>
                options.afterKey === undefined || entry.key > options.afterKey
            )
            .slice(0, Math.max(1, Math.floor(options.limit)));
        this.maxRowsReturnedPerFindEntriesPage = Math.max(
            this.maxRowsReturnedPerFindEntriesPage,
            rows.length,
        );
        return rows;
    }

    private listEntries(
        namespace: string,
        storeName: string,
        keyPrefix?: string,
    ): readonly AppDataEntry[] {
        return [...this.data.values()]
            .filter((entry) =>
                entry.namespace === namespace &&
                entry.storeName === storeName &&
                (keyPrefix === undefined || entry.key.startsWith(keyPrefix))
            )
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async upsert(input: AppDataUpsertInput): Promise<void> {
        this.writeInput(input);
    }

    async insertIfAbsent<V = unknown>(
        input: AppDataUpsertInput<V>,
    ): Promise<AppDataConditionalInsertResult<V>> {
        const compositeKey = this.toCompositeKey(
            input.namespace,
            input.storeName,
            input.key,
        );
        const current = this.data.get(compositeKey);
        if (current) {
            return {
                status: 'exists',
                current: current as AppDataEntry<V>,
            };
        }

        const entry = this.writeInput(input, 0);
        return {
            status: 'inserted',
            entry: entry as AppDataEntry<V>,
        };
    }

    async upsertIfRevision<V = unknown>(
        input: AppDataUpsertIfRevisionInput<V>,
    ): Promise<AppDataConditionalWriteResult<V>> {
        if (this.nextUpsertConflict) {
            const conflictInput = this.nextUpsertConflict;
            this.nextUpsertConflict = undefined;
            const current = this.writeInput(conflictInput);
            return {
                status: 'conflict',
                current: current as AppDataEntry<V>,
            };
        }

        const compositeKey = this.toCompositeKey(
            input.namespace,
            input.storeName,
            input.key,
        );
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== input.expectedRevision) {
            return {
                status: 'conflict',
                current: current as AppDataEntry<V> | undefined,
            };
        }

        const entry = this.writeInput(input, current.revision + 1);
        return {
            status: 'written',
            entry: entry as AppDataEntry<V>,
        };
    }

    async deleteByKey(
        namespace: string,
        storeName: string,
        key: string,
    ): Promise<boolean> {
        return this.data.delete(this.toCompositeKey(namespace, storeName, key));
    }

    async deleteIfRevision(
        namespace: string,
        storeName: string,
        key: string,
        expectedRevision: number,
    ): Promise<AppDataConditionalDeleteResult> {
        const compositeKey = this.toCompositeKey(namespace, storeName, key);
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== expectedRevision) {
            return {
                status: 'conflict',
                current,
            };
        }

        this.data.delete(compositeKey);
        return {
            status: 'deleted',
            entry: current,
        };
    }

    async deleteExpired(namespace: string, storeName?: string): Promise<number> {
        let removed = 0;
        for (const [key, entry] of this.data.entries()) {
            if (
                entry.namespace === namespace &&
                (storeName === undefined || entry.storeName === storeName) &&
                entry.expireAtTimestamp <= Date.now()
            ) {
                this.data.delete(key);
                removed += 1;
            }
        }

        return removed;
    }

    private toCompositeKey(namespace: string, storeName: string, key: string): string {
        return `${namespace}:${storeName}:${key}`;
    }

    private writeInput(input: AppDataUpsertInput, revision?: number): AppDataEntry {
        const compositeKey = this.toCompositeKey(
            input.namespace,
            input.storeName,
            input.key,
        );
        const current = this.data.get(compositeKey);
        const entry = {
            namespace: input.namespace,
            storeName: input.storeName,
            key: input.key,
            value: input.value,
            schemaVersion: input.schemaVersion,
            expireAtTimestamp: input.expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: revision ?? (current ? current.revision + 1 : 0),
        };
        this.data.set(compositeKey, entry);
        return entry;
    }
}
