import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';

import { decodeGrowthBrowserStats } from './decode-growth-browser-stats.ts';
import {
    decodeGrowthLines,
    decodeJsonLine,
    isPositiveNumber,
    type DecodedGrowthPoints
} from './decode-growth-lines.ts';
import { isApiJsonObject } from './growth-series.ts';
import type { GrowthRun, GrowthSamples } from './growth-verdict.ts';
import type { GrowthRunnerOutcome, GrowthWorkload } from './growth-workload.ts';

/** The sampler's files of one growth-proof run directory, as text. */
export interface GrowthRunFiles {
    readonly runJson: string;
    readonly postgres: string;
    readonly adminSystem: string;
    readonly adminQueues: string;
    readonly adminRealtime: string;
    readonly processRss: string;
    readonly controlRun: string;
    /** Every API process's `heap-sample` timing lines, as the run script split them from its output. */
    readonly apiHeap: string;
}

export interface DecodedGrowthRun {
    readonly run: GrowthRun;
    readonly samples: GrowthSamples;
    /** Sample lines that did not decode, such as a line torn by the sampler's stop; each is skipped. */
    readonly skippedLines: number;
}

export function decodeGrowthRun(files: GrowthRunFiles): Either<readonly string[], DecodedGrowthRun> {
    return decodeGrowthRunSettings(files.runJson).mapRight((run) => {
        const postgres = decodeSampleLines(files.postgres);
        const adminSystem = decodeSampleLines(files.adminSystem);
        const adminQueues = decodeSampleLines(files.adminQueues);
        const adminRealtime = decodeSampleLines(files.adminRealtime);
        const apiHeap = decodeHeapSampleLines(files.apiHeap);
        const processRss = decodeSampleLines(files.processRss);
        const browserStats = decodeGrowthBrowserStats(files.controlRun);
        const decoded = [postgres, adminSystem, adminQueues, adminRealtime, apiHeap, processRss, browserStats];
        return {
            run,
            samples: {
                postgres: postgres.points,
                'admin-system': adminSystem.points,
                'admin-queues': adminQueues.points,
                'admin-realtime': adminRealtime.points,
                'api-heap': apiHeap.points,
                'process-rss': processRss.points,
                'browser-stats': browserStats.points
            },
            skippedLines: decoded.reduce((sum, source) => sum + source.skippedLines, 0)
        };
    });
}

function decodeGrowthRunSettings(text: string): Either<readonly string[], GrowthRun> {
    const value = decodeJsonLine(text);
    const windowStartedAtEpochMs = isApiJsonObject(value) ? value.windowStartedAtEpochMs : undefined;
    if (!isPositiveNumber(windowStartedAtEpochMs)) {
        return Either.ofLeft(['run.json windowStartedAtEpochMs is not a time']);
    }
    const recorded = isApiJsonObject(value) ? value.workload : undefined;
    if (recorded === undefined) {
        return Either.ofRight({ windowStartedAtEpochMs, workload: null });
    }
    const workload = decodeGrowthWorkload(recorded);
    return workload === undefined
        ? Either.ofLeft(['run.json workload is not a recorded runner outcome and churn count'])
        : Either.ofRight({ windowStartedAtEpochMs, workload });
}

function decodeGrowthWorkload(value: ApiJsonValue): GrowthWorkload | undefined {
    if (!isApiJsonObject(value) || !isRunnerOutcome(value.runner) || !Array.isArray(value.churnFailedRunIds)) {
        return undefined;
    }
    const { manifestStartedAtEpochMs, manifestCompletedAtEpochMs, manifestAgents, eventHistoryMaxEvents } = value;
    const { groupCurrentSnapshotCacheMaxEntries, apiProcesses, churnStarted, churnPassed } = value;
    const churnFailedRunIds = value.churnFailedRunIds.filter((runId) => typeof runId === 'string');
    const decodes = isTimeOrNull(manifestStartedAtEpochMs) && isTimeOrNull(manifestCompletedAtEpochMs) &&
        isCount(manifestAgents) && isPositiveCount(eventHistoryMaxEvents) &&
        isPositiveCount(groupCurrentSnapshotCacheMaxEntries) &&
        isPositiveCount(apiProcesses) && isCount(churnStarted) &&
        isCount(churnPassed) &&
        churnFailedRunIds.length === value.churnFailedRunIds.length;
    return decodes
        ? {
            runner: value.runner,
            manifestStartedAtEpochMs,
            manifestCompletedAtEpochMs,
            manifestAgents,
            eventHistoryMaxEvents,
            groupCurrentSnapshotCacheMaxEntries,
            apiProcesses,
            churnStarted,
            churnPassed,
            churnFailedRunIds
        }
        : undefined;
}

function isCount(value: ApiJsonValue | undefined): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveCount(value: ApiJsonValue | undefined): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRunnerOutcome(value: ApiJsonValue | undefined): value is GrowthRunnerOutcome {
    return value === 'passed' || value === 'failed' || value === 'outlasted-window';
}

function isTimeOrNull(value: ApiJsonValue | undefined): value is number | null {
    return value === null || isPositiveNumber(value);
}

/** One `{ "atEpochMs": …, "value": … }` object per line. */
function decodeSampleLines(text: string): DecodedGrowthPoints {
    return decodeGrowthLines(
        text,
        (value) =>
            isApiJsonObject(value) && isPositiveNumber(value.atEpochMs) && value.value !== undefined
                ? [{ atEpochMs: value.atEpochMs, agentId: null, serviceId: null, value: value.value }]
                : undefined
    );
}

/**
 * One `api-process` `heap-sample` timing line per line, each naming the process that took it. A sample taken without
 * a forced full collection measures garbage awaiting collection, so it is skipped.
 */
function decodeHeapSampleLines(text: string): DecodedGrowthPoints {
    return decodeGrowthLines(
        text,
        (value) =>
            isApiJsonObject(value) && value.type === 'rallar.timing' && value.component === 'api-process' &&
                value.operation === 'heap-sample' && isPositiveNumber(value.atEpochMs) &&
                typeof value.serviceId === 'string' && isApiJsonObject(value.details) &&
                value.details.forcedGc === true
                ? [{ atEpochMs: value.atEpochMs, agentId: null, serviceId: value.serviceId, value: value.details }]
                : undefined
    );
}
