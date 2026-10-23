import { recordRallarTiming, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { startTimerLagSampling } from '@shared/runtime-health/start-timer-lag-sampling.ts';

export interface StartEventLoopLagTimingInput {
    readonly timers: Timers;
    readonly timing: RallarTimingSink;
    readonly serviceId: string;
}

const LAG_TICK_INTERVAL_MS = 50;
const LAG_WINDOW_MS = 1_000;

/** The API's one JS thread serves HTTP, WebSocket and PGlite, so a late tick measures how long it was occupied. */
export function startEventLoopLagTiming(input: StartEventLoopLagTimingInput): () => void {
    return startTimerLagSampling({
        timers: input.timers,
        tickIntervalMs: LAG_TICK_INTERVAL_MS,
        windowMs: LAG_WINDOW_MS,
        onWindow: (window) =>
            recordRallarTiming({
                sink: input.timing,
                event: {
                    component: 'runtime',
                    operation: 'event-loop-lag',
                    serviceId: input.serviceId,
                    details: {
                        sampleCount: window.sampleCount,
                        maxLagMs: window.maxLagMs,
                        p50LagMs: window.p50LagMs
                    }
                },
                status: 'ok',
                durationMs: window.endedAtMs - window.startedAtMs
            })
    });
}
