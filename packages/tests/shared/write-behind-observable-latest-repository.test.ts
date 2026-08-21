import { ObservableValueEventType, type ObservableKeyedValueEvent } from '@shared/cache/RepositoryInterfaces.ts';
import { WriteBehindObservableLatestRepository } from '@shared/cache/WriteBehindObservableLatestRepository.ts';
import {
    InMemoryPersistenceProvider,
    NEVER_EXPIRE_AT_TIMESTAMP,
    type PersistenceProvider,
    type PersistenceSetItemOptions
} from '@shared/persistence/PersistenceProvider.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Versioned = Readonly<{ version: number; payload: string; }>;

describe('WriteBehindObservableLatestRepository', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('hydrates RAM from persistence and serves reads from memory', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>([
            ['a', 1],
            ['b', 2]
        ]);
        const repository = new WriteBehindObservableLatestRepository<string, number>({
            persistence
        });

        await repository.hydrate();

        expect(repository.read('a')).toBe(1);
        expect(repository.read('b')).toBe(2);
        expect(repository.readAllValues().sort()).toEqual([1, 2]);
    });

    it('does not mirror hydration writes back to disk', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>([
            ['a', 1]
        ]);
        const setItem = vi.spyOn(persistence, 'setItem');
        const repository = new WriteBehindObservableLatestRepository<string, number>({
            persistence
        });

        await repository.hydrate();
        await repository.whenIdle();

        expect(setItem).not.toHaveBeenCalled();
    });

    it('mirrors created and updated writes to persistence', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>();
        const repository = new WriteBehindObservableLatestRepository<string, number>({
            persistence
        });

        await repository.hydrate();

        repository.set('a', 1);
        repository.set('a', 2);
        await repository.whenIdle();

        expect(await persistence.getItem('a')).toBe(2);
        expect(await persistence.getAllKeys()).toEqual(['a']);
    });

    it('skips persistence writes for refreshed events', async () => {
        const persistence = new InMemoryPersistenceProvider<string, Versioned>();
        const setItem = vi.spyOn(persistence, 'setItem');
        const repository = new WriteBehindObservableLatestRepository<string, Versioned>({
            persistence,
            equals: (left, right) => left.version === right.version
        });

        await repository.hydrate();

        repository.set('item', { version: 1, payload: 'A' });
        repository.set('item', { version: 1, payload: 'B' });
        repository.set('item', { version: 2, payload: 'B' });
        await repository.whenIdle();

        // Created + Updated: two writes.
        // The equality predicate classifies the v1->v1 write as Refreshed: skipped.
        expect(setItem).toHaveBeenCalledTimes(2);
        expect((await persistence.getItem('item'))?.payload).toBe('B');
    });

    it('mirrors deletes via removeItem and clearAll wipes disk', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>();
        const repository = new WriteBehindObservableLatestRepository<string, number>({
            persistence
        });

        await repository.hydrate();

        repository.set('a', 1);
        repository.set('b', 2);
        repository.set('c', 3);
        await repository.whenIdle();

        expect(repository.delete('a')).toBe(true);
        await repository.whenIdle();
        expect(await persistence.getAllKeys()).toEqual(['b', 'c']);

        repository.clearAll();
        await repository.whenIdle();
        expect(await persistence.getAllKeys()).toEqual([]);
    });

    it('survives a round trip: write, dispose, rehydrate restores the same data', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>();
        const writer = new WriteBehindObservableLatestRepository<string, number>({
            persistence
        });
        await writer.hydrate();

        writer.set('a', 1);
        writer.set('b', 2);
        await writer.dispose();

        const reader = new WriteBehindObservableLatestRepository<string, number>({
            persistence
        });
        await reader.hydrate();

        expect(reader.read('a')).toBe(1);
        expect(reader.read('b')).toBe(2);
    });

    it('routes persistence failures to the configured error handler', async () => {
        const failures: Array<ObservableKeyedValueEvent<string, number>> = [];
        const failingPersistence: PersistenceProvider<string, number> = {
            getAllKeys: async () => [],
            getItem: async () => undefined,
            setItem: () => Promise.reject(new Error('boom')),
            removeItem: async () => {
            },
            deleteExpired: async () => 0
        };

        const repository = new WriteBehindObservableLatestRepository<string, number>({
            persistence: failingPersistence,
            onPersistenceError: (_error, event) => {
                failures.push(event);
            }
        });

        await repository.hydrate();

        repository.set('a', 1);
        repository.set('a', 2);
        await repository.whenIdle();

        expect(failures.map((e) => [e.key, e.type])).toEqual([
            ['a', ObservableValueEventType.Created],
            ['a', ObservableValueEventType.Updated]
        ]);
    });

    it('translates ttlMs into an absolute disk expiry by default', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const captured: PersistenceSetItemOptions[] = [];
        const persistence: PersistenceProvider<string, number> = {
            getAllKeys: async () => [],
            getItem: async () => undefined,
            setItem: async (_key, _value, options) => {
                captured.push(options);
            },
            removeItem: async () => {
            },
            deleteExpired: async () => 0
        };

        const repository = new WriteBehindObservableLatestRepository<string, number>({
            persistence,
            ttlMs: 5_000
        });
        await repository.hydrate();

        repository.set('a', 1);
        await repository.whenIdle();

        expect(captured).toHaveLength(1);
        expect(captured[0]?.expireAtTimestamp).toBe(Date.parse('2026-01-01T00:00:05.000Z'));
    });

    it('uses a custom expireAtFor when provided', async () => {
        const captured: PersistenceSetItemOptions[] = [];
        const persistence: PersistenceProvider<string, Versioned> = {
            getAllKeys: async () => [],
            getItem: async () => undefined,
            setItem: async (_key, _value, options) => {
                captured.push(options);
            },
            removeItem: async () => {
            },
            deleteExpired: async () => 0
        };

        const repository = new WriteBehindObservableLatestRepository<string, Versioned>({
            persistence,
            expireAtFor: () => NEVER_EXPIRE_AT_TIMESTAMP
        });
        await repository.hydrate();

        repository.set('item', { version: 1, payload: 'A' });
        await repository.whenIdle();

        expect(captured[0]?.expireAtTimestamp).toBe(NEVER_EXPIRE_AT_TIMESTAMP);
    });

    it('dispose stops mirroring further events', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>();
        const setItem = vi.spyOn(persistence, 'setItem');
        const repository = new WriteBehindObservableLatestRepository<string, number>({
            persistence
        });

        await repository.hydrate();
        repository.set('a', 1);
        await repository.whenIdle();
        expect(setItem).toHaveBeenCalledTimes(1);

        await repository.dispose();
        repository.set('a', 2);
        await repository.whenIdle();

        expect(setItem).toHaveBeenCalledTimes(1);
        expect(await persistence.getItem('a')).toBe(1);
    });

    it('whenIdle drains both observer queue and pending persistence writes', async () => {
        const events: string[] = [];
        const persistence: PersistenceProvider<string, number> = {
            getAllKeys: async () => [],
            getItem: async () => undefined,
            setItem: async () => {
                events.push('setItem-resolved');
            },
            removeItem: async () => {
            },
            deleteExpired: async () => 0
        };
        const repository = new WriteBehindObservableLatestRepository<string, number>({
            persistence
        });

        await repository.hydrate();

        repository.set('a', 1);
        repository.set('b', 2);
        events.push('whenIdle-started');
        await repository.whenIdle();
        events.push('whenIdle-returned');

        expect(events).toEqual([
            'whenIdle-started',
            'setItem-resolved',
            'setItem-resolved',
            'whenIdle-returned'
        ]);
    });
});
