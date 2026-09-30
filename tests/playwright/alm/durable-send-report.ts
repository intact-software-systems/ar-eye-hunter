import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CpuProfileShares } from './compute-cpu-profile-shares.ts';
import {
    computeMedian,
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
    /** The share of the run the frame load kept the main thread busy; null on an idle page. */
    readonly frameLoadBusyShare: number | null;
    readonly sendToDispatchMs: readonly number[];
}

export interface DurableSendConfigurationFigures extends DurableSendConfiguration {
    readonly runs: readonly DurableSendRunFigures[];
    /** The median of the runs' p50s and of their p95s. */
    readonly medianP50Ms: number;
    readonly medianP95Ms: number;
}

export interface DurableSendReport {
    readonly createdAt: string;
    readonly commit: string;
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
    const figures = runs.map((run) => ({
        ...computeSendToDispatchPercentiles(run.sendToDispatchMs),
        unsettledCount: run.unsettledCount,
        frameLoadBusyShare: run.frameLoad?.busyShare ?? null,
        sendToDispatchMs: run.sendToDispatchMs.map((value) => Math.round(value * 100) / 100)
    }));
    return {
        ...configuration,
        runs: figures,
        medianP50Ms: computeMedian(figures.map((run) => run.p50Ms)),
        medianP95Ms: computeMedian(figures.map((run) => run.p95Ms))
    };
}

/** Writes the report under `tmp/perf/alm-durable-send/` and returns the file's path. */
export async function writeDurableSendReport(report: DurableSendReport): Promise<string> {
    await mkdir(REPORT_DIRECTORY, { recursive: true });
    const path = join(REPORT_DIRECTORY, `${report.createdAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    return path;
}

/** One line per configuration, each naming its figures, so a `grep p50` of the log keeps every row. */
export function toDurableSendTable(report: DurableSendReport): string {
    const rows = report.configurations.map((configuration) => {
        const runs = configuration.runs.map((run) =>
            `${run.p50Ms}/${run.p95Ms}${run.frameLoadBusyShare === null ? '' : ` (busy ${run.frameLoadBusyShare})`}`
        ).join('  ');
        return `${configuration.name.padEnd(18)} p50 ${String(configuration.medianP50Ms).padStart(5)} ms  ` +
            `p95 ${String(configuration.medianP95Ms).padStart(5)} ms  runs p50/p95: ${runs}`;
    });
    const { profile } = report;
    return [
        `send-to-dispatch, median of ${report.method.runCount} runs of ${report.method.measuredCount} sends, ` +
        `${report.browser}, ${report.commit.slice(0, 9)}`,
        ...rows,
        `idle CPU profile over ${report.method.profiledCount} sends: busy ${profile.busyMs} ms; ` +
        `polyfill ${profile.temporalPolyfillPercent} % + JSBI ${profile.jsbiPercent} % = ${profile.temporalPercent} %; ` +
        `codec self ${profile.codecSelfPercent} %, inclusive ${profile.codecInclusivePercent} %; ` +
        `polyfill + JSBI under the codec ${profile.temporalUnderCodecPercent} %`
    ].join('\n');
}
