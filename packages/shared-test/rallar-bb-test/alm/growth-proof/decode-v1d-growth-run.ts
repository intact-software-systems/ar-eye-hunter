import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';

import { decodeV1dBrowserStats } from './decode-v1d-browser-stats.ts';
import {
    decodeJsonLine,
    decodeV1dGrowthLines,
    isPositiveNumber,
    type DecodedV1dGrowthPoints
} from './decode-v1d-growth-lines.ts';
import { isApiJsonObject } from './v1d-growth-series.ts';
import type { V1dGrowthRun, V1dGrowthSamples } from './v1d-growth-verdict.ts';
import type { V1dGrowthRunnerOutcome, V1dGrowthWorkload } from './v1d-growth-workload.ts';

/** The sampler's files of one growth-proof run directory, as text. */
export interface V1dGrowthRunFiles {
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

export interface DecodedV1dGrowthRun {
    readonly run: V1dGrowthRun;
    readonly samples: V1dGrowthSamples;
    /** Sample lines that did not decode, such as a line torn by the sampler's stop; each is skipped. */
    readonly skippedLines: number;
}

export function decodeV1dGrowthRun(files: V1dGrowthRunFiles): Either<readonly string[], DecodedV1dGrowthRun> {
    return decodeV1dGrowthRunSettings(files.runJson).mapRight((run) => {
        const postgres = decodeSampleLines(files.postgres);
        const adminSystem = decodeSampleLines(files.adminSystem);
        const adminQueues = decodeSampleLines(files.adminQueues);
        const adminRealtime = decodeSampleLines(files.adminRealtime);
        const apiHeap = decodeHeapSampleLines(files.apiHeap);
        const processRss = decodeSampleLines(files.processRss);
        const browserStats = decodeV1dBrowserStats(files.controlRun);
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

function decodeV1dGrowthRunSettings(text: string): Either<readonly string[], V1dGrowthRun> {
    const value = decodeJsonLine(text);
    const windowStartedAtEpochMs = isApiJsonObject(value) ? value.windowStartedAtEpochMs : undefined;
    if (!isPositiveNumber(windowStartedAtEpochMs)) {
        return Either.ofLeft(['run.json windowStartedAtEpochMs is not a time']);
    }
    const recorded = isApiJsonObject(value) ? value.workload : undefined;
    if (recorded === undefined) {
        return Either.ofRight({ windowStartedAtEpochMs, workload: null });
    }
    const workload = decodeV1dGrowthWorkload(recorded);
    return workload === undefined
        ? Either.ofLeft(['run.json workload is not a recorded runner outcome and churn count'])
        : Either.ofRight({ windowStartedAtEpochMs, workload });
}

function decodeV1dGrowthWorkload(value: ApiJsonValue): V1dGrowthWorkload | undefined {
    if (!isApiJsonObject(value) || !isRunnerOutcome(value.runner) || !Array.isArray(value.churnFailedRunIds)) {
        return undefined;
    }
    const { manifestStartedAtEpochMs, manifestCompletedAtEpochMs, manifestAgents, eventHistoryMaxEvents } = value;
    const { apiProcesses, churnStarted, churnPassed } = value;
    const churnFailedRunIds = value.churnFailedRunIds.filter((runId) => typeof runId === 'string');
    const decodes = isTimeOrNull(manifestStartedAtEpochMs) && isTimeOrNull(manifestCompletedAtEpochMs) &&
        isCount(manifestAgents) && isPositiveCount(eventHistoryMaxEvents) &&
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

function isRunnerOutcome(value: ApiJsonValue | undefined): value is V1dGrowthRunnerOutcome {
    return value === 'passed' || value === 'failed' || value === 'outlasted-window';
}

function isTimeOrNull(value: ApiJsonValue | undefined): value is number | null {
    return value === null || isPositiveNumber(value);
}

/** One `{ "atEpochMs": …, "value": … }` object per line. */
function decodeSampleLines(text: string): DecodedV1dGrowthPoints {
    return decodeV1dGrowthLines(
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
function decodeHeapSampleLines(text: string): DecodedV1dGrowthPoints {
    return decodeV1dGrowthLines(
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
