import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { ObservableLatestRepository } from '@shared/cache/ObservableLatestRepository.ts';
import {
    ObservableValueEventType,
    type ObservableKeyedValueEvent
} from '@shared/cache/RepositoryInterfaces.ts';
import { WriteBehindObservableLatestRepository } from '@shared/cache/WriteBehindObservableLatestRepository.ts';
import { WriteThroughObservableLatestRepository } from '@shared/cache/WriteThroughObservableLatestRepository.ts';
import { InMemoryPersistenceProvider } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';

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

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
        'refuses maxEntries %s',
        (maxEntries) => {
            expect(() => new LatestRepository<string, number>({ maxEntries })).toThrow(
                'maxEntries must be a positive integer'
            );
        }
    );
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
    // A cache cap must never delete stored rows, so these option types refuse it at compile time.
    it('do not accept maxEntries', () => {
        const refuseMaxEntries = (): void => {
            const persistence = new InMemoryPersistenceProvider<string, number>();

            // @ts-expect-error maxEntries is not an option of the write-through repository
            new WriteThroughObservableLatestRepository<string, number>({ persistence, maxEntries: 1 });
            // @ts-expect-error maxEntries is not an option of the write-behind repository
            new WriteBehindObservableLatestRepository<string, number>({ persistence, maxEntries: 1 });
        };

        expect(refuseMaxEntries).toBeTypeOf('function');
    });
});
