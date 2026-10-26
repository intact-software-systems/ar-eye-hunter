import { QueuedNotifications } from '@shared/cache/observable/queued-notifications.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

interface Event {
    readonly type: 'created' | 'updated';
    readonly value: number;
}

afterEach(() => vi.restoreAllMocks());

describe('QueuedNotifications', () => {
    it('starts listeners together and waits for every listener before the next event', async () => {
        const notifications = new QueuedNotifications<Event>();
        const slow = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        const events: string[] = [];
        notifications.subscribe(async (event) => {
            events.push(`slow start ${event.value}`);
            if (event.value === 1) {
                await slow.promise;
            }
            events.push(`slow end ${event.value}`);
        });
        notifications.subscribe((event) => {
            events.push(`fast ${event.value}`);
            started.resolve();
        });

        notifications.publish({ type: 'created', value: 1 });
        notifications.publish({ type: 'updated', value: 2 });
        expect(events).toEqual([]);
        let idle = false;
        const completion = notifications.whenIdle().then(() => {
            idle = true;
        });
        await started.promise;
        expect(events).toEqual(['slow start 1', 'fast 1']);
        expect(idle).toBe(false);

        slow.resolve();
        await completion;
        expect(events).toEqual(['slow start 1', 'fast 1', 'slow end 1', 'slow start 2', 'slow end 2', 'fast 2']);
    });

    it('retains the captured audience when subscriptions change before delivery', async () => {
        const notifications = new QueuedNotifications<Event>();
        const received: string[] = [];
        const first = notifications.subscribe((event) => {
            received.push(`first ${event.value}`);
        });
        notifications.publish({ type: 'created', value: 1 });
        first.unsubscribe();
        notifications.subscribe((event) => {
            received.push(`second ${event.value}`);
        });
        notifications.publish({ type: 'updated', value: 2 });
        await notifications.whenIdle();
        expect(received).toEqual(['first 1', 'second 2']);
    });

    it('deduplicates within a subscription group and preserves typed plus all-event delivery', async () => {
        const notifications = new QueuedNotifications<Event>();
        const received: number[] = [];
        const listener = (event: Event) => {
            received.push(event.value);
        };
        notifications.subscribeType('created', listener);
        notifications.subscribeType('created', listener);
        notifications.subscribe(listener);
        notifications.subscribe(listener);
        notifications.publish({ type: 'created', value: 1 });
        notifications.publish({ type: 'updated', value: 2 });
        await notifications.whenIdle();
        expect(received).toEqual([1, 1, 2]);
    });

    it('does not let an obsolete typed registration delete a replacement group', async () => {
        const notifications = new QueuedNotifications<Event>();
        const received: number[] = [];
        const listener = (event: Event) => {
            received.push(event.value);
        };
        const first = notifications.subscribeType('updated', listener);
        const stale = notifications.subscribeType('updated', listener);
        first.unsubscribe();
        notifications.subscribeType('updated', listener);
        stale.unsubscribe();
        notifications.publish({ type: 'updated', value: 2 });
        await notifications.whenIdle();
        expect(received).toEqual([2]);
    });

    it('includes nested publication in whenIdle', async () => {
        const notifications = new QueuedNotifications<Event>();
        const received: number[] = [];
        notifications.subscribe((event) => {
            received.push(event.value);
            if (event.value === 1) {
                notifications.publish({ type: 'updated', value: 2 });
            }
        });
        notifications.publish({ type: 'created', value: 1 });
        await notifications.whenIdle();
        expect(received).toEqual([1, 2]);
    });

    it('awaits error reporting before later delivery and includes the original event', async () => {
        const reported = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const errors: Array<readonly [string, number]> = [];
        const received: number[] = [];
        const notifications = new QueuedNotifications<Event>(async (error, event) => {
            errors.push([error.message, event.value]);
            reported.resolve();
            await release.promise;
        });
        notifications.subscribe(() => {
            throw 'observer failure';
        });
        notifications.subscribe((event) => {
            received.push(event.value);
        });
        notifications.publish({ type: 'created', value: 1 });
        notifications.publish({ type: 'updated', value: 2 });
        const completion = notifications.whenIdle();
        await reported.promise;
        expect(errors).toEqual([['observer failure', 1]]);
        expect(received).toEqual([1]);
        release.resolve();
        await completion;
        expect(errors).toEqual([['observer failure', 1], ['observer failure', 2]]);
        expect(received).toEqual([1, 2]);
    });

    it('isolates rejected listeners and reporters even when diagnostics fail', async () => {
        const notifications = new QueuedNotifications<Event>(async () => {
            throw new Error('reporter failed');
        });
        const received: number[] = [];
        vi.spyOn(console, 'error').mockImplementation(() => {
            throw new Error('diagnostics failed');
        });
        notifications.subscribe(async () => {
            throw new Error('listener failed');
        });
        notifications.subscribe((event) => {
            received.push(event.value);
        });
        notifications.publish({ type: 'created', value: 1 });
        notifications.publish({ type: 'updated', value: 2 });
        await expect(notifications.whenIdle()).resolves.toBeUndefined();
        expect(received).toEqual([1, 2]);
    });
    it('finishes delivery when a thrown value cannot be converted to an Error', async () => {
        const notifications = new QueuedNotifications<Event>();
        const received: number[] = [];
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        notifications.subscribe(() => {
            throw Object.create(null);
        });
        notifications.subscribe((event) => {
            received.push(event.value);
        });
        notifications.publish({ type: 'created', value: 1 });
        notifications.publish({ type: 'updated', value: 2 });
        await expect(notifications.whenIdle()).resolves.toBeUndefined();
        expect(received).toEqual([1, 2]);
    });
});
