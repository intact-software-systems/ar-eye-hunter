import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CONTROL_QUERY_FRESHNESS_MS,
    createControlQueryService,
    createInitialControlQueryState,
    observeControlQueryFreshness,
    transitionControlQueryState,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-query.ts';

type TestSnapshot = Readonly<{
    runIds: readonly string[];
    distributedRunIds: readonly string[];
}>;

type Deferred<T> = Readonly<{
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}>;

const LIVE_SNAPSHOT: TestSnapshot = {
    runIds: ['run-a'],
    distributedRunIds: ['distributed-a'],
};

const RECOVERED_SNAPSHOT: TestSnapshot = {
    runIds: ['run-b'],
    distributedRunIds: ['distributed-b'],
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return { promise, resolve, reject };
}

function complete(snapshot: TestSnapshot = LIVE_SNAPSHOT) {
    return {
        completeness: 'complete' as const,
        snapshot,
    };
}

function partial(snapshot: TestSnapshot = LIVE_SNAPSHOT) {
    return {
        completeness: 'partial' as const,
        snapshot,
    };
}

function fakeTimerScheduler() {
    return {
        setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
            return setTimeout(callback, delayMs);
        },
        clearTimeout(handle: ReturnType<typeof setTimeout>): void {
            clearTimeout(handle);
        },
    };
}

async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 6; index += 1) {
        await Promise.resolve();
    }
}

afterEach(() => {
    vi.useRealTimers();
});

