import { expect, it } from 'vitest';

import { AsyncNotifications, notifyConcurrentListeners } from '@shared/cache/async-notifications.ts';

it('awaits sequential listeners, observes live subscriptions, and propagates the first failure', async () => {
    const notifications = new AsyncNotifications<number>();
    const pending = Promise.withResolvers<void>();
    const received: string[] = [];
    notifications.subscribe(async (value) => {
        received.push(`first:${value}`);
        await pending.promise;
    });
    const removed = notifications.subscribe(() => {
        received.push('removed');
    });
    let completed = false;
    const delivery = notifications.publishSequential(3).then(() => {
        completed = true;
    });
    expect(received).toEqual(['first:3']);
    expect(completed).toBe(false);
    removed.unsubscribe();
    notifications.subscribe(() => {
        throw new Error('presence failed');
    });
    notifications.subscribe(() => {
        received.push('after failure');
    });
    pending.resolve();
    await expect(delivery).rejects.toThrow('presence failed');
    expect(received).toEqual(['first:3']);
    expect(completed).toBe(false);
});

it('starts concurrent listeners together, captures their audience, and awaits every result', async () => {
    const notifications = new AsyncNotifications<number>();
    const pending = Promise.withResolvers<void>();
    const received: string[] = [];
    const errors: string[] = [];
    notifications.subscribe(async () => {
        received.push('pending');
        await pending.promise;
        received.push('finished');
    });
    const removed = notifications.subscribe(() => {
        received.push('second');
    });
    notifications.subscribe(() => {
        throw new Error('observer failed');
    });
    notifications.subscribe(async () => {
        throw new Error('async observer failed');
    });
    let completed = false;
    const delivery = notifications.publishConcurrent(1, (error) => {
        errors.push(error.message);
    })
        .then(() => {
            completed = true;
        });
    removed.unsubscribe();
    notifications.subscribe(() => {
        received.push('late');
    });
    expect(received).toEqual(['pending', 'second']);
    expect(completed).toBe(false);
    pending.resolve();
    await delivery;
    expect(received).toEqual(['pending', 'second', 'finished']);
    expect(errors).toEqual(['observer failed', 'async observer failed']);
    expect(completed).toBe(true);
});

it('preserves unique listener registration and idempotent unsubscribe', async () => {
    const notifications = new AsyncNotifications<number>();
    const received: number[] = [];
    const listener = (value: number): void => {
        received.push(value);
    };
    const subscription = notifications.subscribe(listener);
    notifications.subscribe(listener);
    expect(notifications.size).toBe(1);
    await notifications.publishSequential(2);
    subscription.unsubscribe();
    subscription.unsubscribe();
    await notifications.publishSequential(3);
    expect(notifications.size).toBe(0);
    expect(received).toEqual([2]);
});

it('isolates a failing error reporter without losing other concurrent deliveries', async () => {
    const received: number[] = [];
    await notifyConcurrentListeners(
        [
            () => {
                throw new Error('observer failed');
            },
            (value: number) => {
                received.push(value);
            }
        ],
        4,
        async () => {
            throw new Error('reporter failed');
        }
    );
    expect(received).toEqual([4]);
});

it.each(['sequential', 'concurrent'] as const)('fences stale cleanup after renewed %s registration', async (mode) => {
    const notifications = new AsyncNotifications<number>();
    const received: number[] = [];
    const listener = (value: number): void => {
        received.push(value);
    };
    const stale = notifications.subscribe(listener);
    stale.unsubscribe();
    const current = notifications.subscribe(listener);
    stale.unsubscribe();
    if (mode === 'sequential') {
        await notifications.publishSequential(7);
    }
    else {
        await notifications.publishConcurrent(7, () => {});
    }
    expect(received).toEqual([7]);
    current.unsubscribe();
    expect(notifications.size).toBe(0);
});
