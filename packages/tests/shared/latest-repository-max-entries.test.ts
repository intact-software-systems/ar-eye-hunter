import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { ObservableLatestRepository } from '@shared/cache/ObservableLatestRepository.ts';
import {
    ObservableValueEventType,
    type ObservableKeyedValueEvent
} from '@shared/cache/RepositoryInterfaces.ts';
import {
    WriteBehindObservableLatestRepository,
    type WriteBehindObservableLatestRepositoryOptions
} from '@shared/cache/WriteBehindObservableLatestRepository.ts';
import {
    WriteThroughObservableLatestRepository,
    type WriteThroughObservableLatestRepositoryOptions
} from '@shared/cache/WriteThroughObservableLatestRepository.ts';
import { InMemoryPersistenceProvider } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';

/** The write paths both repositories share, each adding `key` when it is absent. */
interface CappedRepository {
    set(key: string, value: number): void;
    setIfAbsent(key: string, creator: () => number): number;
    getAndSet(key: string, update: number): number | undefined;
    updateIfNewer(key: string, next: number, options: { versionOf: (value: number) => number; }): boolean;
    compareAndSet(key: string, expect: number | undefined, update: number): boolean;
    latest(key: string): void;
    keys(): IterableIterator<string>;
}

interface AddingPath {
    readonly name: string;
    readonly add: (repository: CappedRepository, key: string) => void;
}

const ADDING_PATHS: readonly AddingPath[] = [
    { name: 'set', add: (repository, key) => repository.set(key, 1) },
    { name: 'setIfAbsent', add: (repository, key) => repository.setIfAbsent(key, () => 1) },
    { name: 'getAndSet', add: (repository, key) => repository.getAndSet(key, 1) },
    { name: 'updateIfNewer', add: (repository, key) => repository.updateIfNewer(key, 1, { versionOf: (value) => value }) },
    { name: 'compareAndSet', add: (repository, key) => repository.compareAndSet(key, undefined, 1) },
    { name: 'latest', add: (repository, key) => repository.latest(key) }
];

const CAPPED_CLASSES = [
    { name: 'LatestRepository', create: (): CappedRepository => new LatestRepository<string, number>({ maxEntries: 1 }) },
    {
        name: 'ObservableLatestRepository',
        create: (): CappedRepository => new ObservableLatestRepository<string, number>({ maxEntries: 1 })
    }
] as const;

