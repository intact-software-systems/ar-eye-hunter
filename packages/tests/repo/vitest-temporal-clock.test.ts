import {
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

it('advances Temporal and Date together and restores the original clock', () => {
    const originalTemporal = globalThis.Temporal;
    onTestFinished(() => {
        vi.useRealTimers();
    });

    vi.useFakeTimers({ now: 0 });
    expect(Date.now()).toBe(0);
    expect(Temporal.Now.instant().epochMilliseconds).toBe(0);

    vi.advanceTimersByTime(1500);
    expect(Date.now()).toBe(1500);
    expect(Temporal.Now.instant().epochMilliseconds).toBe(1500);

    vi.useRealTimers();
    expect(globalThis.Temporal).toBe(originalTemporal);
});

it('supports a timer-only fake clock without replacing Temporal', () => {
    const originalTemporal = globalThis.Temporal;
    onTestFinished(() => {
        vi.useRealTimers();
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const callback = vi.fn();
    setTimeout(callback, 25);

    vi.advanceTimersByTime(25);
    expect(callback).toHaveBeenCalledOnce();
    expect(globalThis.Temporal).toBe(originalTemporal);
});
