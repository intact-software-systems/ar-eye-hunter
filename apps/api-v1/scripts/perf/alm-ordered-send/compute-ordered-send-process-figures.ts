import { computeNearestRank } from '@shared/measurement/compute-nearest-rank.ts';
import { computeNumberExtrema } from '@shared/measurement/compute-number-extrema.ts';

/** The processor time a process has used since it started, as `process.cpuUsage()` reads it, in microseconds. */
export interface OrderedSendCpuUsage {
    readonly userMicros: number;
    readonly systemMicros: number;
}

/** What a run read of its own process over one span of its time: its send window, or its tail. */
export interface OrderedSendProcessSample {
    readonly startedAtMs: number;
    readonly endedAtMs: number;
    readonly cpuAtStart: OrderedSendCpuUsage;
    readonly cpuAtEnd: OrderedSendCpuUsage;
    /** How late each tick of a timer fired that was armed again as each tick fired, in milliseconds, none below 0. */
    readonly loopLagsMs: readonly number[];
}

/**
 * How long the event loop kept a timer waiting. One loop runs the three instances and the load, so a lag here is
 * time every one of them waited, and a delay the report measures includes it.
 */
export interface OrderedSendLoopLagFigures {
    readonly ticks: number;
    /** The percentiles are nearest ranks; they and `maxMs` are null over no tick. */
    readonly p50Ms: number | null;
    readonly p95Ms: number | null;
    readonly p99Ms: number | null;
    readonly maxMs: number | null;
    /** From 0 to 1; null over no tick. */
    readonly shareOfTicksOverOneMsLate: number | null;
}

/**
 * The processor time of the whole process over the span: `process.cpuUsage()` adds up every thread, the event loop's
 * and the runtime's own alike, garbage collection and I/O threads among them. It says how much of the machine the
 * process took, and nothing of whether the one event loop was saturated: read `loopLag` for that.
 */
export interface OrderedSendCpuFigures {
    readonly scope: typeof ORDERED_SEND_CPU_SCOPE;
    readonly userMs: number;
    readonly systemMs: number;
    /** User and system time over the span's length: 1 is one core's worth busy throughout. Null over no length. */
    readonly coresBusy: number | null;
}

/** How loaded the process that ran the cell was over one span: what tells a slow server from a slow harness. */
export interface OrderedSendProcessFigures {
    readonly wallMs: number;
    readonly loopLag: OrderedSendLoopLagFigures;
    readonly cpu: OrderedSendCpuFigures;
}

/** The label every processor figure carries, in the artifact and in the summary. */
const ORDERED_SEND_CPU_SCOPE = 'whole process, every thread';

const MICROS_PER_MS = 1_000;
const LATE_TICK_MS = 1;

export function computeOrderedSendProcessFigures(sample: OrderedSendProcessSample): OrderedSendProcessFigures {
    const wallMs = sample.endedAtMs - sample.startedAtMs;
    const userMs = (sample.cpuAtEnd.userMicros - sample.cpuAtStart.userMicros) / MICROS_PER_MS;
    const systemMs = (sample.cpuAtEnd.systemMicros - sample.cpuAtStart.systemMicros) / MICROS_PER_MS;
    return {
        wallMs,
        loopLag: computeLoopLagFigures(sample.loopLagsMs),
        cpu: {
            scope: ORDERED_SEND_CPU_SCOPE,
            userMs,
            systemMs,
            coresBusy: wallMs > 0 ? (userMs + systemMs) / wallMs : null
        }
    };
}

function computeLoopLagFigures(loopLagsMs: readonly number[]): OrderedSendLoopLagFigures {
    return {
        ticks: loopLagsMs.length,
        p50Ms: computeNearestRank(loopLagsMs, 0.5) ?? null,
        p95Ms: computeNearestRank(loopLagsMs, 0.95) ?? null,
        p99Ms: computeNearestRank(loopLagsMs, 0.99) ?? null,
        maxMs: computeNumberExtrema(loopLagsMs)?.max ?? null,
        shareOfTicksOverOneMsLate: loopLagsMs.length === 0
            ? null
            : loopLagsMs.filter((lagMs) => lagMs > LATE_TICK_MS).length / loopLagsMs.length
    };
}