describe('LatestRepository maxEntries', () => {
    it('keeps the two newest first insertions and drops the oldest', () => {
        const repository = new LatestRepository<string, number>({ maxEntries: 2 });

        repository.acceptAt({ key: 'a', value: 1, nowEpochMs: 0 });
        repository.acceptAt({ key: 'b', value: 2, nowEpochMs: 0 });
        repository.acceptAt({ key: 'c', value: 3, nowEpochMs: 0 });

        expect([...repository.keys()]).toEqual(['b', 'c']);
        expect(repository.readAt('a', 0)).toBeUndefined();
        expect(repository.readAt('c', 0)).toBe(3);
    });

    // Every write that can add a key is bounded, not only acceptAt.
    it('caps every path that adds a key', () => {
        const repository = new LatestRepository<string, number>({ maxEntries: 1 });

        repository.set('a', 1);
        repository.setIfAbsent('b', () => 2);
        expect([...repository.keys()]).toEqual(['b']);

        repository.getAndSet('c', 3);
        expect([...repository.keys()]).toEqual(['c']);

        repository.updateIfNewer('d', 4, { versionOf: (value) => value });
        expect([...repository.keys()]).toEqual(['d']);
        expect(repository.size()).toBe(1);
    });

    // Eviction is by first insertion: re-setting a key keeps its position, so
    // a caller that wants a re-set key to count as newest deletes it first.
    it('does not treat a re-set key as a new insertion', () => {
        const repository = new LatestRepository<string, number>({ maxEntries: 2 });

        repository.set('a', 1);
        repository.set('b', 2);
        repository.set('a', 10);
        repository.set('c', 3);

        expect([...repository.keys()]).toEqual(['b', 'c']);
    });

    it('caps the readOrAcceptAt path', () => {
        const repository = new LatestRepository<string, number>({ maxEntries: 1 });

        repository.acceptAt({ key: 'a', value: 1, nowEpochMs: 0 });
        expect(repository.readOrAcceptAt({ key: 'b', nowEpochMs: 0, create: () => 2 })).toBe(2);

        expect([...repository.keys()]).toEqual(['b']);
    });

    // Deleting a key ends its first insertion, so adding it again counts as the newest.
    it('moves a deleted then re-added key to the end', () => {
        const repository = new LatestRepository<string, number>({ maxEntries: 2 });

        repository.set('a', 1);
        repository.set('b', 2);
        repository.delete('a');
        repository.set('a', 10);
        repository.set('c', 3);

        expect([...repository.keys()]).toEqual(['a', 'c']);
    });

    it('leaves the repository unbounded without a cap', () => {
        const repository = new LatestRepository<string, number>();

        for (let index = 0; index < 100; index += 1) {
            repository.set(`key-${index}`, index);
        }

        expect(repository.size()).toBe(100);
    });

    // An expiry sweep frees room under the cap, and the cap then counts only
    // the entries that remain.
    it('applies the cap and deleteExpiredAt together', () => {
        const repository = new LatestRepository<string, number>({
            maxEntries: 2,
            evictsPerWindow: 0
        });

        repository.acceptAt({ key: 'a', value: 1, nowEpochMs: 0, expireAtEpochMs: 100 });
        repository.acceptAt({ key: 'b', value: 2, nowEpochMs: 0, expireAtEpochMs: 10_000 });
        expect(repository.deleteExpiredAt(100)).toBe(1);

        repository.acceptAt({ key: 'c', value: 3, nowEpochMs: 100, expireAtEpochMs: 10_000 });
        expect([...repository.keys()]).toEqual(['b', 'c']);

        repository.acceptAt({ key: 'd', value: 4, nowEpochMs: 100, expireAtEpochMs: 10_000 });
        expect([...repository.keys()]).toEqual(['c', 'd']);
    });

    // The expiry sweep's rate limiter starts at the first acceptAt; a clock that then steps back must
    // not make the sweep throw, and the cap still holds.
    it('accepts at a time before its first acceptAt and still caps', () => {
        const repository = new LatestRepository<string, number>({ maxEntries: 1 });

        repository.acceptAt({ key: 'a', value: 1, nowEpochMs: 10_000 });
        repository.acceptAt({ key: 'b', value: 2, nowEpochMs: 9_000 });

        expect([...repository.keys()]).toEqual(['b']);
        expect(repository.readAt('b', 9_000)).toBe(2);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
        'refuses maxEntries %s',
        (maxEntries) => {
            expect(() => new LatestRepository<string, number>({ maxEntries })).toThrow(
                'maxEntries must be a positive integer'
            );
        }
    );
});

describe.each(CAPPED_CLASSES)('$name maxEntries on every adding path', ({ create }) => {
    it.each(ADDING_PATHS)('keeps only the newest key added through $name', ({ add }) => {
        const repository = create();

        add(repository, 'a');
        add(repository, 'b');

        expect([...repository.keys()]).toEqual(['b']);
    });
});

describe('ObservableLatestRepository maxEntries', () => {
    it('emits the ordinary delete event for an evicted key', async () => {
        const repository = new ObservableLatestRepository<string, number>({ maxEntries: 2 });
        const events: Array<ObservableKeyedValueEvent<string, number>> = [];
        repository.onChangeDo((event) => {
            events.push(event);
        });

        repository.set('a', 1);
        repository.set('b', 2);
        repository.set('a', 10);
        repository.set('c', 3);
        await repository.whenIdle();

        expect([...repository.keys()]).toEqual(['b', 'c']);
        // Events are ordered per key; the repository does not order them across keys.
        const eventsOfA = events.filter((event) => event.key === 'a');
        expect(eventsOfA.map((event) => event.type)).toEqual([
            ObservableValueEventType.Created,
            ObservableValueEventType.Updated,
            ObservableValueEventType.Deleted
        ]);
        expect(eventsOfA[2]).toMatchObject({ key: 'a', previous: 10 });
        expect(events.filter((event) => event.type === ObservableValueEventType.Deleted))
            .toHaveLength(1);
    });

    it('notifies delete listeners of the eviction', async () => {
        const repository = new ObservableLatestRepository<string, number>({ maxEntries: 1 });
        const deleted: string[] = [];
        repository.onDeletedDo((event) => {
            deleted.push(event.key);
        });

        repository.set('a', 1);
        repository.set('b', 2);
        await repository.whenIdle();

        expect(deleted).toEqual(['a']);
    });

    it('routes a delete listener that throws on an eviction to onObserverError', async () => {
        const failures: Array<ObservableKeyedValueEvent<string, number>> = [];
        const repository = new ObservableLatestRepository<string, number>({
            maxEntries: 1,
            onObserverError: (_error, event) => {
                failures.push(event);
            }
        });
        repository.onDeletedDo(() => {
            throw new Error('listener failed');
        });

        repository.set('a', 1);
        repository.set('b', 2);
        await repository.whenIdle();

        expect([...repository.keys()]).toEqual(['b']);
        expect(failures).toEqual([expect.objectContaining({ key: 'a', type: ObservableValueEventType.Deleted })]);
    });

    // An expiry sweep frees room under the cap, and the cap then counts only the entries that remain.
    it('applies the cap and deleteExpired together', () => {
        vi.useFakeTimers({ toFake: ['Date'], now: 0 });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const repository = new ObservableLatestRepository<string, number>({ maxEntries: 2, ttlMs: 100 });

        repository.set('a', 1);
        vi.setSystemTime(50);
        repository.set('b', 2);
        vi.setSystemTime(110);
        expect(repository.deleteExpired()).toBe(1);

        repository.set('c', 3);
        expect([...repository.keys()]).toEqual(['b', 'c']);
        repository.set('d', 4);
        expect([...repository.keys()]).toEqual(['c', 'd']);
    });

    it('leaves the repository unbounded without a cap', () => {
        const repository = new ObservableLatestRepository<string, number>();

        for (let index = 0; index < 100; index += 1) {
            repository.set(`key-${index}`, index);
        }

        expect(repository.size()).toBe(100);
    });

    it('refuses a maxEntries that is not a positive integer', () => {
        expect(() => new ObservableLatestRepository<string, number>({ maxEntries: 0 })).toThrow(
            'maxEntries must be a positive integer'
        );
    });
});

describe('persisted repositories', () => {
    // A cache cap must never delete stored rows, so these option types refuse it. The expectations are
    // type-level only: the tests typecheck gate holds them, and they assert nothing at run time.
    it('do not accept maxEntries', () => {
        expectTypeOf<WriteThroughObservableLatestRepositoryOptions<string, number>>().not.toHaveProperty('maxEntries');
        expectTypeOf<WriteBehindObservableLatestRepositoryOptions<string, number>>().not.toHaveProperty('maxEntries');
    });

    // A caller the type does not reach (a cast, or JavaScript) still gets an uncapped memory.
    it.each([
        {
            name: 'write-through',
            create: (options: object) =>
                new WriteThroughObservableLatestRepository<string, number>(
                    options as WriteThroughObservableLatestRepositoryOptions<string, number>
                )
        },
        {
            name: 'write-behind',
            create: (options: object) =>
                new WriteBehindObservableLatestRepository<string, number>(
                    options as WriteBehindObservableLatestRepositoryOptions<string, number>
                )
        }
    ])('keep every key when a $name caller passes maxEntries anyway', async ({ create }) => {
        const repository = create({ persistence: new InMemoryPersistenceProvider<string, number>(), maxEntries: 1 });
        onTestFinished(() => repository.dispose());

        await repository.set('a', 1);
        await repository.set('b', 2);

        expect([...repository.keys()]).toEqual(['a', 'b']);
    });
});
