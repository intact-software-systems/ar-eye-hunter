import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS,
    ResourceInboxCompletionNotifications
} from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';

const identity = { topicId: 'topic', resourceId: 'resource', contextId: 'context' };
const distinctIdentities = [
    { topicId: 'topic', resourceId: 'resource', contextId: undefined },
    { topicId: 'topic', resourceId: 'resource', contextId: '' },
    { topicId: 'topic', resourceId: 'resource', contextId: 'undefined' },
    { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
    { topicId: 'a/b', resourceId: 'c', contextId: 'd' },
    { topicId: 'a', resourceId: 'b/c', contextId: 'd' },
    { topicId: 'a', resourceId: 'b', contextId: 'c/d' },
    { topicId: 'a', resourceId: 'b', contextId: 'c%2Fd' }
];

afterEach(() => vi.useRealTimers());
describe('Local ResourceInbox completion notification ownership', () => {
    it('isolates every full identity including absence, empty values and separator strings', async () => {
        vi.useFakeTimers();
        const notifications = ResourceInboxCompletionNotifications.createDefault();
        for (const published of distinctIdentities) {
            const subscriptions = distinctIdentities.map((key) => notifications.subscribe(key));
            const settled: number[] = [];
            subscriptions.forEach((subscription, index) => {
                void subscription.wait(1000).then(() => settled.push(index));
            });
            const key = published;
            notifications.publish(key, 'awaitable');
            await vi.advanceTimersByTimeAsync(0);
            expect(settled).toEqual([distinctIdentities.indexOf(published)]);
            subscriptions.forEach((subscription) => subscription.close());
            expect(vi.getTimerCount()).toBe(0);
        }
    });

    it('does not publish across separately constructed lifecycle owners', async () => {
        vi.useFakeTimers();
        const owner = ResourceInboxCompletionNotifications.createDefault();
        const other = ResourceInboxCompletionNotifications.createDefault();
        const subscription = owner.subscribe(identity);
        let settled = false;
        void subscription.wait(1000).then(() => {
            settled = true;
        });
        other.publish(identity, 'awaitable');
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        subscription.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('retains a notification delivered at the timer registration port', async () => {
        vi.useFakeTimers();
        let notifyAtRegistration = () => {};
        const notifications = new ResourceInboxCompletionNotifications({
            nowMs: Date.now,
            schedule: (settle, delay) => {
                notifyAtRegistration();
                const timer = setTimeout(settle, delay);
                return () => clearTimeout(timer);
            }
        });
        notifyAtRegistration = () => notifications.publish(identity, 'awaitable');
        const subscription = notifications.subscribe(identity);
        subscription.beginRead();
        let settled = false;
        void subscription.wait(1000).then(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        subscription.close();
    });

    it('settles once and leaves no timer when notification and expiry meet', async () => {
        vi.useFakeTimers();
        const cancelled: ReturnType<typeof setTimeout>[] = [];
        const scheduled: ReturnType<typeof setTimeout>[] = [];
        const notifications = new ResourceInboxCompletionNotifications({
            nowMs: Date.now,
            schedule: (settle, delay) => {
                const timer = setTimeout(settle, delay);
                scheduled.push(timer);
                return () => {
                    cancelled.push(timer);
                    clearTimeout(timer);
                };
            }
        });
        const subscription = notifications.subscribe(identity);
        let settlements = 0;
        const pending = subscription.wait(1000).then(() => {
            settlements += 1;
        });
        await vi.advanceTimersByTimeAsync(1000);
        notifications.publish(identity, 'awaitable');
        subscription.close();
        subscription.close();
        await pending;
        expect(settlements).toBe(1);
        expect(scheduled).toHaveLength(1);
        expect(cancelled).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('releases the exact timer of a wait shorter than the tick when a notification ends it', async () => {
        vi.useFakeTimers();
        const cancelled: ReturnType<typeof setTimeout>[] = [];
        const scheduled: ReturnType<typeof setTimeout>[] = [];
        const notifications = new ResourceInboxCompletionNotifications({
            nowMs: Date.now,
            schedule: (settle, delay) => {
                const timer = setTimeout(settle, delay);
                scheduled.push(timer);
                return () => {
                    cancelled.push(timer);
                    clearTimeout(timer);
                };
            }
        });
        const subscription = notifications.subscribe(identity);
        let settlements = 0;
        const pending = subscription.wait(500).then(() => {
            settlements += 1;
        });
        notifications.publish(identity, 'awaitable');
        subscription.close();
        await pending;
        await vi.advanceTimersByTimeAsync(500);
        expect(settlements).toBe(1);
        expect(scheduled).toHaveLength(1);
        expect(cancelled).toEqual(scheduled);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps advisory publication nonthrowing when cancellation throws after clearing its timer', async () => {
        vi.useFakeTimers();
        const notifications = new ResourceInboxCompletionNotifications({
            nowMs: Date.now,
            schedule: (settle, delay) => {
                const timer = setTimeout(settle, delay);
                return () => {
                    clearTimeout(timer);
                    throw new Error('cancel failed');
                };
            }
        });
        const subscription = notifications.subscribe(identity);
        let settled = false;
        const pending = subscription.wait(1000).then(() => {
            settled = true;
        });
        expect(() => notifications.publish(identity, 'awaitable')).not.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(true);
        await pending;
        subscription.close();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('Relayed ResourceInbox completion notifications', () => {
    it('relays only a completion no local waiter observed and never relays an accepted one again', async () => {
        vi.useFakeTimers();
        const relayed: ResourceInboxCompletionNotifications.Identity[] = [];
        const notifications = ResourceInboxCompletionNotifications.createDefault((key) => relayed.push(key));
        notifications.publish(identity, 'awaitable');
        expect(relayed).toEqual([identity]);

        const subscription = notifications.subscribe(identity);
        let settlements = 0;
        void subscription.wait(1000).then(() => {
            settlements += 1;
        });
        notifications.publish(identity, 'awaitable');
        await vi.advanceTimersByTimeAsync(0);
        expect(relayed).toEqual([identity]);
        expect(settlements).toBe(1);

        void subscription.wait(1000).then(() => {
            settlements += 1;
        });
        notifications.acceptRelayed(identity);
        await vi.advanceTimersByTimeAsync(0);
        expect(settlements).toBe(2);
        subscription.close();
        notifications.acceptRelayed(identity);
        expect(relayed).toEqual([identity]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('never relays a fire-and-forget completion, which still wakes a local waiter', async () => {
        vi.useFakeTimers();
        const relayed: ResourceInboxCompletionNotifications.Identity[] = [];
        const notifications = ResourceInboxCompletionNotifications.createDefault((key) => relayed.push(key));
        notifications.publish(identity, 'fire-and-forget');
        expect(relayed).toEqual([]);

        const subscription = notifications.subscribe(identity);
        let woke = false;
        void subscription.wait(1000).then(() => {
            woke = true;
        });
        notifications.publish(identity, 'fire-and-forget');
        await vi.advanceTimersByTimeAsync(0);
        expect(woke).toBe(true);
        expect(relayed).toEqual([]);
        subscription.close();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('ResourceInbox completion safety tick', () => {
    const identities = ['first', 'second', 'third'].map((resourceId) => ({ topicId: 'topic', resourceId, contextId: 'context' }));

    it('settles every wait pending at the one instance-wide tick in one turn', async () => {
        vi.useFakeTimers({ now: 0 });
        const notifications = ResourceInboxCompletionNotifications.createDefault();
        const subscriptions = identities.map((key) => notifications.subscribe(key));
        const settledAt: number[] = [];
        for (const subscription of subscriptions) {
            void subscription.wait(RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS).then(() => settledAt.push(Date.now()));
            await vi.advanceTimersByTimeAsync(300);
            expect(vi.getTimerCount()).toBe(1);
        }
        await vi.advanceTimersByTimeAsync(99);
        expect(settledAt).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(settledAt).toEqual([]);
        await Promise.resolve();
        expect(settledAt).toEqual([1000, 1000, 1000]);
        expect(vi.getTimerCount()).toBe(0);
        subscriptions.forEach((subscription) => subscription.close());
    });

    it('runs no tick while no wait is pending and arms a fresh one for the next wait', async () => {
        vi.useFakeTimers({ now: 0 });
        const notifications = ResourceInboxCompletionNotifications.createDefault();
        const subscription = notifications.subscribe(identity);
        expect(vi.getTimerCount()).toBe(0);
        const settledAt: number[] = [];
        const first = subscription.wait(RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS).then(() => settledAt.push(Date.now()));
        await vi.advanceTimersByTimeAsync(1000);
        await first;
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(250);
        const second = subscription.wait(RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS).then(() => settledAt.push(Date.now()));
        await vi.advanceTimersByTimeAsync(1000);
        await second;
        expect(settledAt).toEqual([1000, 2250]);
        subscription.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps its own timer for a wait that ends before the tick and parks a longer one on it', async () => {
        vi.useFakeTimers({ now: 0 });
        const notifications = ResourceInboxCompletionNotifications.createDefault();
        const [ticking, tail, longer] = identities.map((key) => notifications.subscribe(key));
        const settledAt = new Map<string, number>();
        void ticking.wait(RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS).then(() => settledAt.set('ticking', Date.now()));
        await vi.advanceTimersByTimeAsync(200);
        void tail.wait(300).then(() => settledAt.set('tail', Date.now()));
        void longer.wait(5_000).then(() => settledAt.set('longer', Date.now()));
        expect(vi.getTimerCount()).toBe(2);
        await vi.advanceTimersByTimeAsync(299);
        expect(settledAt.has('tail')).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settledAt.get('tail')).toBe(500);
        await vi.advanceTimersByTimeAsync(500);
        expect(Object.fromEntries(settledAt)).toEqual({ tail: 500, ticking: 1000, longer: 1000 });
        expect(vi.getTimerCount()).toBe(0);
        [ticking, tail, longer].forEach((subscription) => subscription.close());
    });

    it('stops the tick once its last pending wait is woken or closed', async () => {
        vi.useFakeTimers({ now: 0 });
        const notifications = ResourceInboxCompletionNotifications.createDefault();
        const [woken, closed] = identities.map((key) => notifications.subscribe(key));
        const settled: string[] = [];
        void woken.wait(RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS).then(() => settled.push('woken'));
        void closed.wait(RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS).then(() => settled.push('closed'));
        expect(vi.getTimerCount()).toBe(1);
        notifications.publish(identities[0], 'awaitable');
        expect(vi.getTimerCount()).toBe(1);
        closed.close();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toEqual(['woken', 'closed']);
        woken.close();
    });

    it('leaves no tick behind when its registration fails, so the next wait arms its own', async () => {
        vi.useFakeTimers({ now: 0 });
        let failNext = true;
        const notifications = new ResourceInboxCompletionNotifications({
            nowMs: Date.now,
            schedule: (settle, delay) => {
                if (failNext) {
                    failNext = false;
                    throw new Error('timer registration failed');
                }
                const timer = setTimeout(settle, delay);
                return () => clearTimeout(timer);
            }
        });
        const subscription = notifications.subscribe(identity);
        await expect(subscription.wait(RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS)).rejects.toThrow('timer registration failed');
        await vi.advanceTimersByTimeAsync(400);
        const settledAt: number[] = [];
        const pending = subscription.wait(RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS).then(() => settledAt.push(Date.now()));
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        await pending;
        expect(settledAt).toEqual([1400]);
        subscription.close();
        expect(vi.getTimerCount()).toBe(0);
    });
});