describe('Recipe Console control query state', () => {
    it('moves from connecting to live on a complete successful snapshot', () => {
        const initial = createInitialControlQueryState<TestSnapshot>();

        expect(initial).toMatchObject({
            status: 'connecting',
            reachability: 'unknown',
            authorization: 'unknown',
            isRefreshing: false,
        });
        expect(initial.snapshot).toBeUndefined();

        const attempting = transitionControlQueryState(initial, {
            type: 'attempt-started',
            atEpochMs: 1_000,
        });
        const succeeded = transitionControlQueryState(attempting, {
            type: 'attempt-succeeded',
            atEpochMs: 1_125,
            result: complete(),
        });

        expect(attempting).toMatchObject({
            status: 'connecting',
            attemptedAtEpochMs: 1_000,
            isRefreshing: true,
        });
        expect(succeeded).toMatchObject({
            status: 'live',
            reachability: 'reachable',
            authorization: 'ready',
            snapshot: LIVE_SNAPSHOT,
            attemptedAtEpochMs: 1_000,
            receivedAtEpochMs: 1_125,
            isRefreshing: false,
        });
        expect(succeeded.lastError).toBeUndefined();
    });

    it('represents a usable snapshot without optional distributed context as partial', () => {
        const succeeded = transitionControlQueryState(
            transitionControlQueryState(createInitialControlQueryState<TestSnapshot>(), {
                type: 'attempt-started',
                atEpochMs: 2_000,
            }),
            {
                type: 'attempt-succeeded',
                atEpochMs: 2_050,
                result: partial({ runIds: ['run-a'], distributedRunIds: [] }),
            },
        );

        expect(succeeded).toMatchObject({
            status: 'partial',
            reachability: 'reachable',
            authorization: 'ready',
            snapshot: { runIds: ['run-a'], distributedRunIds: [] },
        });
    });

    it('retains the last-good snapshot and marks it stale after a failed refresh', () => {
        const live = transitionControlQueryState(
            transitionControlQueryState(createInitialControlQueryState<TestSnapshot>(), {
                type: 'attempt-started',
                atEpochMs: 3_000,
            }),
            {
                type: 'attempt-succeeded',
                atEpochMs: 3_100,
                result: complete(),
            },
        );
        const refreshing = transitionControlQueryState(live, {
            type: 'attempt-started',
            atEpochMs: 8_100,
        });
        const failed = transitionControlQueryState(refreshing, {
            type: 'attempt-failed',
            atEpochMs: 8_200,
            error: {
                kind: 'network',
                message: 'connection refused',
            },
        });

        expect(refreshing.status).toBe('live');
        expect(failed).toMatchObject({
            status: 'stale',
            reachability: 'unreachable',
            authorization: 'ready',
            snapshot: LIVE_SNAPSHOT,
            attemptedAtEpochMs: 8_100,
            receivedAtEpochMs: 3_100,
            isRefreshing: false,
            lastError: {
                kind: 'network',
                message: 'connection refused',
            },
        });
    });

    it('reports an initial network failure as offline without inventing a snapshot', () => {
        const failed = transitionControlQueryState(
            transitionControlQueryState(createInitialControlQueryState<TestSnapshot>(), {
                type: 'attempt-started',
                atEpochMs: 4_000,
            }),
            {
                type: 'attempt-failed',
                atEpochMs: 4_100,
                error: {
                    kind: 'network',
                    message: 'ECONNREFUSED',
                },
            },
        );

        expect(failed).toMatchObject({
            status: 'offline',
            reachability: 'unreachable',
            authorization: 'unknown',
            isRefreshing: false,
        });
        expect(failed.snapshot).toBeUndefined();
        expect(failed.receivedAtEpochMs).toBeUndefined();
    });

    it.each([401, 403])(
        'keeps HTTP %s reachability separate from authorization',
        status => {
            const failed = transitionControlQueryState(
                transitionControlQueryState(createInitialControlQueryState<TestSnapshot>(), {
                    type: 'attempt-started',
                    atEpochMs: 5_000,
                }),
                {
                    type: 'attempt-failed',
                    atEpochMs: 5_010,
                    error: {
                        kind: 'http',
                        status,
                        message: `Control server request failed with HTTP ${status}`,
                    },
                },
            );

            expect(failed).toMatchObject({
                status: 'offline',
                reachability: 'reachable',
                authorization: 'required',
                lastError: { kind: 'http', status },
            });
        },
    );

    it('retains last-good data as stale when authorization becomes required', () => {
        const live = transitionControlQueryState(
            transitionControlQueryState(createInitialControlQueryState<TestSnapshot>(), {
                type: 'attempt-started',
                atEpochMs: 5_100,
            }),
            {
                type: 'attempt-succeeded',
                atEpochMs: 5_125,
                result: complete(),
            },
        );
        const unauthorized = transitionControlQueryState(
            transitionControlQueryState(live, {
                type: 'attempt-started',
                atEpochMs: 10_125,
            }),
            {
                type: 'attempt-failed',
                atEpochMs: 10_150,
                error: { kind: 'http', status: 401, message: 'Unauthorized' },
            },
        );

        expect(unauthorized).toMatchObject({
            status: 'stale',
            reachability: 'reachable',
            authorization: 'required',
            snapshot: LIVE_SNAPSHOT,
            receivedAtEpochMs: 5_125,
        });
    });

    it('recovers from stale data and clears the last error and auth warning', () => {
        const initial = createInitialControlQueryState<TestSnapshot>();
        const unauthorized = transitionControlQueryState(
            transitionControlQueryState(initial, {
                type: 'attempt-started',
                atEpochMs: 6_000,
            }),
            {
                type: 'attempt-failed',
                atEpochMs: 6_010,
                error: { kind: 'http', status: 401, message: 'Unauthorized' },
            },
        );
        const recovered = transitionControlQueryState(
            transitionControlQueryState(unauthorized, {
                type: 'attempt-started',
                atEpochMs: 11_010,
            }),
            {
                type: 'attempt-succeeded',
                atEpochMs: 11_100,
                result: complete(RECOVERED_SNAPSHOT),
            },
        );

        expect(recovered).toMatchObject({
            status: 'live',
            reachability: 'reachable',
            authorization: 'ready',
            snapshot: RECOVERED_SNAPSHOT,
            receivedAtEpochMs: 11_100,
        });
        expect(recovered.lastError).toBeUndefined();
    });

    it('keeps data fresh at 15,000ms and marks it stale at 15,001ms', () => {
        expect(CONTROL_QUERY_FRESHNESS_MS).toBe(15_000);
        const live = transitionControlQueryState(
            transitionControlQueryState(createInitialControlQueryState<TestSnapshot>(), {
                type: 'attempt-started',
                atEpochMs: 10_000,
            }),
            {
                type: 'attempt-succeeded',
                atEpochMs: 10_100,
                result: complete(),
            },
        );

        const boundary = observeControlQueryFreshness(
            live,
            10_100 + CONTROL_QUERY_FRESHNESS_MS,
        );
        const overdue = observeControlQueryFreshness(
            live,
            10_100 + CONTROL_QUERY_FRESHNESS_MS + 1,
        );

        expect(boundary).toBe(live);
        expect(boundary.status).toBe('live');
        expect(overdue).toMatchObject({
            status: 'stale',
            snapshot: LIVE_SNAPSHOT,
            receivedAtEpochMs: 10_100,
        });
    });

    it('never regresses client attempt or receipt timestamps when the clock moves backwards', () => {
        const live = transitionControlQueryState(
            transitionControlQueryState(createInitialControlQueryState<TestSnapshot>(), {
                type: 'attempt-started',
                atEpochMs: 20_000,
            }),
            {
                type: 'attempt-succeeded',
                atEpochMs: 20_100,
                result: complete(),
            },
        );
        const regressedAttempt = transitionControlQueryState(live, {
            type: 'attempt-started',
            atEpochMs: 19_000,
        });
        const regressedSuccess = transitionControlQueryState(regressedAttempt, {
            type: 'attempt-succeeded',
            atEpochMs: 19_050,
            result: complete(RECOVERED_SNAPSHOT),
        });

        expect(regressedAttempt.attemptedAtEpochMs).toBe(20_100);
        expect(regressedSuccess.attemptedAtEpochMs).toBe(20_100);
        expect(regressedSuccess.receivedAtEpochMs).toBe(20_100);
        expect(regressedSuccess.snapshot).toBe(RECOVERED_SNAPSHOT);
    });
});

