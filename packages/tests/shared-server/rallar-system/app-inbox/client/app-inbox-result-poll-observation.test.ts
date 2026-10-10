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
import type { RallarTimingEvent, RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { EntityStatus, toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';

const key = { topicId: 'AppInbox', resourceId: 'request-1', contextId: 'context-1' };
const enqueue = { type: AppInboxType.GROUP_CREATE, ...key, senderId: 'sender-1', data: null };
const durableResult = toResourceEntryWithKey(key, 'APP_INBOX', { accepted: true });
const failureResult = toResourceEntryWithKey(key, 'APP_INBOX', {
    type: 'app-inbox-failure',
    code: 'domain-denied',
    status: 409,
    message: 'Denied',
    issues: null,
    denial: null,
    retry: null
});

afterEach(() => vi.useRealTimers());

describe('AppInbox sampled result polls', () => {
    it.each(
        [
            ['NEW', 'NEW'],
            ['RESERVED', 'RESERVED'],
            ['RETRY', 'RETRY'],
            ['COMPLETED', 'COMPLETED'],
            ['FAILED', 'FAILED'],
            ['NON_RETRYABLE', 'NON_RETRYABLE'],
            ['ABORTED', 'other-status'],
            ['PARTITIONED', 'other-status'],
            ['MERGED', 'other-status']
        ] as const
    )('observes %s and preserves its completion or fallback decision', async (status, queueObservation) => {
        const events: RallarTimingEvent[] = [];
        const waiter = createWaiter({ status, attempts: 7 }, (event) => events.push(event));
        const result = await waiter.waitForResult(enqueue, key, (value) => value);
        if (status === 'COMPLETED') {
            expect(result.right).toEqual({ accepted: true });
        }
        else if (status === 'FAILED' || status === 'NON_RETRYABLE') {
            expect(result.left).toMatchObject({ code: 'domain-denied', status: 409 });
        }
        else {
            expect(result.left).toMatchObject({ code: 'app-inbox-unavailable', status: 503 });
        }
        expect(events.filter((event) => event.operation === 'wait-poll')).toEqual([
            expect.objectContaining({
                component: 'app-inbox-phase',
                status: 'ok',
                requestId: 'request-1',
                serviceId: 'server-1',
                details: { type: 'GROUP_CREATE', ...key, senderId: 'sender-1', queueObservation, attempts: 7 }
            })
        ]);
    });

    it.each([undefined, new Error('private read failure')])('distinguishes missing rows from failed reads without attempts', async (observation) => {
        const events: RallarTimingEvent[] = [];
        const waiter = createWaiter(observation, (event) => events.push(event));
        expect((await waiter.waitForResult(enqueue, key, (value) => value)).left).toMatchObject({ code: 'app-inbox-unavailable' });
        expect(events.filter((event) => event.operation === 'wait-poll')).toEqual([
            expect.objectContaining({
                status: observation === undefined ? 'ok' : 'error',
                details: { type: 'GROUP_CREATE', ...key, senderId: 'sender-1', queueObservation: observation === undefined ? 'missing' : 'read-failure' }
            })
        ]);
    });

    it.each([false, true])('retries an observed failed read with throwing sink=%s before returning the unchanged durable result', async (throwFromSink) => {
        vi.useFakeTimers();
        const events: RallarTimingEvent[] = [];
        const waiter = createWaiter([
            new Error('private read failure'),
            { status: 'RETRY', attempts: 2 },
            { status: 'COMPLETED', attempts: 3 }
        ], (event) => {
            events.push(event);
            if (throwFromSink) {
                throw new Error('sink failure');
            }
        }, { phaseTiming: true, waitMaxElapsedMsecs: 100 });
        const pending = waiter.waitForResult(enqueue, key, (value) => value);
        await vi.runAllTimersAsync();
        expect((await pending).right).toEqual({ accepted: true });
        expect(events.filter((event) => event.operation === 'wait-poll').map((event) => event.details)).toEqual([
            { type: 'GROUP_CREATE', ...key, senderId: 'sender-1', queueObservation: 'read-failure' },
            { type: 'GROUP_CREATE', ...key, senderId: 'sender-1', queueObservation: 'RETRY', attempts: 2 },
            { type: 'GROUP_CREATE', ...key, senderId: 'sender-1', queueObservation: 'COMPLETED', attempts: 3 }
        ]);
    });

    it('captures only polls attempted before the unchanged wait budget expires', async () => {
        vi.useFakeTimers();
        const events: RallarTimingEvent[] = [];
        const waiter = createWaiter({ status: 'NEW', attempts: 0 }, (event) => events.push(event), { phaseTiming: true, waitMaxElapsedMsecs: 1 });
        const pending = waiter.waitForResult(enqueue, key, (value) => value);
        await vi.runAllTimersAsync();
        expect((await pending).left).toMatchObject({ code: 'app-inbox-unavailable' });
        expect(events.filter((event) => event.operation === 'wait-poll').map((event) => event.details?.queueObservation)).toEqual(['NEW', 'NEW']);
        expect(events.find((event) => event.operation === 'wait-fallback')?.details?.elapsedMsecs).toBe(1);
    });

    it('keeps the same narrow read and completion with phase capture disabled', async () => {
        const events: RallarTimingEvent[] = [];
        const waiter = createWaiter({ status: 'COMPLETED', attempts: 1 }, (event) => events.push(event), { phaseTiming: false, waitMaxElapsedMsecs: 0 });
        expect((await waiter.waitForResult(enqueue, key, (value) => value)).right).toEqual({ accepted: true });
        expect(events).toEqual([]);
    });

    it.each([{ status: 'COMPLETED', attempts: 1 } as const, new Error('repository failure')])(
        'isolates a throwing diagnostic sink from mandatory result behavior',
        async (observation) => {
            const waiter = createWaiter(observation, () => {
                throw new Error('sink failure');
            });
            const result = await waiter.waitForResult(enqueue, key, (value) => value);
            expect(observation instanceof Error ? result.left?.code : result.right).toEqual(
                observation instanceof Error ? 'app-inbox-unavailable' : { accepted: true }
            );
        }
    );

    it('preserves terminal result repository exceptions after the observed terminal poll', async () => {
        const events: RallarTimingEvent[] = [];
        const failure = new Error('result repository failure');
        const waiter = new AppInboxResultWaiter({
            statusRepository: { readStatusAndAttempts: async () => ({ status: 'COMPLETED', attempts: 1 }) },
            resultRepository: {
                findByKey: async () => {
                    throw failure;
                }
            }
        }, { serviceId: 'server-1', timing: (event) => events.push(event), options: normalizeAppInboxOptions({ phaseTiming: true, waitMaxElapsedMsecs: 0 }) });
        await expect(waiter.waitForResult(enqueue, key, (value) => value)).rejects.toBe(failure);
        expect(events.find((event) => event.operation === 'wait-poll')?.details?.queueObservation).toBe('COMPLETED');
    });
});

interface PollWaitConfig {
    readonly phaseTiming: boolean;
    readonly waitMaxElapsedMsecs: number;
}

function createWaiter(
    observation: ResourceInboxStatusAndAttempts | Error | undefined | (ResourceInboxStatusAndAttempts | Error | undefined)[],
    timing: RallarTimingSink,
    config: PollWaitConfig = { phaseTiming: true, waitMaxElapsedMsecs: 0 }
): AppInboxResultWaiter {
    const remaining = Array.isArray(observation) ? [...observation] : [observation];
    return new AppInboxResultWaiter({
        statusRepository: {
            readStatusAndAttempts: async () => {
                const row = remaining.length > 1 ? remaining.shift() : remaining[0];
                if (row instanceof Error) {
                    throw row;
                }
                return row;
            }
        },
        resultRepository: {
            findByKey: async () => {
                const last = remaining[remaining.length - 1];
                return !(last instanceof Error) && (last?.status === 'FAILED' || last?.status === 'NON_RETRYABLE')
                    ? { ...failureResult, status: last.status }
                    : { ...durableResult, status: EntityStatus.COMPLETED };
            }
        }
    }, {
        serviceId: 'server-1',
        timing,
        options: normalizeAppInboxOptions({ ...config, waitRetryIntervalMsecs: 1, waitMaxRetryIntervalMsecs: 1, waitJitterRatio: 0 })
    });
}
