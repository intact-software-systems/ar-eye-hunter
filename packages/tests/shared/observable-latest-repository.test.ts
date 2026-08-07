import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObservableLatestRepository } from '@shared/cache/ObservableLatestRepository.ts';
import { type ObservableKeyedValueEvent, ObservableValueEventType, } from '@shared/cache/RepositoryInterfaces.ts';

describe('ObservableLatestRepository', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('emits keyed created, updated, refreshed, and deleted events', async () => {
        const repository = new ObservableLatestRepository<string, number>();
        const events: Array<ObservableKeyedValueEvent<string, number>> = [];

        repository.onChangeDo((event) => {
            events.push(event);
        });

        repository.set('a', 1);
        repository.set('a', 2);
        repository.set('a', 2);
        expect(repository.delete('a')).toBe(true);
        await repository.whenIdle();

        expect(events.map((event) => [event.key, event.type])).toEqual([
            ['a', ObservableValueEventType.Created],
            ['a', ObservableValueEventType.Updated],
            ['a', ObservableValueEventType.Refreshed],
            ['a', ObservableValueEventType.Deleted],
        ]);
        expect(events[3]).toMatchObject({
            key: 'a',
            previous: 2,
        });
    });

    it('uses custom equality for refreshed writes', async () => {
        const repository = new ObservableLatestRepository<
            string,
            { version: number; value: string }
        >({
            equals: (left, right) => left.version === right.version,
        });
        const events: ObservableValueEventType[] = [];

        repository.onChangeDo((event) => {
            events.push(event.type);
        });

        repository.set('item', { version: 1, value: 'A' });
        repository.set('item', { version: 1, value: 'B' });
        repository.set('item', { version: 2, value: 'B' });
        await repository.whenIdle();

        expect(events).toEqual([
            ObservableValueEventType.Created,
            ObservableValueEventType.Refreshed,
            ObservableValueEventType.Updated,
        ]);
    });

    it('emits refreshed from touch and deleted during expiry cleanup', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const repository = new ObservableLatestRepository<string, number>({
            ttlMs: 100,
        });
        const events: ObservableValueEventType[] = [];

        repository.onChangeDo((event) => {
            events.push(event.type);
        });

        repository.set('a', 1);
        expect(repository.touch('a')).toBe(true);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
        expect(repository.deleteExpired()).toBe(1);
        await repository.whenIdle();

        expect(events).toEqual([
            ObservableValueEventType.Created,
            ObservableValueEventType.Refreshed,
            ObservableValueEventType.Deleted,
        ]);
        expect(repository.has('a')).toBe(false);
    });

    it('evicts expired entries on the configured interval and emits deletes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const repository = new ObservableLatestRepository<string, number>({
            ttlMs: 10,
            deleteExpiredIntervalMs: 20,
        });
        const events: ObservableValueEventType[] = [];

        repository.onChangeDo((event) => {
            events.push(event.type);
        });

        repository.set('a', 1);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.011Z'));
        expect(repository.size()).toBe(1);

        vi.advanceTimersByTime(20);
        await repository.whenIdle();

        expect(repository.size()).toBe(0);
        expect(events).toEqual([
            ObservableValueEventType.Created,
            ObservableValueEventType.Deleted,
        ]);

        repository.set('kept-after-dispose', 2);
        repository.dispose();

        vi.setSystemTime(new Date('2026-01-01T00:00:00.022Z'));
        vi.advanceTimersByTime(20);

        expect(repository.size()).toBe(1);
    });

    it('supports type-specific observers and idempotent unsubscribe', async () => {
        const repository = new ObservableLatestRepository<string, number>();
        const created = vi.fn();
        const updated = vi.fn();
        const subscription = repository.onCreatedDo(created);

        repository.onUpdatedDo(updated);
        repository.set('a', 1);
        await repository.whenIdle();
        subscription.unsubscribe();
        subscription.unsubscribe();
        repository.set('b', 1);
        repository.set('a', 2);
        await repository.whenIdle();

        expect(created).toHaveBeenCalledTimes(1);
        expect(updated).toHaveBeenCalledTimes(1);
        expect(updated.mock.calls[0]?.[0]).toMatchObject({
            key: 'a',
            type: ObservableValueEventType.Updated,
            value: 2,
            previous: 1,
        });
    });

    it('readAllValues returns present values and filters expired entries', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const repository = new ObservableLatestRepository<string, number>({
            ttlMs: 10,
        });
        repository.set('a', 1);
        repository.set('b', 2);
        repository.set('c', 3);

        expect(repository.readAllValues().sort()).toEqual([1, 2, 3]);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.011Z'));
        expect(repository.readAllValues()).toEqual([]);
    });

    it('updateIfNewer creates, applies newer versions, and emits the matching events', async () => {
        type Versioned = Readonly<{ version: number; payload: string }>;
        const repository = new ObservableLatestRepository<string, Versioned>({
            equals: (left, right) => left.version === right.version,
        });
        const events: ObservableValueEventType[] = [];
        repository.onChangeDo((event) => {
            events.push(event.type);
        });

        const versionOf = (value: Versioned) => value.version;
        const onNewer = vi.fn();
        const onStale = vi.fn();

        expect(
            repository.updateIfNewer('k', { version: 1, payload: 'a' }, {
                versionOf,
                onNewer,
                onStale,
            }),
        ).toBe(true);
        expect(
            repository.updateIfNewer('k', { version: 2, payload: 'b' }, {
                versionOf,
                onNewer,
                onStale,
            }),
        ).toBe(true);
        expect(
            repository.updateIfNewer('k', { version: 1, payload: 'stale' }, {
                versionOf,
                onNewer,
                onStale,
            }),
        ).toBe(false);
        expect(
            repository.updateIfNewer('k', { version: 2, payload: 'sameVersion' }, {
                versionOf,
                onNewer,
                onStale,
            }),
        ).toBe(false);

        await repository.whenIdle();

        expect(repository.read('k')).toEqual({ version: 2, payload: 'b' });
        expect(onNewer).toHaveBeenCalledTimes(1);
        expect(onStale).toHaveBeenCalledTimes(2);
        expect(events).toEqual([
            ObservableValueEventType.Created,
            ObservableValueEventType.Updated,
            ObservableValueEventType.Refreshed,
            ObservableValueEventType.Refreshed,
        ]);
    });

    it('waits for events enqueued by repository observers before becoming idle', async () => {
        const repository = new ObservableLatestRepository<string, number>();
        const events: Array<[string, ObservableValueEventType]> = [];

        repository.onCreatedDo((event) => {
            events.push([event.key, event.type]);
            repository.set('b', 2);
        });
        repository.onUpdatedDo((event) => {
            events.push([event.key, event.type]);
        });

        repository.set('b', 1);
        await repository.whenIdle();

        expect(events).toEqual([
            ['b', ObservableValueEventType.Created],
            ['b', ObservableValueEventType.Updated],
        ]);
        expect(repository.read('b')).toBe(2);
    });

    it('deletes only the exact observed value', async () => {
        type Snapshot = Readonly<{ revision: number }>;
        type ConditionallyDeletable = Readonly<{
            compareAndDelete?: (key: string, expected: Snapshot) => boolean;
        }>;
        const repository = new ObservableLatestRepository<string, Snapshot>();
        const deleted = vi.fn();
        const first = { revision: 1 };
        const equalButDifferent = { revision: 1 };
        const newer = { revision: 2 };
        const conditionallyDeletable = repository as ConditionallyDeletable;

        repository.onDeletedDo(deleted);
        repository.set('room', first);

        expect(
            conditionallyDeletable.compareAndDelete?.('room', equalButDifferent)
                ?? false,
        ).toBe(false);
        expect(repository.peek('room')).toBe(first);

        repository.set('room', newer);
        await repository.whenIdle();
        expect(
            conditionallyDeletable.compareAndDelete?.('room', first) ?? false,
        ).toBe(false);
        expect(repository.peek('room')).toBe(newer);

        expect(
            conditionallyDeletable.compareAndDelete?.('room', newer) ?? false,
        ).toBe(true);
        await repository.whenIdle();

        expect(repository.peek('room')).toBeUndefined();
        expect(deleted).toHaveBeenCalledTimes(1);
        expect(deleted.mock.calls[0]?.[0]).toMatchObject({
            key: 'room',
            previous: newer,
        });
    });
});
