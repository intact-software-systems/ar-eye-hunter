// @vitest-environment happy-dom

import '../../setup-browser-indexeddb.ts';

import { createRallarDataFacade, defineRallarDataStore } from '@shared-web/browser/rallar-data.ts';
import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { ObservableValueEventType } from '@shared/cache/RepositoryInterfaces.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/IndexedDbStringPersistenceProvider.ts';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeBroadcastChannel, resolveTestDataScopeKey, waitFor, type Todo } from './rallar-data-test-runtime.ts';

describe('Rallar data stores', () => {
    const originalBroadcastChannel = globalThis.BroadcastChannel;

    afterEach(() => {
        globalThis.BroadcastChannel = originalBroadcastChannel;
        FakeBroadcastChannel.clear();
    });

    it('stores custom data in memory and IndexedDB', async () => {
        const facade = createRallarFacade();
        const todos = await facade.data.open<Todo>(`todos-${crypto.randomUUID()}`, {
            dbName: `rallar-data-${crypto.randomUUID()}`
        });

        await todos.set('1', { title: 'Implement data stores', done: false });

        expect(todos.read('1')).toEqual({
            title: 'Implement data stores',
            done: false
        });
        expect(await todos.get('1')).toEqual({
            title: 'Implement data stores',
            done: false
        });
        expect(await todos.getEntries()).toEqual([
            ['1', { title: 'Implement data stores', done: false }]
        ]);
    });

    it('rehydrates from IndexedDB after the repository is closed', async () => {
        const data = createRallarDataFacade({
            manager: new RepositoryManager(),
            resolveScopeKey: resolveTestDataScopeKey
        });
        const definition = data.define<Todo>(`todos-${crypto.randomUUID()}`, {
            dbName: `rallar-data-${crypto.randomUUID()}`
        });

        const first = await data.open(definition);
        await first.set('1', { title: 'Persist me', done: true });

        expect(await data.close(definition)).toBe(true);

        const second = await data.open(definition);
        expect(second.read('1')).toEqual({
            title: 'Persist me',
            done: true
        });
    });

    it('keeps stores with the same item key isolated by store definition', async () => {
        const data = createRallarDataFacade({
            manager: new RepositoryManager(),
            resolveScopeKey: resolveTestDataScopeKey
        });
        const dbName = `rallar-data-${crypto.randomUUID()}`;
        const firstDefinition = defineRallarDataStore<Todo>('first', { dbName });
        const secondDefinition = defineRallarDataStore<Todo>('second', { dbName });

        const first = await data.open(firstDefinition);
        const second = await data.open(secondDefinition);

        await first.set('shared-key', { title: 'First', done: false });
        await second.set('shared-key', { title: 'Second', done: true });

        expect(await first.get('shared-key')).toEqual({
            title: 'First',
            done: false
        });
        expect(await second.get('shared-key')).toEqual({
            title: 'Second',
            done: true
        });
    });

    it('uses RepositoryManager lookup for opened stores', async () => {
        const manager = new RepositoryManager();
        const data = createRallarDataFacade({
            manager,
            resolveScopeKey: resolveTestDataScopeKey
        });
        const definition = data.define<Todo>(`todos-${crypto.randomUUID()}`, {
            dbName: `rallar-data-${crypto.randomUUID()}`,
            hydrate: 'lazy'
        });

        expect(data.lookup(definition)).toBeUndefined();

        const opened = await data.open(definition);
        const lookedUp = data.lookup<Todo>(definition);

        expect(lookedUp?.repositoryId).toBe(opened.repositoryId);
        expect(manager.has(opened.repositoryId)).toBe(true);
    });

    it('notifies listeners when custom data changes', async () => {
        const data = createRallarDataFacade({
            manager: new RepositoryManager(),
            resolveScopeKey: resolveTestDataScopeKey
        });
        const store = await data.open<Todo>(`todos-${crypto.randomUUID()}`, {
            dbName: `rallar-data-${crypto.randomUUID()}`
        });
        const events: Array<readonly [string, ObservableValueEventType]> = [];

        const unsubscribe = store.onChange((event) => {
            events.push([event.key, event.type]);
        });

        await store.set('1', { title: 'Notify me', done: false });
        await store.set('1', { title: 'Notify me again', done: false });
        await store.whenIdle();
        unsubscribe();

        expect(events).toEqual([
            ['1', ObservableValueEventType.Created],
            ['1', ObservableValueEventType.Updated]
        ]);
    });

    it('rejects empty store names', () => {
        expect(() => defineRallarDataStore('')).toThrow(
            'Rallar data store name is required.'
        );
    });

    it('migrates legacy custom data into the current schema on read', async () => {
        const dbName = `rallar-data-${crypto.randomUUID()}`;
        const storeName = `todos-${crypto.randomUUID()}`;
        const rawProvider = new IndexedDbStringPersistenceProvider<unknown>({
            dbName,
            keyPrefix: `custom:app:${encodeURIComponent(storeName)}`
        });
        await rawProvider.setItem(
            'legacy',
            { text: 'Migrated todo' },
            { expireAtTimestamp: Date.now() + 60_000 }
        );

        const data = createRallarDataFacade({
            manager: new RepositoryManager(),
            resolveScopeKey: resolveTestDataScopeKey
        });
        const store = await data.open<Todo>(storeName, {
            dbName,
            schemaVersion: 2,
            migrate: (value, context) => {
                expect(context).toMatchObject({
                    key: 'legacy',
                    fromVersion: 0,
                    toVersion: 2
                });
                const legacy = value as { text: string; };
                return {
                    title: legacy.text,
                    done: false
                };
            }
        });

        expect(store.read('legacy')).toEqual({
            title: 'Migrated todo',
            done: false
        });
    });

    it('rejects opening the same store identity with incompatible options', async () => {
        const data = createRallarDataFacade({
            manager: new RepositoryManager(),
            resolveScopeKey: resolveTestDataScopeKey
        });
        const dbName = `rallar-data-${crypto.randomUUID()}`;
        const storeName = `todos-${crypto.randomUUID()}`;

        await data.open<Todo>(storeName, {
            dbName,
            schemaVersion: 1
        });

        await expect(
            data.open<Todo>(storeName, {
                dbName,
                schemaVersion: 2
            })
        ).rejects.toThrow(
            'Rallar data store already opened with different options'
        );
    });

    it('synchronizes changes across facades with BroadcastChannel', async () => {
        globalThis.BroadcastChannel = FakeBroadcastChannel as never;

        const dbName = `rallar-data-${crypto.randomUUID()}`;
        const definition = defineRallarDataStore<Todo>(
            `todos-${crypto.randomUUID()}`,
            { dbName }
        );
        const first = await createRallarDataFacade({
            manager: new RepositoryManager(),
            resolveScopeKey: resolveTestDataScopeKey
        }).open(definition);
        const second = await createRallarDataFacade({
            manager: new RepositoryManager(),
            resolveScopeKey: resolveTestDataScopeKey
        }).open(definition);

        await first.set('1', { title: 'Synced', done: false });
        await waitFor(() => second.read('1') !== undefined);

        expect(second.read('1')).toEqual({
            title: 'Synced',
            done: false
        });

        await first.delete('1');
        await waitFor(() => second.read('1') === undefined);

        expect(second.read('1')).toBeUndefined();
    });

    it('closes only repositories in the requested data scope', async () => {
        const data = createRallarDataFacade({
            manager: new RepositoryManager(),
            resolveScopeKey: (scope) => scope === 'principal' ? 'principal:user-1' : String(scope)
        });
        const dbName = `rallar-data-${crypto.randomUUID()}`;

        const appStore = await data.open<Todo>('app-data', {
            dbName,
            scope: 'app'
        });
        const principalStore = await data.open<Todo>('principal-data', {
            dbName,
            scope: 'principal'
        });

        expect(await data.closeScope('principal')).toBe(1);

        expect(
            data.lookup<Todo>('principal-data', {
                dbName,
                scope: 'principal'
            })
        ).toBeUndefined();
        expect(
            data.lookup<Todo>('app-data', {
                dbName,
                scope: 'app'
            })?.repositoryId
        ).toBe(appStore.repositoryId);
        expect(await appStore.close()).toBe(true);
        expect(await principalStore.close()).toBe(false);
    });

    it('deletes disk-only write-behind entries without requiring manual hydration', async () => {
        const data = createRallarDataFacade({
            manager: new RepositoryManager(),
            resolveScopeKey: resolveTestDataScopeKey
        });
        const definition = data.define<Todo>(`todos-${crypto.randomUUID()}`, {
            dbName: `rallar-data-${crypto.randomUUID()}`,
            durability: 'write-behind'
        });

        const writer = await data.open(definition);
        await writer.set('1', { title: 'Disk only', done: false });
        await writer.flush();
        await writer.close();

        const lazyReader = await data.open(definition, { hydrate: 'lazy' });
        expect(lazyReader.read('1')).toBeUndefined();
        expect(await lazyReader.delete('1')).toBe(true);
        await lazyReader.close();

        const verifier = await data.open(definition);
        expect(verifier.read('1')).toBeUndefined();
    });

    it('supports convenience and maintenance operations', async () => {
        const data = createRallarDataFacade({
            manager: new RepositoryManager(),
            resolveScopeKey: resolveTestDataScopeKey
        });
        const dbName = `rallar-data-${crypto.randomUUID()}`;
        const store = await data.open<Todo>(`todos-${crypto.randomUUID()}`, {
            dbName
        });

        expect(
            await store.setIfAbsent('1', () => ({
                title: 'Initial',
                done: false
            }))
        ).toEqual({
            title: 'Initial',
            done: false
        });
        expect(
            await store.setIfAbsent('1', () => ({
                title: 'Ignored',
                done: false
            }))
        ).toEqual({
            title: 'Initial',
            done: false
        });
        expect(
            await store.update('1', (current) => ({
                ...current,
                done: true
            }))
        ).toEqual({
            title: 'Initial',
            done: true
        });
        expect(
            await store.updateOrCreate('2', () => ({
                title: 'Created',
                done: false
            }))
        ).toEqual({
            title: 'Created',
            done: false
        });
        expect(
            await store.compareAndSet(
                '2',
                { title: 'Created', done: false },
                { title: 'Will not match', done: true }
            )
        ).toBe(false);
        expect(
            await store.compareAndSet('2', await store.get('2'), {
                title: 'Matched',
                done: true
            })
        ).toBe(true);
        expect(
            await store.getAndSet('2', {
                title: 'Replaced',
                done: false
            })
        ).toEqual({
            title: 'Matched',
            done: true
        });

        expect(await store.listKeys()).toEqual(['1', '2']);
        expect(await store.exportData()).toEqual({
            '1': { title: 'Initial', done: true },
            '2': { title: 'Replaced', done: false }
        });
        expect(await store.estimateUsage()).toEqual(expect.any(Object));

        await store.clear();
        expect(await store.getAll()).toEqual([]);

        await store.set('3', { title: 'Destroy me', done: false });
        await store.destroy();
        expect(
            data.lookup<Todo>(store.name, {
                dbName
            })
        ).toBeUndefined();

        const reopened = await data.open<Todo>(store.name, { dbName });
        expect(await reopened.getAll()).toEqual([]);
    });
});
