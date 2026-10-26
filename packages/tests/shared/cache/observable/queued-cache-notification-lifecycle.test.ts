import { ObservableLatestRepository } from '@shared/cache/observable/observable-latest-repository.ts';
import { ObservableLatestValue } from '@shared/cache/observable/observable-latest-value.ts';
import { ObservableLoanedRepository } from '@shared/cache/observable/observable-loaned-repository.ts';
import { ObservableLoanedValue } from '@shared/cache/observable/observable-loaned-value.ts';
import type { ObservableValue, ObservableValueEvent } from '@shared/cache/RepositoryInterfaces.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

interface CacheHarness {
    readonly observable: ObservableValue<number>;
    write(value: number): void | Promise<number>;
    whenIdle(): Promise<void>;
}

const caches: ReadonlyArray<readonly [string, () => CacheHarness]> = [
    ['latest value', () => {
        const value = new ObservableLatestValue<number>();
        return { observable: value, write: (next) => value.accept(next), whenIdle: () => value.whenIdle() };
    }],
    ['loaned value', () => {
        const value = new ObservableLoanedValue<number>(() => 0);
        return { observable: value, write: (next) => value.refreshWith(() => next), whenIdle: () => value.whenIdle() };
    }],
    ['latest repository', () => {
        const repository = new ObservableLatestRepository<string, number>();
        return { observable: repository, write: (next) => repository.accept('room', next), whenIdle: () => repository.whenIdle() };
    }],
    ['loaned repository', () => {
        const repository = new ObservableLoanedRepository<string, number>(() => 0);
        return { observable: repository, write: (next) => repository.refreshWith('room', () => next), whenIdle: () => repository.whenIdle() };
    }]
];

afterEach(() => vi.restoreAllMocks());

describe.each(caches)('%s queued subscriptions', (_name, createCache) => {
    it.each(['all changes', 'updated'] as const)('keeps a renewed %s subscription when an old handle unsubscribes', async (kind) => {
        const cache = createCache();
        const received: number[] = [];
        const listener = (event: ObservableValueEvent<number>) => {
            if (event.value !== undefined) {
                received.push(event.value);
            }
        };
        const subscribe = () =>
            kind === 'all changes'
                ? cache.observable.onChangeDo(listener)
                : cache.observable.onUpdatedDo(listener);
        const first = subscribe();
        const stale = subscribe();
        first.unsubscribe();
        const current = subscribe();
        stale.unsubscribe();

        await cache.write(1);
        await cache.write(2);
        await cache.whenIdle();
        expect(received).toEqual(kind === 'all changes' ? [1, 2] : [2]);

        current.unsubscribe();
        await cache.write(3);
        await cache.whenIdle();
        expect(received).toEqual(kind === 'all changes' ? [1, 2] : [2]);
    });

    it('finishes committed notifications when both an observer and diagnostic logging throw', async () => {
        const cache = createCache();
        const received: number[] = [];
        vi.spyOn(console, 'error').mockImplementation(() => {
            throw new Error('diagnostics unavailable');
        });
        cache.observable.onChangeDo(() => {
            throw new Error('observer failed');
        });
        cache.observable.onChangeDo((event) => {
            if (event.value !== undefined) {
                received.push(event.value);
            }
        });

        await cache.write(1);
        await expect(cache.whenIdle()).resolves.toBeUndefined();
        await cache.write(2);
        await expect(cache.whenIdle()).resolves.toBeUndefined();
        expect(received).toEqual([1, 2]);
    });
});
