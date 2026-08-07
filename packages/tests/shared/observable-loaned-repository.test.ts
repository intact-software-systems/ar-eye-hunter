import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObservableLoanedRepository } from '@shared/cache/ObservableLoanedRepository.ts';
import { ObservableLoanedValue } from '@shared/cache/ObservableLoanedValue.ts';
import {
    type ObservableKeyedValueEvent,
    type ObservableValueEvent,
    ObservableValueEventType,
} from '@shared/cache/RepositoryInterfaces.ts';

describe('ObservableLoanedValue', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('emits created, updated, refreshed, and deleted events for observed refreshes', async () => {
        const refreshValues = [1, 2, 2];
        const value = new ObservableLoanedValue<number>(
            async () => refreshValues.shift() ?? 2,
        );
        const events: Array<ObservableValueEvent<number>> = [];

        value.onChangeDo((event) => {
            events.push(event);
        });

        expect(await value.get()).toBe(1);
        expect(await value.get()).toBe(1);
        expect(await value.refresh()).toBe(2);
        expect(await value.refresh()).toBe(2);
        value.clear();
        await value.whenIdle();

        expect(events.map((event) => event.type)).toEqual([
            ObservableValueEventType.Created,
            ObservableValueEventType.Updated,
            ObservableValueEventType.Refreshed,
            ObservableValueEventType.Deleted,
        ]);
        expect(events[0]).toMatchObject({
            type: ObservableValueEventType.Created,
            value: 1,
        });
        expect(events[1]).toMatchObject({
            type: ObservableValueEventType.Updated,
            value: 2,
            previous: 1,
        });
        expect(events[2]).toMatchObject({
            type: ObservableValueEventType.Refreshed,
            value: 2,
            previous: 2,
        });
        expect(events[3]).toMatchObject({
            type: ObservableValueEventType.Deleted,
            previous: 2,
        });
    });

    it('coalesces concurrent refresh observation into one event', async () => {
        const deferred = createDeferred<number>();
        const events: ObservableValueEventType[] = [];
        let calls = 0;
        const value = new ObservableLoanedValue<number>(async () => {
            calls += 1;
            return deferred.promise;
        });

        value.onChangeDo((event) => {
            events.push(event.type);
        });

        const first = value.get();
        const second = value.get();

        await Promise.resolve();
        expect(calls).toBe(1);
        expect(value.refreshing()).toBe(true);

        deferred.resolve(7);

        await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
        await value.whenIdle();

        expect(calls).toBe(1);
        expect(events).toEqual([ObservableValueEventType.Created]);
    });

    it('emits deleted from takeIfExpired only when the loan has expired', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const value = new ObservableLoanedValue<number>(async () => 1, {
            ttlMs: 100,
        });
        const events: ObservableValueEventType[] = [];

        value.onChangeDo((event) => {
            events.push(event.type);
        });

        expect(await value.get()).toBe(1);
        expect(value.takeIfExpired()).toBeUndefined();

        vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
        expect(value.takeIfExpired()).toBe(1);
        await value.whenIdle();

        expect(events).toEqual([
            ObservableValueEventType.Created,
            ObservableValueEventType.Deleted,
        ]);
    });
});

