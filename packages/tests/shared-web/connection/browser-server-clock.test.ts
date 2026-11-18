import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserServerClock } from '@shared-web/browser/connection/browser-server-clock.ts';

const configuration = {
    baseUrl: 'https://api.example.test',
    expectedServerPeerId: 'server-a',
    requestTimeoutMs: 100,
    policy: { maxRoundTripMs: 100, maxAgeMs: 1_000, maxRelativeDriftPpm: 0, maxMonotonicErrorMs: 0 }
};

afterEach(() => vi.useRealTimers());

describe('browser server clock lifetime', () => {
    it('has no local-clock fallback, advances monotonically, and refreshes its observation', async () => {
        let now = 100;
        let remote = 10_000;
        const clock = new BrowserServerClock(configuration, {
            nowMonotonicMs: () => now,
            fetch: async () => {
                now += 20;
                return Response.json({ serverPeerId: 'server-a', serverNowEpochMs: remote });
            }
        });
        expect(clock.readWindow().left?.code).toBe('unavailable');
        expect((await clock.refresh()).right).toEqual({ earliestEpochMs: 9_999, latestEpochMs: 10_021 });
        now = 170;
        expect(clock.readWindow().right).toEqual({ earliestEpochMs: 10_049, latestEpochMs: 10_071 });
        remote = 10_070;
        expect((await clock.refresh()).right).toEqual({ earliestEpochMs: 10_069, latestEpochMs: 10_091 });
        await clock.close();
    });

    it('keeps a still-valid sample through a failed refresh but latches loss of continuity at expiry', async () => {
        let now = 100;
        let available = true;
        const clock = new BrowserServerClock(configuration, {
            nowMonotonicMs: () => now,
            fetch: async () =>
                available
                    ? Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 10_000 })
                    : new Response('', { status: 503 })
        });
        await clock.refresh();
        available = false;
        now = 200;
        expect((await clock.refresh()).left?.code).toBe('http');
        expect(clock.readWindow().right).toEqual({ earliestEpochMs: 10_099, latestEpochMs: 10_101 });
        now = 1_101;
        expect(clock.readWindow().left?.code).toBe('discontinuity');
        available = true;
        expect((await clock.refresh()).left?.code).toBe('discontinuity');
        clock.invalidate();
        expect((await clock.refresh()).right).toEqual({ earliestEpochMs: 9_999, latestEpochMs: 10_001 });
        await clock.close();
    });

    it('coalesces concurrent refresh requests at the HTTP boundary', async () => {
        let requests = 0;
        const response = Promise.withResolvers<Response>();
        const clock = new BrowserServerClock(configuration, {
            nowMonotonicMs: () => 100,
            fetch: () => {
                requests += 1;
                return response.promise;
            }
        });
        const first = clock.refresh();
        const second = clock.refresh();
        response.resolve(Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 10_000 }));
        expect((await first).right).toEqual({ earliestEpochMs: 9_999, latestEpochMs: 10_001 });
        expect((await second).right).toEqual({ earliestEpochMs: 9_999, latestEpochMs: 10_001 });
        expect(requests).toBe(1);
        await clock.close();
    });

    it('bounds a stalled fetch even when the transport ignores cancellation', async () => {
        vi.useFakeTimers();
        const response = Promise.withResolvers<Response>();
        const clock = new BrowserServerClock(configuration, {
            nowMonotonicMs: () => 100,
            fetch: () => response.promise
        });
        const attempt = clock.refresh();
        await vi.advanceTimersByTimeAsync(100);
        expect((await attempt).left?.code).toBe('timeout');
        response.resolve(Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 10_000 }));
        await vi.runAllTimersAsync();
        expect(clock.readWindow().left?.code).toBe('unavailable');
        await clock.close();
    });

    it('fences invalidated requests without aborting or overwriting the next acquisition', async () => {
        const response = Promise.withResolvers<Response>();
        const requestSignals: (AbortSignal | null | undefined)[] = [];
        const clock = new BrowserServerClock(configuration, {
            nowMonotonicMs: () => 100,
            fetch: (_url, options) => {
                requestSignals.push(options?.signal);
                return requestSignals.length === 1 ? response.promise : Promise.resolve(
                    Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 20_000 })
                );
            }
        });
        const obsolete = clock.refresh();
        clock.invalidate();
        const fresh = clock.refresh();
        expect((await obsolete).left?.code).toBe('invalidated');
        expect((await fresh).right).toEqual({ earliestEpochMs: 19_999, latestEpochMs: 20_001 });
        response.resolve(Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 10_000 }));
        await response.promise;
        expect(requestSignals[0]?.aborted).toBe(true);
        expect(requestSignals[1]?.aborted).toBe(false);
        expect(clock.readWindow().right).toEqual({ earliestEpochMs: 19_999, latestEpochMs: 20_001 });
        await clock.close();
    });

    it('closes promptly with an uncooperative request and cannot reopen', async () => {
        const response = Promise.withResolvers<Response>();
        const clock = new BrowserServerClock(configuration, {
            nowMonotonicMs: () => 100,
            fetch: () => response.promise
        });
        const attempt = clock.refresh();
        await clock.close();
        expect((await attempt).left?.code).toBe('closed');
        clock.invalidate();
        expect((await clock.refresh()).left?.code).toBe('closed');
        expect(clock.readWindow().left?.code).toBe('closed');
        response.resolve(Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 10_000 }));
    });

    it.each([9_000, 11_000])('requires explicit recovery after a server clock step to %i', async (remote) => {
        let serverNow = 10_000;
        const clock = new BrowserServerClock(configuration, {
            nowMonotonicMs: () => 100,
            fetch: async () => Response.json({ serverPeerId: 'server-a', serverNowEpochMs: serverNow })
        });
        await clock.refresh();
        serverNow = remote;
        expect((await clock.refresh()).left?.code).toBe('discontinuity');
        expect(clock.readWindow().left?.code).toBe('discontinuity');
        serverNow = 10_000;
        expect((await clock.refresh()).left?.code).toBe('discontinuity');
        await clock.close();
    });

    it('does not revive an observation after the monotonic clock rolls backwards', async () => {
        let now = 100;
        const clock = new BrowserServerClock(configuration, {
            nowMonotonicMs: () => now,
            fetch: async () => Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 10_000 })
        });
        await clock.refresh();
        now = 200;
        expect(clock.readWindow().right).toEqual({ earliestEpochMs: 10_099, latestEpochMs: 10_101 });
        now = 199;
        expect(clock.readWindow().left?.code).toBe('discontinuity');
        now = 201;
        expect(clock.readWindow().left?.code).toBe('discontinuity');
        await clock.close();
    });

    it('rejects a refresh after sample expiry even when no consumer read the expired sample', async () => {
        let now = 100;
        let serverNow = 10_000;
        const clock = new BrowserServerClock(configuration, {
            nowMonotonicMs: () => now,
            fetch: async () => Response.json({ serverPeerId: 'server-a', serverNowEpochMs: serverNow })
        });
        await clock.refresh();
        now = 1_101;
        serverNow = 11_001;
        expect((await clock.refresh()).left?.code).toBe('discontinuity');
        expect(clock.readWindow().left?.code).toBe('discontinuity');
        await clock.close();
    });

    it.each([199, 205])('latches rollback during a refresh ending at %i', async (rolledBack) => {
        let now = 100;
        let rollback = false;
        const clock = new BrowserServerClock(configuration, {
            nowMonotonicMs: () => now,
            fetch: async () => {
                if (rollback) {
                    now = rolledBack;
                }
                return Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 10_000 });
            }
        });
        await clock.refresh();
        now = 200;
        expect(clock.readWindow().right).toBeDefined();
        now = 210;
        rollback = true;
        expect((await clock.refresh()).left?.code).toBe('discontinuity');
        now = 211;
        expect(clock.readWindow().left?.code).toBe('discontinuity');
        await clock.close();
    });

    it.each([true, false])('latches rollback at request start even when the response succeeds: %s', async (succeeds) => {
        let now = 100;
        let refreshing = false;
        const clock = new BrowserServerClock(configuration, {
            nowMonotonicMs: () => now,
            fetch: async () => {
                if (refreshing) {
                    now = 201;
                    return succeeds
                        ? Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 10_100 })
                        : new Response('', { status: 503 });
                }
                return Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 10_000 });
            }
        });
        await clock.refresh();
        now = 200;
        expect(clock.readWindow().right).toBeDefined();
        now = 199;
        refreshing = true;
        await clock.refresh();
        expect(clock.readWindow().left?.code).toBe('discontinuity');
        await clock.close();
    });

    it('preserves a replacement acquisition when invalidation reenters from fetch', async () => {
        let replace = true;
        const requests = new EventTarget();
        const replacement = Promise.withResolvers<void>();
        const fetch: typeof globalThis.fetch = async () => {
            if (replace) {
                replace = false;
                requests.dispatchEvent(new Event('request'));
                return Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 10_000 });
            }
            return Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 20_000 });
        };
        const clock = new BrowserServerClock(configuration, { nowMonotonicMs: () => 100, fetch });
        requests.addEventListener('request', () => {
            clock.invalidate();
            void clock.refresh().then(() => replacement.resolve());
        }, { once: true });
        expect((await clock.refresh()).left?.code).toBe('invalidated');
        await replacement.promise;
        expect(clock.readWindow().right).toEqual({ earliestEpochMs: 19_999, latestEpochMs: 20_001 });
        await clock.close();
    });
});
