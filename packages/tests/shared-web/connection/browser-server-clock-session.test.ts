import { describe, expect, it } from 'vitest';

import { BrowserServerClockSession } from '@shared-web/browser/connection/browser-server-clock-session.ts';
import { BrowserServerClock } from '@shared-web/browser/connection/browser-server-clock.ts';

import { createManualTimers } from '../../shared/resilience/manual-timers.ts';

const clockConfig = {
    baseUrl: 'https://api.example.test',
    expectedServerPeerId: 'server',
    requestTimeoutMs: 50,
    policy: { maxRoundTripMs: 50, maxAgeMs: 200, maxRelativeDriftPpm: 0, maxMonotonicErrorMs: 0 }
};

describe('browser server clock connection lifetime', () => {
    it('acquires before returning and refreshes beyond the first sample lifetime', async () => {
        const timers = createManualTimers(0);
        const clock = new BrowserServerClock(clockConfig, {
            nowMonotonicMs: timers.nowMs,
            fetch: async () => Response.json({ serverPeerId: 'server', serverNowEpochMs: 10_000 + timers.nowMs() })
        });
        const session = new BrowserServerClockSession({
            clock,
            timers,
            page: { document: undefined, window: undefined },
            refreshIntervalMs: 50
        });
        expect((await session.start()).right).toEqual({ earliestEpochMs: 9_999, latestEpochMs: 10_001 });
        await timers.advance(1_000);
        expect(clock.readWindow().right).toEqual({ earliestEpochMs: 10_999, latestEpochMs: 11_001 });
        expect(session.signal.aborted).toBe(false);
        await session.close();
        expect(session.signal.aborted).toBe(true);
        expect(timers.pendingCount()).toBe(0);
    });

    it('preserves a valid sample through a temporary failure and ends the lifetime when it expires', async () => {
        const timers = createManualTimers(0);
        let available = true;
        const clock = new BrowserServerClock(clockConfig, {
            nowMonotonicMs: timers.nowMs,
            fetch: async () =>
                available
                    ? Response.json({ serverPeerId: 'server', serverNowEpochMs: 10_000 + timers.nowMs() })
                    : new Response('', { status: 503 })
        });
        const session = new BrowserServerClockSession({
            clock,
            timers,
            page: { document: undefined, window: undefined },
            refreshIntervalMs: 50
        });
        await session.start();
        available = false;
        await timers.advance(100);
        expect(session.signal.aborted).toBe(false);
        expect(clock.readWindow().right).toEqual({ earliestEpochMs: 10_099, latestEpochMs: 10_101 });
        await timers.advance(150);
        expect(session.signal.aborted).toBe(true);
        expect(timers.pendingCount()).toBe(0);
        available = true;
        expect((await session.start()).left?.code).toBe('closed');
        await session.close();
    });

    it.each(['visibilitychange', 'freeze', 'pagehide'])('ends the clock lifetime on %s', async (event) => {
        const timers = createManualTimers(0);
        const document = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
        const window = new EventTarget();
        const clock = new BrowserServerClock(clockConfig, {
            nowMonotonicMs: timers.nowMs,
            fetch: async () => Response.json({ serverPeerId: 'server', serverNowEpochMs: 10_000 })
        });
        const session = new BrowserServerClockSession({ clock, timers, page: { document, window }, refreshIntervalMs: 50 });
        await session.start();
        document.dispatchEvent(new Event('visibilitychange'));
        expect(session.signal.aborted).toBe(false);
        document.visibilityState = 'hidden';
        (event === 'pagehide' ? window : document).dispatchEvent(new Event(event));
        expect(session.signal.aborted).toBe(true);
        expect(clock.readWindow().left?.code).toBe('closed');
        expect(timers.pendingCount()).toBe(0);
        document.visibilityState = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
        expect((await session.start()).left?.code).toBe('closed');
        await session.close();
    });

    it('cancels startup promptly when the page hides during an uncooperative fetch', async () => {
        const timers = createManualTimers(0);
        const response = Promise.withResolvers<Response>();
        const document = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
        const clock = new BrowserServerClock(clockConfig, {
            nowMonotonicMs: timers.nowMs,
            fetch: () => response.promise
        });
        const session = new BrowserServerClockSession({
            clock,
            timers,
            page: { document, window: undefined },
            refreshIntervalMs: 50
        });
        const starting = session.start();
        document.visibilityState = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
        expect((await starting).left?.code).toBe('closed');
        expect(session.signal.aborted).toBe(true);
        response.resolve(Response.json({ serverPeerId: 'server', serverNowEpochMs: 10_000 }));
        await session.close();
        expect(timers.pendingCount()).toBe(0);
    });

    it('refuses startup on an already hidden page without requesting server time', async () => {
        const timers = createManualTimers(0);
        const document = Object.assign(new EventTarget(), { visibilityState: 'hidden' as DocumentVisibilityState });
        let requests = 0;
        const clock = new BrowserServerClock(clockConfig, {
            nowMonotonicMs: timers.nowMs,
            fetch: async () => {
                requests += 1;
                return Response.json({ serverPeerId: 'server', serverNowEpochMs: 10_000 });
            }
        });
        const session = new BrowserServerClockSession({
            clock,
            timers,
            page: { document, window: undefined },
            refreshIntervalMs: 50
        });
        expect((await session.start()).left?.code).toBe('closed');
        expect(requests).toBe(0);
        expect(session.signal.aborted).toBe(true);
        await session.close();
    });

    it('coalesces startup and owns only one refresh loop', async () => {
        const timers = createManualTimers(0);
        let requests = 0;
        const clock = new BrowserServerClock(clockConfig, {
            nowMonotonicMs: timers.nowMs,
            fetch: async () => {
                requests += 1;
                return Response.json({ serverPeerId: 'server', serverNowEpochMs: 10_000 + timers.nowMs() });
            }
        });
        const session = new BrowserServerClockSession({
            clock,
            timers,
            page: { document: undefined, window: undefined },
            refreshIntervalMs: 50
        });
        await Promise.all([session.start(), session.start()]);
        await session.start();
        expect(requests).toBe(1);
        expect(timers.pendingCount()).toBe(1);
        await timers.advance(50);
        expect(requests).toBe(2);
        expect(timers.pendingCount()).toBe(1);
        await session.close();
    });

    it('ends the lifetime when a consumer discovers expiry between refresh attempts', async () => {
        const timers = createManualTimers(0);
        let monotonicMs = 0;
        const clock = new BrowserServerClock(clockConfig, {
            nowMonotonicMs: () => monotonicMs,
            fetch: async () => Response.json({ serverPeerId: 'server', serverNowEpochMs: 10_000 })
        });
        const session = new BrowserServerClockSession({
            clock,
            timers,
            page: { document: undefined, window: undefined },
            refreshIntervalMs: 50
        });
        await session.start();
        monotonicMs = 201;
        expect(session.readWindow().left?.code).toBe('discontinuity');
        expect(session.signal.aborted).toBe(true);
        expect(timers.pendingCount()).toBe(0);
        await session.close();
    });

    it('cannot return a usable clock when cancellation listeners reenter startup', async () => {
        const timers = createManualTimers(0);
        const clock = new BrowserServerClock(clockConfig, {
            nowMonotonicMs: timers.nowMs,
            fetch: async () => Response.json({ serverPeerId: 'server', serverNowEpochMs: 10_000 })
        });
        const session = new BrowserServerClockSession({
            clock,
            timers,
            page: { document: undefined, window: undefined },
            refreshIntervalMs: 50
        });
        await session.start();
        const restarted = Promise.withResolvers<string | undefined>();
        session.signal.addEventListener('abort', () => {
            void session.start().then((result) => restarted.resolve(result.left?.code));
        });
        await session.close();
        expect(await restarted.promise).toBe('closed');
    });
});
