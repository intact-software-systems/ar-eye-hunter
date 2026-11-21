import { expect, it, vi } from 'vitest';

import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { Either } from '@shared/resilience/Either.ts';

import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import { createDefaultBrowserServerClockFixture } from '../connection/browser-server-clock-fixture.ts';

it('compares a poll closing instant with each live connection window', async () => {
    const facade = createRallarFacade();
    const deadline = 100;
    expect(facade.compareDeadline(deadline)).toBe('unavailable');
    const clock = createDefaultBrowserServerClockFixture(() => deadline);
    const window = vi.spyOn(clock, 'readWindow');
    const middleware = vi.spyOn(BrowserTransportRuntime.prototype, 'readMiddleware');
    try {
        middleware.mockReturnValue(createDefaultApiMiddlewareTestDouble({ serverTime: clock }));
        window.mockReturnValueOnce(Either.ofRight({ earliestEpochMs: 80, latestEpochMs: 99 }));
        expect(facade.compareDeadline(deadline)).toBe('before');
        window.mockReturnValueOnce(Either.ofRight({ earliestEpochMs: 99, latestEpochMs: 100 }));
        expect(facade.compareDeadline(deadline)).toBe('overlaps');
        window.mockReturnValueOnce(Either.ofRight({ earliestEpochMs: 99, latestEpochMs: 101 }));
        expect(facade.compareDeadline(deadline)).toBe('overlaps');
        expect(facade.compareDeadline(deadline)).toBe('at-or-after');
        await clock.close();
        expect(facade.compareDeadline(deadline)).toBe('unavailable');
        middleware.mockReturnValue(createDefaultApiMiddlewareTestDouble({
            serverTime: createDefaultBrowserServerClockFixture(() => 110)
        }));
        expect(facade.compareDeadline(deadline)).toBe('at-or-after');
    }
    finally {
        middleware.mockRestore();
    }
});

it('rejects malformed closing instants even while disconnected', () => {
    const facade = createRallarFacade();
    for (const deadline of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => facade.compareDeadline(deadline)).toThrow(RangeError);
    }
});

it('publishes a minimum grace duration from the upper bound of the current window', async () => {
    const facade = createRallarFacade();
    expect(facade.deadlineAfter(10_000)).toBeUndefined();
    for (const duration of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => facade.deadlineAfter(duration)).toThrow(RangeError);
    }
    const clock = createDefaultBrowserServerClockFixture(() => 10_110);
    const middleware = vi.spyOn(BrowserTransportRuntime.prototype, 'readMiddleware');
    try {
        middleware.mockReturnValue(createDefaultApiMiddlewareTestDouble({ serverTime: clock }));
        const samples = vi.spyOn(clock, 'readWindow');
        samples.mockReturnValueOnce(Either.ofRight({ earliestEpochMs: 99, latestEpochMs: 110 }));
        const deadline = facade.deadlineAfter(10_000);
        expect(deadline).toBe(10_110);
        expect(facade.compareDeadline(deadline!)).toBe('at-or-after');
        expect(facade.deadlineAfter(0)).toBe(10_110);
        expect(() => facade.deadlineAfter(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
        await clock.close();
        expect(facade.deadlineAfter(10_000)).toBeUndefined();
    }
    finally {
        middleware.mockRestore();
    }
});

it('compares and creates deadlines under a maintained authority offset bound', async () => {
    const facade = createRallarFacade();
    const clock = createDefaultBrowserServerClockFixture(() => 100);
    const middleware = vi.spyOn(BrowserTransportRuntime.prototype, 'readMiddleware');
    const authority = { maxAuthorityOffsetMs: 5 };
    try {
        middleware.mockReturnValue(createDefaultApiMiddlewareTestDouble({ serverTime: clock }));
        const window = vi.spyOn(clock, 'readWindow');
        window.mockReturnValue(Either.ofRight({ earliestEpochMs: 90, latestEpochMs: 100 }));
        expect(facade.compareDeadline(106, authority)).toBe('before');
        expect(facade.compareDeadline(105, authority)).toBe('overlaps');
        expect(facade.compareDeadline(86, authority)).toBe('overlaps');
        expect(facade.compareDeadline(85, authority)).toBe('at-or-after');
        expect(facade.deadlineAfter(10, authority)).toBe(115);
        expect(facade.deadlineAfter(0, authority)).toBe(105);
        const max = Number.MAX_SAFE_INTEGER;
        window.mockReturnValue(Either.ofRight({ earliestEpochMs: max, latestEpochMs: max }));
        expect(facade.compareDeadline(max, authority)).toBe('overlaps');
        expect(facade.compareDeadline(max - 5, authority)).toBe('at-or-after');
        expect(() => facade.deadlineAfter(0, authority)).toThrow(RangeError);
    }
    finally {
        middleware.mockRestore();
        await clock.close();
    }
    expect(facade.compareDeadline(100, authority)).toBe('unavailable');
    expect(facade.deadlineAfter(10, authority)).toBeUndefined();
});

it('rejects invalid authority bounds before reading the live connection clock', () => {
    const facade = createRallarFacade();
    for (const maxAuthorityOffsetMs of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const authority = { maxAuthorityOffsetMs };
        expect(() => facade.deadlineAfter(0, authority)).toThrow(RangeError);
        expect(() => facade.compareDeadline(100, authority)).toThrow(RangeError);
    }
});
