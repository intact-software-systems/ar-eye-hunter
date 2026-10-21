import { createDefaultTimers } from '@shared/resilience/timers.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type { ResourceInboxStatusAndAttempts } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { normalizeAppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import type { AppInboxReservationClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-reservation-client.ts';
import { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import { EntityStatus, toResourceEntryWithKey, type Key } from '@shared/queuebox/ResourceEntry.ts';

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
            nowMs: Date.now,
            schedule: (settle, delay) => {
                const timer = setTimeout(settle, delay);
                firstTimer ??= timer;
                return () => {
                    if (timer === firstTimer) {
                        throw new Error('cancellation failed before clearing');
                    }
                    clearTimeout(timer);
                };
            }
        });
        let reads = 0;
        const waiter = createWaiter({
            notifications,
            waitMaxElapsedMsecs: 10_000,
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
        expect(() => notifications.publish(key, 'awaitable')).not.toThrow();
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
        notifications.publish(key, 'awaitable');
        await vi.advanceTimersByTimeAsync(0);
        expect(returned).toBe(true);
        expect(reads).toBe(2);
        expect((await pending).right).toEqual({ accepted: true });
        expect(notifications.activeSubscriptions).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        notifications.publish(key, 'awaitable');
        await vi.advanceTimersByTimeAsync(1000);
        expect(reads).toBe(2);
    });

    it('retains duplicate hints during a nonterminal read without overlapping reads', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        let finishRead: ((row: ResourceInboxStatusAndAttempts) => void) | undefined;
        const firstReadStarted = Promise.withResolvers<void>();
        let reads = 0;
        const waiter = createWaiter({
            notifications,
            readStatus: async () => {
                reads += 1;
                if (reads === 1) {
                    firstReadStarted.resolve();
                    return await new Promise((resolve) => {
                        finishRead = resolve;
                    });
                }
                return { status: 'COMPLETED', attempts: 1 };
            }
        });
        const pending = waiter.waitForResult(enqueue, key, (value) => value);
        await firstReadStarted.promise;
        for (let duplicate = 0; duplicate < 100; duplicate += 1) {
            notifications.publish(key, 'awaitable');
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
                    queueMicrotask(() => notifications.publish(key, 'awaitable'));
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

    it('uses unchanged polling for a remote commit without the completion capability', async () => {
        vi.useFakeTimers();
        let status: EntityStatus = EntityStatus.RESERVED;
        let reads = 0;
        const waiter = createWaiter({
            notifications: undefined,
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
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reads once at subscribe and once on the wake when the completion arrives within the tick', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        const events: RallarTimingEvent[] = [];
        let status: EntityStatus = EntityStatus.RESERVED;
        let reads = 0;
        const waiter = createWaiter({
            notifications,
            phaseTiming: true,
            events,
            waitMaxElapsedMsecs: 10_000,
            readStatus: async () => {
                reads += 1;
                return { status, attempts: 1 };
            }
        });
        const pending = waiter.waitForResult(enqueue, key, (value) => value);
        await vi.advanceTimersByTimeAsync(700);
        expect(reads).toBe(1);
        status = EntityStatus.COMPLETED;
        notifications.publish(key, 'awaitable');
        await vi.advanceTimersByTimeAsync(0);
        expect((await pending).right).toEqual({ accepted: true });
        expect(reads).toBe(2);
        expect(events.filter((event) => event.operation === 'wait-poll').map((event) => event.details?.queueObservation))
            .toEqual(['RESERVED', 'COMPLETED']);
        expect(events.filter((event) => event.operation === 'wait-retry').map((event) => event.details?.delayMsecs))
            .toEqual([1_000]);
        expect(notifications.activeSubscriptions).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['local', 'relayed'] as const)(
        'wakes the waiter of a server with a pub/sub relay on a %s completion, before any timed re-read',
        async (origin) => {
            vi.useFakeTimers();
            const relayed: ResourceInboxCompletionNotifications.Identity[] = [];
            const notifications = ResourceInboxCompletionNotifications.createDefault((identity) => relayed.push(identity));
            const events: RallarTimingEvent[] = [];
            let status: EntityStatus = EntityStatus.NEW;
            const waiter = createWaiter({
                notifications,
                phaseTiming: true,
                events,
                waitMaxElapsedMsecs: 10_000,
                readStatus: async () => ({ status, attempts: 1 })
            });
            const pending = waiter.waitForResult(enqueue, key, (value) => value);
            await vi.advanceTimersByTimeAsync(400);

            status = EntityStatus.COMPLETED;
            if (origin === 'local') {
                notifications.publish(key, 'awaitable');
            }
            else {
                notifications.acceptRelayed(key);
            }
            await vi.advanceTimersByTimeAsync(0);

            // A waiter in this process takes the wake itself, so the relay to other servers stays silent.
            expect((await pending).right).toEqual({ accepted: true });
            expect(events.filter((event) => event.operation === 'wait-poll').map((event) => event.details?.queueObservation))
                .toEqual(['NEW', 'COMPLETED']);
            expect(relayed).toEqual([]);
        }
    );

    it('catches a lost wake on the one-second safety tick', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        const events: RallarTimingEvent[] = [];
        let status: EntityStatus = EntityStatus.RESERVED;
        let reads = 0;
        const waiter = createWaiter({
            notifications,
            phaseTiming: true,
            events,
            waitMaxElapsedMsecs: 10_000,
            readStatus: async () => {
                reads += 1;
                return { status, attempts: 1 };
            }
        });
        const pending = waiter.waitForResult(enqueue, key, (value) => value);
        await vi.advanceTimersByTimeAsync(500);
        status = EntityStatus.COMPLETED;
        await vi.advanceTimersByTimeAsync(499);
        expect(reads).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).right).toEqual({ accepted: true });
        expect(reads).toBe(2);
        expect(events.filter((event) => event.operation === 'wait-retry').map((event) => event.details?.delayMsecs))
            .toEqual([1_000]);
        expect(notifications.activeSubscriptions).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps the wait budget when the safety tick does not fit it', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        const events: RallarTimingEvent[] = [];
        let reads = 0;
        const waiter = createWaiter({
            notifications,
            phaseTiming: true,
            events,
            waitMaxElapsedMsecs: 700,
            readStatus: async () => {
                reads += 1;
                return { status: 'RESERVED', attempts: 1 };
            }
        });
        const pending = waiter.waitForResult(enqueue, key, (value) => value);
        await vi.advanceTimersByTimeAsync(699);
        expect(reads).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).left?.code).toBe('app-inbox-unavailable');
        expect(reads).toBe(2);
        expect(events.find((event) => event.operation === 'wait-fallback')?.details?.elapsedMsecs).toBe(700);
        expect(notifications.activeSubscriptions).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reads a commit before subscription without retaining a terminal cache', async () => {
        const notifications = new ObservedCompletionNotifications();
        notifications.publish(key, 'awaitable');
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
        expect(vi.getTimerCount()).toBe(1);
        status = EntityStatus.COMPLETED;
        notifications.publish(key, 'awaitable');
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
                    notifications.publish(key, 'awaitable');
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
        notifications.publish(key, 'awaitable');
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

describe('AppInbox coalesced completion polls', () => {
    const resourceIds = ['request-a', 'request-b', 'request-c'];

    it('answers every waiter of one safety tick with one statement across waiters sharing the repository', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        const table = createStatusTable();
        const groupWaiter = createWaiter({ notifications, readStatus: table.readStatus, waitMaxElapsedMsecs: 10_000 });
        const clientWaiter = createWaiter({ notifications, readStatus: table.readStatus, waitMaxElapsedMsecs: 10_000 });
        const pending = [];
        for (const [index, resourceId] of resourceIds.entries()) {
            table.rows.set(resourceId, { status: 'RESERVED', attempts: 1 });
            const waiter = index === 1 ? clientWaiter : groupWaiter;
            pending.push(waiter.waitForResult({ ...enqueue, resourceId }, { ...key, resourceId }, (value) => value));
            await vi.advanceTimersByTimeAsync(250);
        }
        expect(table.statements).toEqual([1, 1, 1]);
        expect(vi.getTimerCount()).toBe(1);
        resourceIds.forEach((resourceId) => table.rows.set(resourceId, { status: 'COMPLETED', attempts: 1 }));
        await vi.advanceTimersByTimeAsync(250);
        expect((await Promise.all(pending)).map((result) => result.right)).toEqual(resourceIds.map(() => ({ accepted: true })));
        expect(table.statements).toEqual([1, 1, 1, 3]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reads a woken waiter in the turn of its wake while the others stay on the tick', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        const table = createStatusTable();
        resourceIds.forEach((resourceId) => table.rows.set(resourceId, { status: 'NEW', attempts: 0 }));
        const waiter = createWaiter({ notifications, readStatus: table.readStatus, waitMaxElapsedMsecs: 10_000 });
        const pending = resourceIds.map((resourceId) => waiter.waitForResult({ ...enqueue, resourceId }, { ...key, resourceId }, (value) => value));
        await vi.advanceTimersByTimeAsync(0);
        expect(table.statements).toEqual([3]);
        table.rows.set('request-b', { status: 'COMPLETED', attempts: 1 });
        notifications.publish({ ...key, resourceId: 'request-b' }, 'awaitable');
        await vi.advanceTimersByTimeAsync(0);
        expect((await pending[1]).right).toEqual({ accepted: true });
        expect(table.statements).toEqual([3, 1]);
        table.rows.set('request-a', { status: 'COMPLETED', attempts: 1 });
        table.rows.set('request-c', { status: 'COMPLETED', attempts: 1 });
        await vi.advanceTimersByTimeAsync(999);
        expect(table.statements).toEqual([3, 1]);
        await vi.advanceTimersByTimeAsync(1);
        expect((await Promise.all(pending)).map((result) => result.right)).toEqual(resourceIds.map(() => ({ accepted: true })));
        expect(table.statements).toEqual([3, 1, 2]);
    });

    it('fails every waiter of a failed statement as its own read failure and retries each on its own policy', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        const events: RallarTimingEvent[] = [];
        const table = createStatusTable();
        ['request-a', 'request-b'].forEach((resourceId) => table.rows.set(resourceId, { status: 'RESERVED', attempts: 1 }));
        const waiter = createWaiter({ notifications, events, phaseTiming: true, waitMaxElapsedMsecs: 1_500, readStatus: table.readStatus });
        const pending = ['request-a', 'request-b'].map((resourceId) =>
            waiter.waitForResult({ ...enqueue, resourceId }, { ...key, resourceId }, (value) => value)
        );
        await vi.advanceTimersByTimeAsync(0);
        table.failing = true;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(table.statements).toEqual([2, 2]);
        expect(events.filter((event) => event.operation === 'wait-poll' && event.status === 'error').map((event) => event.requestId))
            .toEqual(['request-a', 'request-b']);
        expect(
            events.filter((event) => event.operation === 'wait-retry' && event.details?.attempt === 2).map((
                event
            ) => [event.requestId, event.details?.delayMsecs])
        )
            .toEqual([['request-a', 500], ['request-b', 500]]);
        table.failing = false;
        ['request-a', 'request-b'].forEach((resourceId) => table.rows.set(resourceId, { status: 'COMPLETED', attempts: 1 }));
        await vi.advanceTimersByTimeAsync(500);
        expect((await Promise.all(pending)).map((result) => result.right)).toEqual([{ accepted: true }, { accepted: true }]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('fails only the waiter of a corrupt row while the others of its statement complete on that tick', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        const events: RallarTimingEvent[] = [];
        const table = createStatusTable();
        table.rows.set('request-healthy', { status: 'RESERVED', attempts: 1 });
        table.rows.set('request-corrupt', { status: 'RESERVED', attempts: 1 });
        const waiter = createWaiter({ notifications, events, phaseTiming: true, waitMaxElapsedMsecs: 1_500, readStatus: table.readStatus });
        const healthy = waiter.waitForResult({ ...enqueue, resourceId: 'request-healthy' }, { ...key, resourceId: 'request-healthy' }, (value) => value);
        const corrupt = waiter.waitForResult({ ...enqueue, resourceId: 'request-corrupt' }, { ...key, resourceId: 'request-corrupt' }, (value) => value);
        await vi.advanceTimersByTimeAsync(0);
        table.rows.set('request-healthy', { status: 'COMPLETED', attempts: 1 });
        table.rows.set('request-corrupt', { status: 'UNKNOWN', attempts: 1 });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(table.statements).toEqual([2, 2]);
        expect(events.filter((event) => event.operation === 'wait-poll' && event.status === 'error').map((event) => event.requestId))
            .toEqual(['request-corrupt']);
        expect((await healthy).right).toEqual({ accepted: true });
        await vi.advanceTimersByTimeAsync(500);
        expect((await corrupt).left?.code).toBe('app-inbox-unavailable');
    });

    it('keeps the budget of each waiter sharing the tick, down to its fitted last delay and fallback', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        const events: RallarTimingEvent[] = [];
        const table = createStatusTable();
        const waiter = createWaiter({ notifications, events, phaseTiming: true, waitMaxElapsedMsecs: 1_300, readStatus: table.readStatus });
        table.rows.set('request-a', { status: 'RESERVED', attempts: 1 });
        table.rows.set('request-b', { status: 'RESERVED', attempts: 1 });
        const early = waiter.waitForResult({ ...enqueue, resourceId: 'request-a' }, { ...key, resourceId: 'request-a' }, (value) => value);
        await vi.advanceTimersByTimeAsync(500);
        const late = waiter.waitForResult({ ...enqueue, resourceId: 'request-b' }, { ...key, resourceId: 'request-b' }, (value) => value);
        await vi.advanceTimersByTimeAsync(800);
        expect((await early).left).toMatchObject({ code: 'app-inbox-unavailable', status: 503 });
        table.rows.set('request-b', { status: 'COMPLETED', attempts: 1 });
        await vi.advanceTimersByTimeAsync(500);
        expect((await late).right).toEqual({ accepted: true });
        expect(table.statements).toEqual([1, 1, 2, 1, 1]);
        expect(events.filter((event) => event.operation === 'wait-retry').map((event) => [event.requestId, event.details?.delayMsecs])).toEqual([
            ['request-a', 1_000],
            ['request-b', 1_000],
            ['request-a', 300],
            ['request-b', 800]
        ]);
        expect(events.filter((event) => event.operation === 'wait-fallback').map((event) => [event.requestId, event.details?.elapsedMsecs]))
            .toEqual([['request-a', 1_300]]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('lets a winner wait for its wake or tick before its first read, while a replay reads first and shares the tick', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        const events: RallarTimingEvent[] = [];
        const table = createStatusTable();
        const reads: string[] = [];
        let wakes = 0;
        ['request-winner', 'request-ticked', 'request-replay'].forEach((resourceId) => table.rows.set(resourceId, { status: 'NEW', attempts: 0 }));
        const waiter = createWaiter({
            notifications,
            events,
            phaseTiming: true,
            waitMaxElapsedMsecs: 10_000,
            wakeOwningQueue: () => {
                wakes += 1;
            },
            readStatus: async (read) => {
                reads.push(read.resourceId);
                return await table.readStatus(read);
            }
        });
        const winner = waiter.waitForReservedResult(createReservation('request-winner', true), (value) => value);
        const ticked = waiter.waitForReservedResult(createReservation('request-ticked', true), (value) => value);
        const replay = waiter.waitForReservedResult(createReservation('request-replay', false), (value) => value);
        await vi.advanceTimersByTimeAsync(0);
        expect(wakes).toBe(2);
        expect(reads).toEqual(['request-replay']);
        table.rows.set('request-winner', { status: 'COMPLETED', attempts: 1 });
        notifications.publish({ ...key, resourceId: 'request-winner' }, 'awaitable');
        await vi.advanceTimersByTimeAsync(0);
        expect((await winner).right).toEqual({ accepted: true });
        expect(reads).toEqual(['request-replay', 'request-winner']);
        table.rows.set('request-ticked', { status: 'COMPLETED', attempts: 1 });
        table.rows.set('request-replay', { status: 'COMPLETED', attempts: 1 });
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await Promise.all([ticked, replay])).map((result) => result.right)).toEqual([{ accepted: true }, { accepted: true }]);
        expect(reads).toEqual(['request-replay', 'request-winner', 'request-ticked', 'request-replay']);
        expect(table.statements).toEqual([1, 1, 2]);
        expect(events.filter((event) => event.operation === 'wait-retry' && event.requestId === 'request-winner').map((event) => event.details?.errorMessage))
            .toEqual(['App inbox entry is not complete: unread']);
        expect(
            events.filter((event) => event.operation === 'wait-poll' && event.requestId === 'request-winner').map((event) => event.details?.queueObservation)
        )
            .toEqual(['COMPLETED']);
    });

    it('reads a winner at once when its completion arrives while it wakes the queue', async () => {
        vi.useFakeTimers();
        const notifications = new ObservedCompletionNotifications();
        const table = createStatusTable();
        table.rows.set('request-winner', { status: 'NEW', attempts: 0 });
        const waiter = createWaiter({
            notifications,
            waitMaxElapsedMsecs: 10_000,
            wakeOwningQueue: () => {
                table.rows.set('request-winner', { status: 'COMPLETED', attempts: 1 });
                notifications.publish({ ...key, resourceId: 'request-winner' }, 'awaitable');
            },
            readStatus: table.readStatus
        });
        const winner = waiter.waitForReservedResult(createReservation('request-winner', true), (value) => value);
        await vi.advanceTimersByTimeAsync(0);
        expect(table.statements).toEqual([1]);
        expect((await winner).right).toEqual({ accepted: true });
        expect(vi.getTimerCount()).toBe(0);
    });
});

interface WaiterFixture {
    readonly notifications: ResourceInboxCompletionNotifications | undefined;
    readonly readStatus: AppInboxResultWaiter.StatusRepository['readStatusAndAttempts'];
    readonly readResult?: AppInboxResultWaiter.ResultRepository['findByKey'];
    readonly phaseTiming?: boolean;
    /** Collects the timing lines; absent, the sink throws so the wait is proven independent of diagnostics. */
    readonly events?: RallarTimingEvent[];
    readonly waitMaxElapsedMsecs?: number;
    readonly wakeOwningQueue?: () => void;
}

function createWaiter(fixture: WaiterFixture): AppInboxResultWaiter {
    const events = fixture.events;
    return new AppInboxResultWaiter({
        completionNotifications: fixture.notifications,
        statusRepository: { readStatusAndAttempts: fixture.readStatus },
        resultRepository: { findByKey: fixture.readResult ?? (async () => completed) }
    }, {
        serviceId: 'test',
        timing: events === undefined
            ? () => {
                throw new Error('diagnostic failure');
            }
            : (event) => {
                events.push(event);
            },
        options: normalizeAppInboxOptions({
            phaseTiming: fixture.phaseTiming ?? false,
            waitRetryIntervalMsecs: 1000,
            waitMaxRetryIntervalMsecs: 1000,
            waitJitterRatio: 0,
            waitMaxElapsedMsecs: fixture.waitMaxElapsedMsecs ?? 3000
        }),
        wakeOwningQueue: fixture.wakeOwningQueue
    });
}

function createReservation(
    resourceId: string,
    winner: boolean
): AppInboxReservationClient.MaterializedReservation {
    const reservedKey = { ...key, resourceId };
    return { enqueue: { ...enqueue, resourceId }, key: reservedKey, winner };
}

interface StatusTableRow {
    readonly status: string;
    readonly attempts: number;
}

interface StatusTable {
    readonly rows: Map<string, StatusTableRow>;
    /** The number of keys each status statement asked for. */
    readonly statements: number[];
    failing: boolean;
    readonly readStatus: AppInboxResultWaiter.StatusRepository['readStatusAndAttempts'];
}

/** The Postgres entries repository over a scripted table: its status statement answers present rows by key position. */
function createStatusTable(): StatusTable {
    const table = { rows: new Map<string, StatusTableRow>(), statements: [] as number[], failing: false };
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!Object.hasOwn(stringsOrValues, 'raw')) {
            return stringsOrValues;
        }
        const resourceIds = values[1] as string[];
        table.statements.push(resourceIds.length);
        if (table.failing) {
            return Promise.reject(new Error('status statement failed'));
        }
        const rows = resourceIds.flatMap((resourceId, index) => {
            const row = table.rows.get(resourceId);
            return row === undefined ? [] : [{ key_ordinal: index + 1, ri_status: row.status, ri_attempts: BigInt(row.attempts) }];
        });
        return Promise.resolve(rows as Result);
    }
    sql.begin = async <Result>(work: (transaction: PSqlSql) => Promise<Result>): Promise<Result> => await work(sql);
    const repository = new PSqlResourceInboxEntryRepository(sql, () => new Date());
    return Object.assign(table, { readStatus: (read: Key) => repository.readStatusAndAttempts(read) });
}

class ObservedCompletionNotifications extends ResourceInboxCompletionNotifications {
    activeSubscriptions = 0;

    constructor() {
        super(createDefaultTimers());
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