describe('ObservableLoanedRepository', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('re-emits keyed events and keeps cache hits quiet', async () => {
        let next = 1;
        const repository = new ObservableLoanedRepository<string, number>(
            async (_key, current) => current ?? next++,
        );
        const events: Array<ObservableKeyedValueEvent<string, number>> = [];

        repository.onChangeDo((event) => {
            events.push(event);
        });

        expect(await repository.get('room-a')).toBe(1);
        expect(await repository.get('room-a')).toBe(1);
        expect(await repository.refresh('room-a')).toBe(1);
        expect(repository.delete('room-a')).toBe(true);
        await repository.whenIdle();

        expect(events.map((event) => [event.key, event.type])).toEqual([
            ['room-a', ObservableValueEventType.Created],
            ['room-a', ObservableValueEventType.Refreshed],
            ['room-a', ObservableValueEventType.Deleted],
        ]);
    });

    it('supports override refreshers with key and current value', async () => {
        const defaultCalls: Array<[string, number | undefined]> = [];
        const overrideCalls: Array<[string, number | undefined]> = [];
        const repository = new ObservableLoanedRepository<string, number>(
            async (key, current) => {
                defaultCalls.push([key, current]);
                return (current ?? key.length) + 1;
            },
        );

        expect(await repository.get('aa')).toBe(3);
        expect(
            await repository.refreshWith('aa', async (key, current) => {
                overrideCalls.push([key, current]);
                return (current ?? 0) + 5;
            }),
        ).toBe(8);

        expect(defaultCalls).toEqual([['aa', undefined]]);
        expect(overrideCalls).toEqual([['aa', 3]]);
    });

    it('deletes expired entries, emits delete, and skips refreshing entries', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const deferred = createDeferred<number>();
        let mode: 'initial' | 'refresh' = 'initial';
        const repository = new ObservableLoanedRepository<string, number>(
            async (_key, current) => {
                if (mode === 'initial') {
                    return (current ?? 0) + 1;
                }

                return deferred.promise;
            },
            {
                ttlMs: 5,
            },
        );
        const events: ObservableValueEventType[] = [];

        repository.onChangeDo((event) => {
            events.push(event.type);
        });

        expect(await repository.get('job')).toBe(1);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.010Z'));
        mode = 'refresh';
        const refreshPromise = repository.refresh('job');

        await Promise.resolve();
        expect(repository.refreshing('job')).toBe(true);
        expect(repository.deleteExpired()).toBe(0);

        deferred.resolve(2);
        await expect(refreshPromise).resolves.toBe(2);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.020Z'));
        expect(repository.deleteExpired()).toBe(1);
        await repository.whenIdle();

        expect(events).toEqual([
            ObservableValueEventType.Created,
            ObservableValueEventType.Updated,
            ObservableValueEventType.Deleted,
        ]);
        expect(repository.has('job')).toBe(false);
    });

    it('does not forward late refresh events from a deleted entry', async () => {
        const firstRefresh = createDeferred<number>();
        const secondRefresh = createDeferred<number>();
        const refreshes = [firstRefresh, secondRefresh];
        const repository = new ObservableLoanedRepository<string, number>(
            async () => {
                const deferred = refreshes.shift();
                if (!deferred) {
                    throw new Error('unexpected refresh');
                }

                return deferred.promise;
            },
        );
        const events: Array<ObservableKeyedValueEvent<string, number>> = [];

        repository.onChangeDo((event) => {
            events.push(event);
        });

        const first = repository.get('room-a');
        await Promise.resolve();
        expect(repository.delete('room-a')).toBe(true);

        const second = repository.get('room-a');
        await Promise.resolve();

        firstRefresh.resolve(1);
        await expect(first).resolves.toBe(1);

        secondRefresh.resolve(2);
        await expect(second).resolves.toBe(2);
        await repository.whenIdle();

        expect(repository.read('room-a')).toBe(2);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            key: 'room-a',
            type: ObservableValueEventType.Created,
            value: 2,
        });
    });

    it('deletes only the exact observed loaned value', async () => {
        type Snapshot = Readonly<{ revision: number }>;
        type ConditionallyDeletable = Readonly<{
            compareAndDelete?: (key: string, expected: Snapshot) => boolean;
        }>;
        let current: Snapshot = { revision: 1 };
        const repository = new ObservableLoanedRepository<string, Snapshot>(
            async () => current,
        );
        const deleted = vi.fn();
        const conditionallyDeletable = repository as ConditionallyDeletable;
        const first = await repository.get('room');

        repository.onDeletedDo(deleted);
        expect(
            conditionallyDeletable.compareAndDelete?.(
                'room',
                { revision: first.revision },
            ) ?? false,
        ).toBe(false);
        expect(repository.peek('room')).toBe(first);

        current = { revision: 2 };
        const newer = await repository.refresh('room');
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

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error?: unknown) => void;

    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}
