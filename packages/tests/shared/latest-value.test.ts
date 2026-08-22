import { LatestValue } from '@shared/cache/LatestValue.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('LatestValue', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('refreshes ttl with touch and treats invalid values as expired', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const latest = new LatestValue<number>({
            ttlMs: 100,
            isValid: (value) => value > 0
        });

        latest.accept(5);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.090Z'));
        expect(latest.touch()).toBe(true);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.150Z'));
        expect(latest.read()).toBe(5);
        expect(latest.expired()).toBe(false);

        latest.accept(-1);
        expect(latest.peek()).toBe(-1);
        expect(latest.read()).toBeUndefined();
        expect(latest.expired()).toBe(true);
        expect(latest.takeIfExpired()).toBe(-1);
        expect(latest.hasValue()).toBe(false);
        expect(latest.touch()).toBe(false);
    });

    it('supports callback writes and compare-and-set style updates', () => {
        const latest = new LatestValue<number>();
        const callback = latest.asCallback();

        callback(1);

        expect(latest.compareAndSet(2, 3)).toBe(false);
        expect(latest.compareAndSet(1, 2)).toBe(true);
        expect(latest.getAndSet(4)).toBe(2);
        expect(latest.get()).toBe(4);
        expect(latest.getOrElse(10)).toBe(4);
        expect(latest.getOrElseGet(() => 11)).toBe(4);
        expect(latest.take()).toBe(4);
        expect(latest.hasValue()).toBe(false);
    });

    it('validates ttl configuration', () => {
        expect(() => new LatestValue({ ttlMs: -1 })).toThrow(
            'ttlMs must be a finite non-negative number'
        );
    });
});
