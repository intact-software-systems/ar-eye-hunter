import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CpuProfileShares } from './compute-cpu-profile-shares.ts';
import {
    computeMedian,
    computePercentile,
    computeSendToDispatchPercentiles
} from './compute-send-to-dispatch-percentiles.ts';
import type { DurableSendConfiguration } from './drive-durable-send-harness.ts';
import type { DurableSendRun } from './harness/durable-send-harness-contract.ts';

const REPORT_DIRECTORY = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../tmp/perf/alm-durable-send'
);

export interface DurableSendRunFigures {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly unsettledCount: number;
    /** Ending cause of each send's wait for its batch to go idle, counted; the suite expects only send-owned causes. */
    readonly probeCauses: Readonly<Record<string, number>>;
    /** Every durable probe seen during those waits, counted by cause. */
    readonly observedProbeCauses: Readonly<Record<string, number>>;
    /** Share of sends faster than one frame interval; null on an idle page. */
    readonly fastModeShare: number | null;
    readonly frameLoadBusyShare: number | null;
    readonly frameLatenessP95Ms: number | null;
    readonly sendToDispatchMs: readonly number[];
    readonly phaseOffsetMs: readonly (number | null)[];
    readonly framesStraddled: readonly number[];
}

export interface DurableSendConfigurationFigures extends DurableSendConfiguration {
    readonly runs: readonly DurableSendRunFigures[];
    readonly medianP50Ms: number;
    readonly medianP95Ms: number;
    readonly medianFastModeShare: number | null;
}

export interface DurableSendReport {
    readonly createdAt: string;
    readonly commit: string;
    readonly dirty: boolean;
    readonly browser: string;
    readonly host: string;
    readonly method: DurableSendMethod;
    readonly configurations: readonly DurableSendConfigurationFigures[];
    readonly profile: CpuProfileShares;
}

export interface DurableSendMethod {
    readonly warmupCount: number;
    readonly measuredCount: number;
    readonly runCount: number;
    readonly profiledCount: number;
}

export function toConfigurationFigures(
    configuration: DurableSendConfiguration,
    runs: readonly DurableSendRun[]
): DurableSendConfigurationFigures {
    const figures = runs.map((run) => toRunFigures(configuration, run));
    const fastModeShares = figures.map((run) => run.fastModeShare);
    return {
        ...configuration,
        runs: figures,
        medianP50Ms: computeMedian(figures.map((run) => run.p50Ms), 10),
        medianP95Ms: computeMedian(figures.map((run) => run.p95Ms), 10),
        medianFastModeShare: fastModeShares.includes(null)
            ? null
            : computeMedian(fastModeShares as number[], 100)
    };
}

function toRunFigures(
    configuration: DurableSendConfiguration,
    run: DurableSendRun
): DurableSendRunFigures {
    const sendToDispatchMs = run.samples.map((sample) => sample.sendToDispatchMs);
    const frameIntervalMs = configuration.frameLoad?.frameIntervalMs;
    return {
        ...computeSendToDispatchPercentiles(sendToDispatchMs),
        unsettledCount: run.samples.filter((sample) => sample.probeEnd === 'timeout').length,
        probeCauses: countByKey(run.samples.map((sample) => sample.probeEnd)),
        observedProbeCauses: countByKey(run.samples.flatMap((sample) => sample.observedProbeCauses)),
        fastModeShare: frameIntervalMs === undefined
            ? null
            : toFastModeShare(sendToDispatchMs, frameIntervalMs),
        frameLoadBusyShare: run.frameLoad?.busyShare ?? null,
        frameLatenessP95Ms: run.frameLoad === undefined
            ? null
            : computePercentile(run.frameLoad.frameLatenessMs, 0.95, 100),
        sendToDispatchMs: sendToDispatchMs.map((value) => Math.round(value * 100) / 100),
        phaseOffsetMs: run.samples.map((sample) =>
            sample.phaseOffsetMs === undefined ? null : Math.round(sample.phaseOffsetMs * 100) / 100
        ),
        framesStraddled: run.samples.map((sample) => sample.framesStraddled)
    };
}

function toFastModeShare(sendToDispatchMs: readonly number[], frameIntervalMs: number): number {
    const fastCount = sendToDispatchMs.filter((value) => value < frameIntervalMs).length;
    return Math.round((fastCount / sendToDispatchMs.length) * 100) / 100;
}

function countByKey(keys: readonly string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const key of keys) {
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
}

export async function writeDurableSendReport(report: DurableSendReport): Promise<string> {
    await mkdir(REPORT_DIRECTORY, { recursive: true });
    const path = join(REPORT_DIRECTORY, `${report.createdAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    return path;
}

/** One line per configuration, each naming its figures, so a `grep p50` of the log keeps every row. */
export function toDurableSendTable(report: DurableSendReport): string {
    const rows = report.configurations.map((configuration) => {
        const runs = configuration.runs.map(toRunCell).join('  ');
        return `${configuration.name.padEnd(18)} p50 ${String(configuration.medianP50Ms).padStart(5)} ms  ` +
            `p95 ${String(configuration.medianP95Ms).padStart(5)} ms  ` +
            `fast ${configuration.medianFastModeShare ?? '-'}  runs p50/p95: ${runs}`;
    });
    const { profile } = report;
    const tree = report.dirty ? ' (dirty)' : '';
    return [
        `send-to-dispatch, median of ${report.method.runCount} runs of ${report.method.measuredCount} sends, ` +
        `${report.browser}, ${report.commit.slice(0, 9)}${tree}`,
        ...rows,
        `idle CPU profile over ${report.method.profiledCount} sends: busy ${profile.busyMs} ms; ` +
        `polyfill ${profile.temporalPolyfillPercent} % + JSBI ${profile.jsbiPercent} % = ${profile.temporalPercent} %; ` +
        `codec self ${profile.codecSelfPercent} %, inclusive ${profile.codecInclusivePercent} %; ` +
        `polyfill + JSBI under the codec ${profile.temporalUnderCodecPercent} %`
    ].join('\n');
}

function toRunCell(run: DurableSendRunFigures): string {
    const load = run.frameLoadBusyShare === null
        ? ''
        : ` (fast ${run.fastModeShare}, busy ${run.frameLoadBusyShare}, late p95 ${run.frameLatenessP95Ms})`;
    return `${run.p50Ms}/${run.p95Ms}${load}`;
}
