import type { ALMObservationSnapshot } from './alm-observation-snapshot.ts';
import type { ALMObservationRegimeName } from './compute-alm-observation-regime.ts';

/**
 * 24 hosted cells from eight lane runs of the S2 corpus (`6f6006cfe`, `f33dd8118`, `f870feaf4`,
 * `8fc704552`, `fe718349c`, `c6ded1707`, the RTT-off probe and `7add928af`), read as the median
 * `age-bound` `readiness-probe` `durationMs`, over both roles, from `ALM_OBSERVATION_WINDOW_MS` to
 * `ALM_OBSERVATION_PAGE_WINDOW_END_MS` after the run's first event:
 *
 * | Page | Count | Median band | Cells                                                         |
 * | ---- | ----- | ----------- | ------------------------------------------------------------- |
 * | fast | 6     | 1–3 ms      | the RTT-off probe (1 / 3 / 2) and `6f6006cfe` (2 / 1 / 3)     |
 * | slow | 18    | 66.5–358 ms | every other cell: F 66.5 / 69 / 358, Task 0 113 / 199.5 / 315 |
 *
 * The thresholds sit in the gap between the two bands: `normal` below 20 ms (about 6× the fast
 * band's top of 3 ms) and `slow` at or above 50 ms (below the slow band's lowest cell, 66.5 ms). The
 * band between them stays `unclassified`, as the outbound regime's 30–35 band does.
 */
export const ALM_OBSERVATION_NORMAL_PAGE_MAX_PROBE_MS = 20;
export const ALM_OBSERVATION_SLOW_PAGE_MIN_PROBE_MS = 50;
export const ALM_OBSERVATION_MIN_STORAGE_PROBE_COUNT = 10;
/** The page window opens where the outbound regime's own opening window (`ALM_OBSERVATION_WINDOW_MS`) closes. */
export const ALM_OBSERVATION_PAGE_WINDOW_END_MS = 60_000;
export const ALM_OBSERVATION_STORAGE_PROBE_CAUSE = 'age-bound';

/** The page's storage queue, beside the admission chain `regime` reads; the two together are the runner's verdict. */
export type ALMObservationPageRegime =
    | Readonly<{
        outcome: 'measured';
        storageProbeMedianMs: number;
        sampleCount: number;
        regime: ALMObservationRegimeName;
    }>
    | Readonly<{ outcome: 'unmeasured'; sampleCount: number; regime: 'unclassified'; }>;

/**
 * The page's storage queue, read from its `age-bound` probes over the window that opens where the
 * outbound regime's own window closes -- page start-up contends too, so the reading is deferred past
 * it. `windowStartEpochMs` is the outbound regime's own opening-window boundary, computed by the
 * caller from `ALM_OBSERVATION_WINDOW_MS`, so this module carries no dependency on that constant.
 */
export function computePageRegime(
    snapshot: ALMObservationSnapshot,
    windowStartEpochMs: number
): ALMObservationPageRegime {
    const windowEndEpochMs = snapshot.firstEventAtEpochMs + ALM_OBSERVATION_PAGE_WINDOW_END_MS;
    const durations = snapshot.readinessProbes
        .filter((probe) =>
            probe.cause === ALM_OBSERVATION_STORAGE_PROBE_CAUSE && probe.atEpochMs > windowStartEpochMs &&
            probe.atEpochMs <= windowEndEpochMs
        )
        .map((probe) => probe.durationMs);
    if (durations.length < ALM_OBSERVATION_MIN_STORAGE_PROBE_COUNT) {
        return { outcome: 'unmeasured', sampleCount: durations.length, regime: 'unclassified' };
    }
    const storageProbeMedianMs = toTwoDecimals(computeMedian(durations));
    return {
        outcome: 'measured',
        storageProbeMedianMs,
        sampleCount: durations.length,
        regime: resolvePageRegimeName(storageProbeMedianMs)
    };
}

function resolvePageRegimeName(storageProbeMedianMs: number): ALMObservationRegimeName {
    if (storageProbeMedianMs < ALM_OBSERVATION_NORMAL_PAGE_MAX_PROBE_MS) {
        return 'normal';
    }
    return storageProbeMedianMs >= ALM_OBSERVATION_SLOW_PAGE_MIN_PROBE_MS ? 'slow' : 'unclassified';
}

/**
 * Zero for an empty series rather than `NaN`, so a role with outcomes but no drains still reports.
 * Colocated here (rather than kept private in `compute-alm-observation-regime.ts`) so that file's
 * consumers can import it from this module without creating a runtime import cycle between the two
 * sibling files.
 */
export function computeMedian(values: readonly number[]): number {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function toTwoDecimals(value: number): number {
    return Math.round(value * 100) / 100;
}
