import { vi } from 'vitest';

/**
 * Inbound admission commits and returns; the work handler delivers on its own batch. Yielding once
 * past the microtask queue settles that batch for an in-memory store, under real or faked timers.
 */
export async function waitForALInboundWork(): Promise<void> {
    if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(0);
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
}
