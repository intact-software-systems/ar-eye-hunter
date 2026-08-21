import { ObservableValueEventType } from '@shared/cache/RepositoryInterfaces.ts';
import { WriteThroughObservableLatestRepository } from '@shared/cache/WriteThroughObservableLatestRepository.ts';
import {
    InMemoryPersistenceProvider,
    NEVER_EXPIRE_AT_TIMESTAMP,
    type PersistenceProvider,
    type PersistenceSetItemOptions
} from '@shared/persistence/PersistenceProvider.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('WriteThroughObservableLatestRepository', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('writes to disk before updating memory and firing observer events', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>();
        const originalSetItem = persistence.setItem.bind(persistence);
        const setItem = vi.spyOn(persistence, 'setItem');
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });
        const events: string[] = [];
        repository.onChangeDo((event) => {
            events.push(`event-${event.type}`);
        });

        // Slow down the disk write so we can observe ordering mid-flight.
        let resolvePersist: (() => void) | undefined;
        const persistStarted = new Promise<void>((started) => {
            setItem.mockImplementationOnce((key, value, opts) => {
                started();
                return new Promise<void>((resolve, reject) => {
                    resolvePersist = () => {
                        originalSetItem(key, value, opts).then(resolve, reject);
                    };
                });
            });
        });

        const setPromise = repository.set('a', 1);
        await persistStarted; // disk write is in flight
        expect(repository.read('a')).toBeUndefined();

        resolvePersist!();
        await setPromise;
        await repository.whenIdle();

        expect(repository.read('a')).toBe(1);
        expect(await persistence.getItem('a')).toBe(1);
        expect(events).toEqual(['event-created']);
    });

    it('does not let an in-flight hydrate overwrite a concurrent write', async () => {
        let resolveHydrateRead: ((value: number | undefined) => void) | undefined;
        let markHydrateReadStarted: (() => void) | undefined;
        const hydrateReadStarted = new Promise<void>((resolve) => {
            markHydrateReadStarted = resolve;
        });
        const persistence = {
            getAllKeys: async () => ['a'],
            getItem: async () => {
                markHydrateReadStarted!();
                return await new Promise<number | undefined>((resolveRead) => {
                    resolveHydrateRead = resolveRead;
                });
            },
            setItem: async () => {
            },
            removeItem: async () => {
            },
            deleteExpired: async () => 0
        } satisfies PersistenceProvider<string, number>;
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });

        const hydratePromise = repository.hydrate();

        await hydrateReadStarted;
        const setPromise = repository.set('a', 2);
        resolveHydrateRead!(1);

        await hydratePromise;
        await setPromise;

        expect(repository.read('a')).toBe(2);
    });

    it('rolls forward: the resolved promise guarantees disk durability', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>();
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });

        await repository.accept('a', 42);

        // After the promise resolves, the value must be persisted.
        expect(await persistence.getItem('a')).toBe(42);
    });

    it('serializes concurrent writes in submission order', async () => {
        const order: number[] = [];
        const persistence: PersistenceProvider<string, number> = {
            getAllKeys: async () => [],
            getItem: async () => undefined,
            setItem: async (_key, value, _opts) => {
                await Promise.resolve(); // simulate async work
                order.push(value);
            },
            removeItem: async () => {
            },
            deleteExpired: async () => 0
        };
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });

        await Promise.all([
            repository.set('a', 1),
            repository.set('a', 2),
            repository.set('a', 3)
        ]);

        expect(order).toEqual([1, 2, 3]);
        expect(repository.read('a')).toBe(3);
    });

    it('rejection on write does not break the chain for subsequent writes', async () => {
        const setItem = vi.fn<PersistenceProvider<string, number>['setItem']>();
        setItem
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce(undefined);

        const persistence: PersistenceProvider<string, number> = {
            getAllKeys: async () => [],
            getItem: async () => undefined,
            setItem,
            removeItem: async () => {
            },
            deleteExpired: async () => 0
        };
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });

        await repository.set('a', 1);
        await expect(repository.set('a', 2)).rejects.toThrow('boom');
        await repository.set('a', 3);

        expect(repository.read('a')).toBe(3);
        expect(setItem).toHaveBeenCalledTimes(3);
    });

    it('get returns RAM hit without touching disk', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>();
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });
        await repository.set('a', 1);

        const getItem = vi.spyOn(persistence, 'getItem');
        expect(await repository.get('a')).toBe(1);
        expect(getItem).not.toHaveBeenCalled();
    });

    it('get falls back to disk on cache miss and populates RAM', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>([
            ['a', 7]
        ]);
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });
        const events: ObservableValueEventType[] = [];
        repository.onChangeDo((event) => {
            events.push(event.type);
        });

        // RAM is cold; disk has 'a'.
        expect(repository.read('a')).toBeUndefined();
        expect(await repository.get('a')).toBe(7);
        await repository.whenIdle();

        // RAM now warm.
        expect(repository.read('a')).toBe(7);

        // Cache-fill fires a Created event (real cache state transition).
        expect(events).toEqual([ObservableValueEventType.Created]);
    });

    it('get falls back to disk on RAM expiry and refreshes the cache', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const persistence = new InMemoryPersistenceProvider<string, number>();
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence,
            ttlMs: 100
        });

        await repository.set('a', 1);
        expect(repository.read('a')).toBe(1);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.200Z'));
        // RAM expired; the disk entry expires at the same time, so it has
        // been evicted by the InMemory provider's getItem.
        expect(repository.read('a')).toBeUndefined();

        // Override the disk value to simulate a fresh write from another tab.
        await persistence.setItem('a', 99, { expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
        expect(await repository.get('a')).toBe(99);
    });

    it('get returns undefined when neither RAM nor disk has the key', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>();
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });

        expect(await repository.get('missing')).toBeUndefined();
    });

    it('get prefers a concurrent write over a stale disk read', async () => {
        // Scenario:
        // - get('a') starts; RAM cold; awaits getItem
        // - meanwhile, set('a', NEW) commits to disk and RAM
        // - getItem returns OLD (or undefined) from a snapshot
        // - get must observe the just-written RAM value, not write OLD over it.
        const persistence = new InMemoryPersistenceProvider<string, number>([
            ['a', 1]
        ]);
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });

        let resolveGet: ((value: number | undefined) => void) | undefined;
        const getItem = vi.spyOn(persistence, 'getItem');
        getItem.mockImplementationOnce((_key) => {
            return new Promise((resolve) => {
                resolveGet = (v) => resolve(v);
            });
        });

        const inflightGet = repository.get('a');

        // Concurrent write commits while the disk read is in flight.
        await repository.set('a', 100);

        // Now resolve the original disk read with the OLD value.
        resolveGet!(1);

        expect(await inflightGet).toBe(100);
        expect(repository.read('a')).toBe(100);
    });

    it('delete removes from disk and RAM', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>();
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });
        await repository.set('a', 1);
        await repository.set('b', 2);

        expect(await repository.delete('a')).toBe(true);

        expect(repository.read('a')).toBeUndefined();
        expect(await persistence.getItem('a')).toBeUndefined();
        expect(await persistence.getItem('b')).toBe(2);
    });

    it('clearAll wipes disk and RAM and serializes after pending writes', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>();
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });

        await Promise.all([
            repository.set('a', 1),
            repository.set('b', 2),
            repository.clearAll()
        ]);

        expect(repository.size()).toBe(0);
        expect(await persistence.getAllKeys()).toEqual([]);
    });

    it('hydrate eagerly warms RAM from disk and is idempotent', async () => {
        const persistence = new InMemoryPersistenceProvider<string, number>([
            ['a', 1],
            ['b', 2]
        ]);
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });

        await repository.hydrate();
        expect(repository.read('a')).toBe(1);
        expect(repository.read('b')).toBe(2);

        const getAllKeys = vi.spyOn(persistence, 'getAllKeys');
        await repository.hydrate();
        expect(getAllKeys).not.toHaveBeenCalled();
        expect(repository.isHydrated()).toBe(true);
    });

    it('default expireAtFor uses ttlMs to compute absolute disk expiry', async () => {
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
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence,
            ttlMs: 5_000
        });

        await repository.set('a', 1);

        expect(captured).toHaveLength(1);
        expect(captured[0]?.expireAtTimestamp).toBe(
            Date.parse('2026-01-01T00:00:05.000Z')
        );
    });

    it('whenIdle waits for both pending writes and observer queue to drain', async () => {
        let resolvePersist: (() => void) | undefined;
        const persistRelease = new Promise<void>((resolve) => {
            resolvePersist = resolve;
        });
        const persistence: PersistenceProvider<string, number> = {
            getAllKeys: async () => [],
            getItem: async () => undefined,
            setItem: async () => {
                await persistRelease;
            },
            removeItem: async () => {
            },
            deleteExpired: async () => 0
        };
        const repository = new WriteThroughObservableLatestRepository<string, number>({
            persistence
        });

        const observed: number[] = [];
        let resolveObserver: (() => void) | undefined;
        let markObserverStarted: (() => void) | undefined;
        const observerStarted = new Promise<void>((resolve) => {
            markObserverStarted = resolve;
        });
        const observerRelease = new Promise<void>((resolve) => {
            resolveObserver = resolve;
        });
        repository.onCreatedDo(async (event) => {
            markObserverStarted!();
            await observerRelease;
            if (event.value !== undefined) {
                observed.push(event.value);
            }
        });

        void repository.set('a', 1);
        const idlePromise = repository.whenIdle();

        let idleSettled = false;
        void idlePromise.then(() => {
            idleSettled = true;
        });

        resolvePersist!();
        await observerStarted;
        await Promise.resolve();
        expect(idleSettled).toBe(false);

        resolveObserver!();
        await idlePromise;

        expect(observed).toEqual([1]);
    });
});
