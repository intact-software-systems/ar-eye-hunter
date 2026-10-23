import { recordRallarTiming, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import type { Timers } from '@shared/resilience/timers.ts';

export interface StartHeapSampleTimingInput {
    readonly timers: Timers;
    /** Undefined while timing logs are off: nothing is scheduled, so no sample is collected, read or built. */
    readonly timing: RallarTimingSink | undefined;
    readonly serviceId: string;
    readonly intervalMs: number;
    /** Undefined where the runtime exposes no collector; each sample then reads the heap as it stands. */
    readonly collectGarbage: (() => void) | undefined;
    readonly readMemoryUsage: () => Deno.MemoryUsage;
    readonly readUptimeMs: () => number;
}

/**
 * One `api-process heap-sample` line per interval, read after a forced full collection where one is exposed, so
 * successive samples compare the live heap rather than garbage awaiting collection; answers the stop.
 */
export function startHeapSampleTiming(input: StartHeapSampleTimingInput): () => void {
    const timing = input.timing;
    if (timing === undefined) {
        return () => undefined;
    }
    return startRepeating({
        timers: input.timers,
        intervalMs: input.intervalMs,
        firstRun: 'after-interval',
        run: () => recordHeapSample(input, timing)
    });
}

function recordHeapSample(input: StartHeapSampleTimingInput, timing: RallarTimingSink): void {
    input.collectGarbage?.();
    const memory = input.readMemoryUsage();
    recordRallarTiming({
        sink: timing,
        event: {
            component: 'api-process',
            operation: 'heap-sample',
            serviceId: input.serviceId,
            details: {
                rss: memory.rss,
                heapUsed: memory.heapUsed,
                heapTotal: memory.heapTotal,
                external: memory.external,
                forcedGc: input.collectGarbage !== undefined,
                uptimeMs: Math.round(input.readUptimeMs())
            }
        },
        status: 'ok',
        durationMs: input.intervalMs
    });
}
