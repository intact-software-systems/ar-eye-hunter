import { expect, test } from '@playwright/test';

import { settleMixedWorkload } from './browser-alm-mixed-workload-settlement.ts';

test('normalizes a non-Error rejection before returning workload evidence', async () => {
    const result = await settleMixedWorkload(
        Promise.resolve([]),
        Promise.reject('live failure'),
        Promise.resolve(null)
    );

    expect(result.firstRejection?.reason).toBeInstanceOf(Error);
    expect(result.live.status).toBe('rejected');
    if (result.live.status === 'rejected') {
        expect(result.live.reason).toBeInstanceOf(Error);
        expect(result.live.reason.message).toBe('live failure');
    }
});

test('records an early live rejection and waits for outstanding work before cleanup', async () => {
    const durable = Promise.withResolvers<readonly string[]>();
    const reconnect = Promise.withResolvers<string>();
    const liveFailure = new TypeError('live send failed');
    let cleanupStarted = false;

    const scenario = (async () => {
        try {
            return await settleMixedWorkload(durable.promise, Promise.reject(liveFailure), reconnect.promise);
        }
        finally {
            cleanupStarted = true;
        }
    })();

    await Promise.resolve();
    expect(cleanupStarted).toBe(false);
    durable.resolve(['durable-1']);
    await Promise.resolve();
    expect(cleanupStarted).toBe(false);
    reconnect.resolve('reconnected');

    const result = await scenario;
    expect(cleanupStarted).toBe(true);
    expect(result.firstRejection).toEqual({ stage: 'send-live-sequence', reason: liveFailure });
    expect(result.durable).toEqual({ status: 'fulfilled', value: ['durable-1'] });
    expect(result.reconnect).toEqual({ status: 'fulfilled', value: 'reconnected' });
});

test('records a durable rejection while retaining completed siblings', async () => {
    const reconnect = Promise.withResolvers<string>();
    const durableFailure = new Error('durable send failed');
    const resultPromise = settleMixedWorkload(
        Promise.reject(durableFailure),
        Promise.resolve('live complete'),
        reconnect.promise
    );
    reconnect.resolve('reconnected');

    const result = await resultPromise;
    expect(result.firstRejection).toEqual({ stage: 'send-durable-burst', reason: durableFailure });
    expect(result.live).toEqual({ status: 'fulfilled', value: 'live complete' });
    expect(result.reconnect).toEqual({ status: 'fulfilled', value: 'reconnected' });
});

test('keeps the first rejection when durable work also fails later', async () => {
    const durable = Promise.withResolvers<string>();
    const reconnect = Promise.withResolvers<string>();
    const liveFailure = new Error('live failed first');
    const durableFailure = new Error('durable failed second');
    const resultPromise = settleMixedWorkload(
        durable.promise,
        Promise.reject(liveFailure),
        reconnect.promise
    );

    await Promise.resolve();
    durable.reject(durableFailure);
    reconnect.resolve('reconnected');

    const result = await resultPromise;
    expect(result.firstRejection).toEqual({ stage: 'send-live-sequence', reason: liveFailure });
    expect(result.durable).toEqual({ status: 'rejected', reason: durableFailure });
    expect(result.reconnect).toEqual({ status: 'fulfilled', value: 'reconnected' });
});