describe('Recipe Console serialized control query service', () => {
    it('starts immediately, never overlaps, and schedules the next poll after settlement', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(30_000);
        const first = deferred<ReturnType<typeof complete>>();
        const second = deferred<ReturnType<typeof complete>>();
        const query = vi.fn()
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);
        const service = createControlQueryService<TestSnapshot>({
            query,
            now: Date.now,
            scheduler: fakeTimerScheduler(),
            pollIntervalMs: 5_000,
            requestTimeoutMs: 60_000,
            freshnessMs: CONTROL_QUERY_FRESHNESS_MS,
        });

        service.start();

        expect(query).toHaveBeenCalledTimes(1);
        expect(service.getSnapshot()).toMatchObject({
            status: 'connecting',
            attemptedAtEpochMs: 30_000,
            isRefreshing: true,
        });

        await vi.advanceTimersByTimeAsync(12_000);
        expect(query).toHaveBeenCalledTimes(1);

        first.resolve(complete());
        await flushMicrotasks();
        expect(service.getSnapshot()).toMatchObject({
            status: 'live',
            receivedAtEpochMs: 42_000,
            isRefreshing: false,
        });

        await vi.advanceTimersByTimeAsync(4_999);
        expect(query).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(query).toHaveBeenCalledTimes(2);

        service.stop();
    });

    it('deduplicates concurrent manual refreshes and cancels the superseded poll timer', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(50_000);
        const initial = deferred<ReturnType<typeof complete>>();
        const refreshed = deferred<ReturnType<typeof complete>>();
        const query = vi.fn()
            .mockImplementationOnce(() => initial.promise)
            .mockImplementationOnce(() => refreshed.promise);
        const service = createControlQueryService<TestSnapshot>({
            query,
            now: Date.now,
            scheduler: fakeTimerScheduler(),
            pollIntervalMs: 5_000,
            requestTimeoutMs: 60_000,
        });

        service.start();
        const joinedFirst = service.refresh();
        const joinedSecond = service.refresh();
        expect(query).toHaveBeenCalledTimes(1);

        initial.resolve(complete());
        await Promise.all([joinedFirst, joinedSecond]);
        await flushMicrotasks();

        const manualFirst = service.refresh();
        const manualSecond = service.refresh();
        expect(query).toHaveBeenCalledTimes(2);

        refreshed.resolve(complete(RECOVERED_SNAPSHOT));
        await Promise.all([manualFirst, manualSecond]);
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(query).toHaveBeenCalledTimes(2);

        service.stop();
    });

    it('hard-times out a non-settling query and aborts its request signal', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(70_000);
        let signal: AbortSignal | undefined;
        const service = createControlQueryService<TestSnapshot>({
            query: ({ signal: requestSignal }) => {
                signal = requestSignal;
                return new Promise(() => undefined);
            },
            now: Date.now,
            scheduler: fakeTimerScheduler(),
            pollIntervalMs: 5_000,
            requestTimeoutMs: 4_000,
        });

        service.start();
        await vi.advanceTimersByTimeAsync(4_000);
        await flushMicrotasks();

        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(true);
        expect(service.getSnapshot()).toMatchObject({
            status: 'offline',
            reachability: 'unreachable',
            isRefreshing: false,
            lastError: {
                kind: 'timeout',
                message: expect.stringContaining('4000'),
            },
        });

        service.stop();
    });

    it('classifies timeout ownership before an abort-aware request rejects', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(75_000);
        const service = createControlQueryService<TestSnapshot>({
            query: ({ signal }) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    reject(new DOMException('The operation was aborted.', 'AbortError'));
                }, { once: true });
            }),
            now: Date.now,
            scheduler: fakeTimerScheduler(),
            pollIntervalMs: 5_000,
            requestTimeoutMs: 4_000,
        });

        service.start();
        await vi.advanceTimersByTimeAsync(4_000);
        await flushMicrotasks();

        expect(service.getSnapshot()).toMatchObject({
            status: 'offline',
            reachability: 'unreachable',
            lastError: { kind: 'timeout' },
        });

        service.stop();
    });

    it('classifies structured HTTP authorization failures as reachable', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(80_000);
        const service = createControlQueryService<TestSnapshot>({
            query: async () => {
                throw Object.assign(new Error('Unauthorized'), { status: 401 });
            },
            now: Date.now,
            scheduler: fakeTimerScheduler(),
            pollIntervalMs: 5_000,
            requestTimeoutMs: 4_000,
        });

        service.start();
        await flushMicrotasks();

        expect(service.getSnapshot()).toMatchObject({
            status: 'offline',
            reachability: 'reachable',
            authorization: 'required',
            lastError: { kind: 'http', status: 401 },
        });

        service.stop();
    });

    it('clears timers, aborts in-flight work, and suppresses late results on stop', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(90_000);
        const pending = deferred<ReturnType<typeof complete>>();
        let signal: AbortSignal | undefined;
        const listener = vi.fn();
        const service = createControlQueryService<TestSnapshot>({
            query: ({ signal: requestSignal }) => {
                signal = requestSignal;
                return pending.promise;
            },
            now: Date.now,
            scheduler: fakeTimerScheduler(),
            pollIntervalMs: 5_000,
            requestTimeoutMs: 4_000,
        });
        service.subscribe(listener);

        service.start();
        service.stop();
        const stopped = service.getSnapshot();

        expect(signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        expect(stopped.lastError).toBeUndefined();
        expect(stopped.isRefreshing).toBe(false);
        expect(listener).toHaveBeenCalledTimes(2);

        pending.resolve(complete());
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(service.getSnapshot()).toBe(stopped);
        expect(service.getSnapshot().snapshot).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('can restart after stop while suppressing the result from the previous generation', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100_000);
        const oldRequest = deferred<ReturnType<typeof complete>>();
        const restartedRequest = deferred<ReturnType<typeof complete>>();
        const query = vi.fn()
            .mockImplementationOnce(() => oldRequest.promise)
            .mockImplementationOnce(() => restartedRequest.promise);
        const service = createControlQueryService<TestSnapshot>({
            query,
            now: Date.now,
            scheduler: fakeTimerScheduler(),
            pollIntervalMs: 5_000,
            requestTimeoutMs: 4_000,
        });

        service.start();
        service.stop();
        service.start();
        expect(query).toHaveBeenCalledTimes(2);

        oldRequest.resolve(complete(LIVE_SNAPSHOT));
        await flushMicrotasks();
        expect(service.getSnapshot().snapshot).toBeUndefined();

        restartedRequest.resolve(complete(RECOVERED_SNAPSHOT));
        await flushMicrotasks();
        expect(service.getSnapshot()).toMatchObject({
            status: 'live',
            snapshot: RECOVERED_SNAPSHOT,
            isRefreshing: false,
        });

        service.stop();
    });

    it('does not let an old generation clear the restarted request timeout', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(110_000);
        const oldRequest = deferred<ReturnType<typeof complete>>();
        const restartedRequest = deferred<ReturnType<typeof complete>>();
        let restartedSignal: AbortSignal | undefined;
        const query = vi.fn()
            .mockImplementationOnce(() => oldRequest.promise)
            .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
                restartedSignal = signal;
                return restartedRequest.promise;
            });
        const service = createControlQueryService<TestSnapshot>({
            query,
            now: Date.now,
            scheduler: fakeTimerScheduler(),
            pollIntervalMs: 5_000,
            requestTimeoutMs: 4_000,
        });

        service.start();
        service.stop();
        service.start();
        oldRequest.resolve(complete());
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(4_000);
        await flushMicrotasks();

        expect(restartedSignal?.aborted).toBe(true);
        expect(service.getSnapshot()).toMatchObject({
            status: 'offline',
            lastError: { kind: 'timeout' },
        });

        service.stop();
    });

    it('keeps restarted timeout ownership when the scheduler reuses timer handles', async () => {
        vi.useFakeTimers();
        let callback: (() => void) | undefined;
        const reusedHandle = 1 as unknown as ReturnType<typeof setTimeout>;
        const scheduler = {
            setTimeout(next: () => void): ReturnType<typeof setTimeout> {
                callback = next;
                return reusedHandle;
            },
            clearTimeout(handle: ReturnType<typeof setTimeout>): void {
                if (handle === reusedHandle) {
                    callback = undefined;
                }
            },
        };
        const oldRequest = deferred<ReturnType<typeof complete>>();
        const restartedRequest = deferred<ReturnType<typeof complete>>();
        let restartedSignal: AbortSignal | undefined;
        const query = vi.fn()
            .mockImplementationOnce(() => oldRequest.promise)
            .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
                restartedSignal = signal;
                return restartedRequest.promise;
            });
        const service = createControlQueryService<TestSnapshot>({
            query,
            now: () => 115_000,
            scheduler,
            pollIntervalMs: 5_000,
            requestTimeoutMs: 4_000,
        });

        service.start();
        service.stop();
        service.start();
        oldRequest.resolve(complete());
        await flushMicrotasks();
        expect(callback).toBeTypeOf('function');
        callback?.();
        await flushMicrotasks();

        expect(restartedSignal?.aborted).toBe(true);
        expect(service.getSnapshot()).toMatchObject({
            status: 'offline',
            lastError: { kind: 'timeout' },
        });

        service.stop();
    });

    it('exposes stable snapshots and unsubscribe semantics for external-store consumers', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(120_000);
        const first = deferred<ReturnType<typeof complete>>();
        const second = deferred<ReturnType<typeof complete>>();
        const query = vi.fn()
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);
        const service = createControlQueryService<TestSnapshot>({
            query,
            now: Date.now,
            scheduler: fakeTimerScheduler(),
            pollIntervalMs: 5_000,
            requestTimeoutMs: 4_000,
        });
        const listener = vi.fn();
        const unsubscribe = service.subscribe(listener);

        expect(service.getSnapshot()).toBe(service.getSnapshot());
        service.start();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(service.getSnapshot()).toBe(service.getSnapshot());

        first.resolve(complete());
        await flushMicrotasks();
        expect(listener).toHaveBeenCalledTimes(2);
        expect(service.getSnapshot()).toBe(service.getSnapshot());

        unsubscribe();
        const refresh = service.refresh();
        second.resolve(complete(RECOVERED_SNAPSHOT));
        await refresh;
        await flushMicrotasks();
        expect(listener).toHaveBeenCalledTimes(2);

        service.stop();
    });
});
