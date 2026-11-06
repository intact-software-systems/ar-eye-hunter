import { subscribeViewDeadline } from '@shared-web/browser/api/subscribe-view-deadline.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { afterEach, expect, it, vi } from 'vitest';

interface ExpiringView {
    readonly observedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

afterEach(() => vi.useRealTimers());

it('rechecks once at the server deadline, replaces deadlines, and releases subscriptions', async () => {
    vi.useFakeTimers();
    const views = new SynchronousNotifications<{ readonly view: ExpiringView | null; }>((error) => {
        throw error;
    });
    const refresh = vi.fn();
    const stop = subscribeViewDeadline<ExpiringView>({
        onChange: (listener) => views.subscribe(listener).unsubscribe,
        timers: createDefaultTimers(),
        remainingMs: (view) => view.expiresAtEpochMs - view.observedAtEpochMs,
        refresh
    });
    const first = { observedAtEpochMs: 1000, expiresAtEpochMs: 2000 };
    views.publishLatest({ view: first });
    await vi.advanceTimersByTimeAsync(600);
    views.publishLatest({ view: first });
    await vi.advanceTimersByTimeAsync(400);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(refresh).toHaveBeenCalledTimes(1);
    views.publishLatest({ view: { observedAtEpochMs: 2000, expiresAtEpochMs: 3000 } });
    views.publishLatest({ view: { observedAtEpochMs: 2000, expiresAtEpochMs: 4000 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    views.publishLatest({ view: { observedAtEpochMs: 3000, expiresAtEpochMs: 4000 } });
    stop();
    views.publishLatest({ view: { observedAtEpochMs: 3000, expiresAtEpochMs: 4000 } });
    await vi.advanceTimersByTimeAsync(10000);
    expect(refresh).toHaveBeenCalledTimes(2);
});

it('cancels a private deadline when the view clears and leaves nonexpiring views idle', async () => {
    vi.useFakeTimers();
    const views = new SynchronousNotifications<{ readonly view: ExpiringView | null; }>((error) => {
        throw error;
    });
    const refresh = vi.fn();
    const stop = subscribeViewDeadline<ExpiringView>({
        onChange: (listener) => views.subscribe(listener).unsubscribe,
        timers: createDefaultTimers(),
        remainingMs: (view) => view.expiresAtEpochMs === 0 ? null : view.expiresAtEpochMs - view.observedAtEpochMs,
        refresh
    });
    views.publishLatest({ view: { observedAtEpochMs: 1000, expiresAtEpochMs: 2000 } });
    views.publishLatest({ view: null });
    await vi.advanceTimersByTimeAsync(10000);
    views.publishLatest({ view: { observedAtEpochMs: 1000, expiresAtEpochMs: 0 } });
    await vi.advanceTimersByTimeAsync(10000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
});

it('keeps long invitations dormant without overflowing native timer limits', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const duration = 2_592_000_000;
    const stop = subscribeViewDeadline<ExpiringView>({
        onChange: (listener) => {
            listener({ view: { observedAtEpochMs: 1000, expiresAtEpochMs: 1000 + duration } });
            return () => {};
        },
        timers: createDefaultTimers(),
        remainingMs: (view) => view.expiresAtEpochMs - view.observedAtEpochMs,
        refresh
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(duration - 1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
});
