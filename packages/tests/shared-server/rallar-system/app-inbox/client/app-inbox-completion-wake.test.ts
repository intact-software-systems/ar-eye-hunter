import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ResourceInboxStatusAndAttempts } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { normalizeAppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import { EntityStatus, toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';

const key = { topicId: 'AppInbox', resourceId: 'request-1', contextId: 'context-1' };
const enqueue = { type: AppInboxType.GROUP_CREATE, ...key, senderId: 'sender-1', data: null };
const completed = { ...toResourceEntryWithKey(key, 'APP_INBOX', { accepted: true }), status: EntityStatus.COMPLETED };
const failure = {
    ...completed,
    resource: JSON.stringify({ type: 'app-inbox-failure', code: 'domain-denied', status: 409, message: 'Denied', issues: null, denial: null, retry: null })
};

afterEach(() => vi.useRealTimers());

describe('AppInbox local completion wait', () => {
    it('ignores a stale expiry after cancellation fails before clearing and a failed read installs a later wait', async () => {
        vi.useFakeTimers();
        let firstTimer: ReturnType<typeof setTimeout> | undefined;
        const notifications = new ResourceInboxCompletionNotifications({
            schedule: (settle, delay) => {
                const timer = setTimeout(settle, delay);
                firstTimer ??= timer;
                return timer;
            },
            cancel: (timer) => {
                if (timer === firstTimer) {
                    throw new Error('cancellation failed before clearing');
                }
                clearTimeout(timer);
            }
        });
        let reads = 0;
        const waiter = createWaiter({
            notifications,
            readStatus: async () => {
                reads += 1;
                if (reads === 1) {
                    return { status: 'RESERVED', attempts: 1 };
                }
                if (reads === 2) {
                    throw new Error('transient status read failure');
                }
                return { status: 'COMPLETED', attempts: 1 };
            }
        });
        let returned = false;
        const pending = waiter.waitForResult(enqueue, key, (value) => value).then((result) => {
            returned = true;
            return result;
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(() => notifications.publish(key)).not.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(2);
        expect(vi.getTimerCount()).toBe(2);
        await vi.advanceTimersByTimeAsync(900);
        expect(returned).toBe(false);
        expect(reads).toBe(2);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(100);
        expect((await pending).right).toEqual({ accepted: true });
        expect(reads).toBe(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([false, true])('rereads durable completion immediately during a pending delay with phase timing=%s', async (phaseTiming) => {
        vi.useFakeTimers();
        let status: EntityStatus = EntityStatus.RESERVED;
        let reads = 0;
        const notifications = new ObservedCompletionNotifications();
        const waiter = createWaiter({
            notifications,
            phaseTiming,
            readStatus: async () => {
                reads += 1;
                return { status, attempts: 1 };
            }
        });
        let returned = false;
        const pending = waiter.waitForResult(enqueue, key, (value) => value).then((result) => {
            returned = true;
            return result;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
        status = EntityStatus.COMPLETED;
        notifications.publish(key);
        await vi.advanceTimersByTimeAsync(0);
        expect(returned).toBe(true);
        expect(reads).toBe(2);
        expect((await pending).right).toEqual({ accepted: true });
        expect(notifications.activeSubscriptions).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        notifications.publish(key);
        await vi.advanceTimersByTimeAsync(1000);
        expect(reads).toBe(2);
    });

    it('retains duplicate hints during a nonterminal read without overlapping reads', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        let finishRead: ((row: ResourceInboxStatusAndAttempts) => void) | undefined;
        let reads = 0;
        const waiter = createWaiter({
            notifications,
            readStatus: async () => {
                reads += 1;
                if (reads === 1) {
                    return await new Promise((resolve) => {
                        finishRead = resolve;
                    });
                }
                return { status: 'COMPLETED', attempts: 1 };
            }
        });
        const pending = waiter.waitForResult(enqueue, key, (value) => value);
        for (let duplicate = 0; duplicate < 100; duplicate += 1) {
            notifications.publish(key);
        }
        expect(reads).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
        finishRead?.({ status: 'RESERVED', attempts: 1 });
        await vi.advanceTimersByTimeAsync(0);
        expect((await pending).right).toEqual({ accepted: true });
        expect(reads).toBe(2);
        expect(notifications.activeSubscriptions).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('retains a hint between durable read completion and retry-delay registration', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        let reads = 0;
        const waiter = createWaiter({
            notifications,
            readStatus: async () => {
                reads += 1;
                if (reads === 1) {
                    queueMicrotask(() => notifications.publish(key));
                    return { status: 'RESERVED', attempts: 1 };
                }
                return { status: 'COMPLETED', attempts: 1 };
            }
        });
        const pending = waiter.waitForResult(enqueue, key, (value) => value);
        await vi.advanceTimersByTimeAsync(0);
        expect((await pending).right).toEqual({ accepted: true });
        expect(reads).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([true, false])('uses unchanged polling for a remote commit with capability present=%s', async (present) => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        let status: EntityStatus = EntityStatus.RESERVED;
        let reads = 0;
        const waiter = createWaiter({
            notifications: present ? notifications : undefined,
            readStatus: async () => {
                reads += 1;
                return { status, attempts: 1 };
            }
        });
        const pending = waiter.waitForResult(enqueue, key, (value) => value);
        await vi.advanceTimersByTimeAsync(0);
        status = EntityStatus.COMPLETED;
        await vi.advanceTimersByTimeAsync(999);
        expect(reads).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).right).toEqual({ accepted: true });
        expect(reads).toBe(2);
        expect(notifications.activeSubscriptions).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reads a commit before subscription without retaining a terminal cache', async () => {
        const notifications = new ObservedCompletionNotifications();
        notifications.publish(key);
        const waiter = createWaiter({ notifications, readStatus: async () => ({ status: 'COMPLETED', attempts: 1 }) });
        expect((await waiter.waitForResult(enqueue, key, (value) => value)).right).toEqual({ accepted: true });
        expect(notifications.activeSubscriptions).toBe(0);
    });

    it('lets multiple waiters observe one hint and reread their own durable result', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        let status: EntityStatus = EntityStatus.RESERVED;
        let reads = 0;
        const waiter = createWaiter({
            notifications,
            readStatus: async () => {
                reads += 1;
                return { status, attempts: 1 };
            }
        });
        const pending = [waiter.waitForResult(enqueue, key, (value) => value), waiter.waitForResult(enqueue, key, (value) => value)];
        await vi.advanceTimersByTimeAsync(0);
        expect(notifications.activeSubscriptions).toBe(2);
        expect(vi.getTimerCount()).toBe(2);
        status = EntityStatus.COMPLETED;
        notifications.publish(key);
        await vi.advanceTimersByTimeAsync(0);
        expect((await Promise.all(pending)).map((result) => result.right)).toEqual([{ accepted: true }, { accepted: true }]);
        expect(reads).toBe(4);
        expect(notifications.activeSubscriptions).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('consumes one hint after a failed read, then resumes delay on ongoing read failures', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        let reads = 0;
        const waiter = createWaiter({
            notifications,
            readStatus: async () => {
                reads += 1;
                if (reads === 1) {
                    notifications.publish(key);
                }
                if (reads < 3) {
                    throw new Error('status read unavailable');
                }
                return { status: 'COMPLETED', attempts: 1 };
            }
        });
        const pending = waiter.waitForResult(enqueue, key, (value) => value);
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(2);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(reads).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).right).toEqual({ accepted: true });
        expect(notifications.activeSubscriptions).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['COMPLETED', 'FAILED', 'NON_RETRYABLE'] as const)('keeps durable %s result authority after a hint', async (status) => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        let terminal = false;
        const waiter = createWaiter({
            notifications,
            readStatus: async () => ({ status: terminal ? status : 'RESERVED', attempts: 1 }),
            readResult: async () => status === 'COMPLETED' ? completed : { ...failure, status }
        });
        const pending = waiter.waitForResult(enqueue, key, (value) => value);
        await vi.advanceTimersByTimeAsync(0);
        terminal = true;
        notifications.publish(key);
        await vi.advanceTimersByTimeAsync(0);
        const result = await pending;
        expect(status === 'COMPLETED' ? result.right : result.left?.code).toEqual(status === 'COMPLETED' ? { accepted: true } : 'domain-denied');
        expect(notifications.activeSubscriptions).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([{ result: undefined, code: 'app-inbox-result-not-found' }, { result: { ...completed, resource: '{' }, code: 'app-inbox-result-corrupt' }, {
        result: { ...completed, status: EntityStatus.RESERVED },
        code: 'app-inbox-unavailable'
    }])('preserves $code and cleanup after terminal poll', async ({ result, code }) => {
        const notifications = new ObservedCompletionNotifications();
        const waiter = createWaiter({ notifications, readStatus: async () => ({ status: 'COMPLETED', attempts: 1 }), readResult: async () => result });
        expect((await waiter.waitForResult(enqueue, key, (value) => value)).left?.code).toBe(code);
        expect(notifications.activeSubscriptions).toBe(0);
    });

    it('releases the subscription after a result repository exception', async () => {
        const notifications = new ObservedCompletionNotifications();
        const error = new Error('result read failed');
        const waiter = createWaiter({
            notifications,
            readStatus: async () => ({ status: 'COMPLETED', attempts: 1 }),
            readResult: async () => {
                throw error;
            }
        });
        await expect(waiter.waitForResult(enqueue, key, (value) => value)).rejects.toBe(error);
        expect(notifications.activeSubscriptions).toBe(0);
    });

    it('releases its subscription when retry wait execution rejects', async () => {
        const notifications = new ObservedCompletionNotifications();
        const subscribe = notifications.subscribe.bind(notifications);
        const error = new Error('wait execution failed');
        vi.spyOn(notifications, 'subscribe').mockImplementation((identity) => {
            const subscription = subscribe(identity);
            return {
                ...subscription,
                wait: async () => {
                    throw error;
                }
            };
        });
        const waiter = createWaiter({ notifications, readStatus: async () => ({ status: 'RESERVED', attempts: 1 }) });
        await expect(waiter.waitForResult(enqueue, key, (value) => value)).rejects.toBe(error);
        expect(notifications.activeSubscriptions).toBe(0);
    });

    it('releases subscription and timers after polling budget exhaustion', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        const waiter = createWaiter({
            notifications,
            readStatus: async () => {
                throw new Error('read failed');
            }
        });
        const pending = waiter.waitForResult(enqueue, key, (value) => value);
        await vi.runAllTimersAsync();
        expect((await pending).left?.code).toBe('app-inbox-unavailable');
        expect(notifications.activeSubscriptions).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});

interface WaiterFixture {
    readonly notifications: ResourceInboxCompletionNotifications | undefined;
    readonly readStatus: AppInboxResultWaiter.StatusRepository['readStatusAndAttempts'];
    readonly readResult?: AppInboxResultWaiter.ResultRepository['findByKey'];
    readonly phaseTiming?: boolean;
}

function createWaiter(fixture: WaiterFixture): AppInboxResultWaiter {
    return new AppInboxResultWaiter({
        completionNotifications: fixture.notifications,
        statusRepository: { readStatusAndAttempts: fixture.readStatus },
        resultRepository: { findByKey: fixture.readResult ?? (async () => completed) }
    }, {
        serviceId: 'test',
        timing: () => {
            throw new Error('diagnostic failure');
        },
        options: normalizeAppInboxOptions({
            phaseTiming: fixture.phaseTiming ?? false,
            waitRetryIntervalMsecs: 1000,
            waitMaxRetryIntervalMsecs: 1000,
            waitJitterRatio: 0,
            waitMaxElapsedMsecs: 3000
        })
    });
}

class ObservedCompletionNotifications extends ResourceInboxCompletionNotifications {
    activeSubscriptions = 0;

    constructor() {
        super({ schedule: setTimeout, cancel: clearTimeout });
    }

    override subscribe(identity: ResourceInboxCompletionNotifications.Identity): ResourceInboxCompletionNotifications.Subscription {
        const subscription = super.subscribe(identity);
        this.activeSubscriptions += 1;
        return {
            beginRead: () => subscription.beginRead(),
            wait: (delay) => subscription.wait(delay),
            close: () => {
                subscription.close();
                this.activeSubscriptions -= 1;
            }
        };
    }
}
