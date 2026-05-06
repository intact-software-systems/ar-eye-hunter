import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type {
    AppDataEntry,
    AppDataRepositoryLike,
    AppDataUpsertInput,
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
});

class FakeAppDataRepository implements AppDataRepositoryLike {
    private readonly data = new Map<string, AppDataEntry>();

    seed(entry: AppDataEntry): void {
        this.data.set(
            this.toCompositeKey(entry.namespace, entry.storeName, entry.key),
            entry,
        );
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
        return [...this.data.values()]
            .filter((entry) =>
                entry.namespace === namespace &&
                entry.storeName === storeName &&
                (keyPrefix === undefined || entry.key.startsWith(keyPrefix))
            )
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async upsert(input: AppDataUpsertInput): Promise<void> {
        const compositeKey = this.toCompositeKey(
            input.namespace,
            input.storeName,
            input.key,
        );
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            namespace: input.namespace,
            storeName: input.storeName,
            key: input.key,
            value: input.value,
            schemaVersion: input.schemaVersion,
            expireAtTimestamp: input.expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current ? current.revision + 1 : 0,
        });
    }

    async deleteByKey(
        namespace: string,
        storeName: string,
        key: string,
    ): Promise<boolean> {
        return this.data.delete(this.toCompositeKey(namespace, storeName, key));
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
}
