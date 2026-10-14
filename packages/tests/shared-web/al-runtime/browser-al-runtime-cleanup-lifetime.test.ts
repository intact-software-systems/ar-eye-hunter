import * as FakeIndexedDb from 'fake-indexeddb';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { initBrowserALRuntimeExpiryEviction } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import { tryRunInIntervals } from '@shared/resilience/try-with-policy.ts';

const scope = { applicationId: 'cleanup-lifetime', workspaceId: 'owned' };
const storage = () => {};
const cleanupStops: (() => void)[] = [];

async function startCleanup(): Promise<() => void> {
    const stop = await initBrowserALRuntimeExpiryEviction({ currentScope: scope, storage, intervalMs: 50 });
    cleanupStops.push(stop);
    return stop;
}

afterEach(() => {
    for (const stop of cleanupStops.splice(0)) {
        stop();
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('owned cleanup lifetime', () => {
    it('removes the recurring timer on stop and never re-arms it', async () => {
        vi.stubGlobal('indexedDB', undefined);
        vi.useFakeTimers();
        const stop = await startCleanup();
        expect(vi.getTimerCount()).toBe(1);
        stop();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(500);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('repeated start and stop owns one current timer and stale stop cannot clear it', async () => {
        vi.stubGlobal('indexedDB', undefined);
        vi.useFakeTimers();
        const first = await startCleanup();
        first();
        const second = await startCleanup();
        first();
        expect(vi.getTimerCount()).toBe(1);
        expect(await startCleanup()).toBe(second);
        second();
        for (let cycle = 0; cycle < 3; cycle += 1) {
            const stop = await startCleanup();
            expect(vi.getTimerCount()).toBe(1);
            stop();
            expect(vi.getTimerCount()).toBe(0);
        }
    });

    it('does not re-arm when a stopped browser cleanup completes its in-flight database listing', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        vi.useFakeTimers();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<IDBDatabaseInfo[]>();
        const databases = vi.spyOn(factory, 'databases').mockResolvedValueOnce([]).mockImplementationOnce(() => {
            entered.resolve();
            return release.promise;
        });
        const stop = await startCleanup();
        await vi.advanceTimersByTimeAsync(50);
        await entered.promise;
        stop();
        release.resolve([]);
        await vi.advanceTimersByTimeAsync(500);
        expect(databases).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('aborting a retry wait releases its timer without another handler attempt', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const lifetime = new AbortController();
        const cause = new Error('periodic stopped');
        let attempts = 0;
        const handled = tryRunInIntervals({
            handler: () => {
                attempts += 1;
                throw new Error('retry');
            },
            intervalMsecs: 50,
            retryIntervalMsecs: 10,
            maxAttempts: 5,
            signal: lifetime.signal
        })
            .catch((error) => error);
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
        lifetime.abort(cause);
        await vi.advanceTimersByTimeAsync(100);
        expect(attempts).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(await handled).toBe(cause);
    });
    it('does not enter a retry after its timer elapses but stop precedes the continuation', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const lifetime = new AbortController();
        let attempts = 0;
        const reason = new Error('stopped at retry admission');
        const handled = tryRunInIntervals({
            handler: () => {
                attempts += 1;
                throw new Error('retry');
            },
            intervalMsecs: 50,
            retryIntervalMsecs: 10,
            maxAttempts: 5,
            signal: lifetime.signal
        }).catch((error) => error);
        await vi.advanceTimersByTimeAsync(0);
        vi.advanceTimersByTime(10);
        lifetime.abort(reason);
        await vi.advanceTimersByTimeAsync(100);
        expect(attempts).toBe(1);
        expect(await handled).toBe(reason);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not invoke a handler for an already aborted lifetime', async () => {
        vi.useFakeTimers();
        const lifetime = new AbortController();
        const reason = new Error('already stopped');
        lifetime.abort(reason);
        let attempts = 0;
        await expect(tryRunInIntervals({
            handler: () => {
                attempts += 1;
                return 'unexpected';
            },
            intervalMsecs: 50,
            retryIntervalMsecs: 10,
            maxAttempts: 3,
            signal: lifetime.signal
        })).rejects.toBe(reason);
        expect(attempts).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('lets an unsupported in-flight handler finish without re-arming after abort', async () => {
        vi.useFakeTimers();
        const lifetime = new AbortController();
        const finished = Promise.withResolvers<string>();
        const reason = new Error('stopped while reading');
        let attempts = 0;
        const handled = tryRunInIntervals({
            handler: () => {
                attempts += 1;
                return finished.promise;
            },
            intervalMsecs: 50,
            retryIntervalMsecs: 10,
            maxAttempts: 3,
            signal: lifetime.signal
        }).catch((error) => error);
        lifetime.abort(reason);
        expect(await handled).toBe(reason);
        finished.resolve('late result');
        await vi.advanceTimersByTimeAsync(500);
        expect(attempts).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('detaches its wait when a host cancellation throws and keeps the late callback inert', async () => {
        vi.useFakeTimers();
        const lifetime = new AbortController();
        let attempts = 0;
        const promise = tryRunInIntervals({ handler: () => ++attempts, intervalMsecs: 50, retryIntervalMsecs: 10, maxAttempts: 3, signal: lifetime.signal });
        await expect(promise).resolves.toBe(1);
        const cancel = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
            throw new Error('host cancellation failed');
        });
        lifetime.abort();
        expect(vi.getTimerCount()).toBe(1);
        cancel.mockRestore();
        await vi.advanceTimersByTimeAsync(500);
        expect(attempts).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});
