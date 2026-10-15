import { startRepeating } from '../resilience/repeating-run.ts';
import { createDefaultBackgroundTimers } from '../resilience/timers.ts';

export type ExpiredEntryEvictionOptions = Readonly<{
    deleteExpiredIntervalMs?: number;
}>;

/** Answers the stop of the eviction, or `undefined` when no interval asks for one. */
export function startExpiredEntryEviction(
    options: ExpiredEntryEvictionOptions,
    deleteExpired: () => number
): (() => void) | undefined {
    const intervalMs = options.deleteExpiredIntervalMs;
    if (intervalMs === undefined) {
        return undefined;
    }

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new Error('deleteExpiredIntervalMs must be a finite positive number');
    }

    return startRepeating({
        timers: createDefaultBackgroundTimers(),
        intervalMs,
        firstRun: 'after-interval',
        run: () => {
            deleteExpired();
        }
    });
}
