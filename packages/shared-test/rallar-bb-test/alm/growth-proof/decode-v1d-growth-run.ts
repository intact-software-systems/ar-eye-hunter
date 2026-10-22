import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';

import { isApiJsonObject, type V1dGrowthSamplePoint } from './v1d-growth-series.ts';
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
    readonly apiTimingLog: string;
}

export interface DecodedV1dGrowthRun {
    readonly run: V1dGrowthRun;
    readonly samples: V1dGrowthSamples;
    /** Sample lines that did not decode, such as a line torn by the sampler's stop; each is skipped. */
    readonly skippedLines: number;
}

interface DecodedPoints {
    readonly points: readonly V1dGrowthSamplePoint[];
    readonly skippedLines: number;
}

export function decodeV1dGrowthRun(files: V1dGrowthRunFiles): Either<readonly string[], DecodedV1dGrowthRun> {
    return decodeV1dGrowthRunSettings(files.runJson).mapRight((run) => {
        const postgres = decodeSampleLines(files.postgres);
        const adminSystem = decodeSampleLines(files.adminSystem);
        const adminQueues = decodeSampleLines(files.adminQueues);
        const adminRealtime = decodeSampleLines(files.adminRealtime);
        const apiHeap = decodeHeapSampleLines(files.apiTimingLog);
        const processRss = decodeSampleLines(files.processRss);
        const browserStats = decodeBrowserStatsLines(files.controlRun);
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
    const { manifestStartedAtEpochMs, manifestCompletedAtEpochMs, churnPassed } = value;
    const churnFailedRunIds = value.churnFailedRunIds.filter((runId) => typeof runId === 'string');
    const decodes = isTimeOrNull(manifestStartedAtEpochMs) && isTimeOrNull(manifestCompletedAtEpochMs) &&
        typeof churnPassed === 'number' && churnPassed >= 0 &&
        churnFailedRunIds.length === value.churnFailedRunIds.length;
    return decodes
        ? {
            runner: value.runner,
            manifestStartedAtEpochMs,
            manifestCompletedAtEpochMs,
            churnPassed,
            churnFailedRunIds
        }
        : undefined;
}

function isRunnerOutcome(value: ApiJsonValue | undefined): value is V1dGrowthRunnerOutcome {
    return value === 'passed' || value === 'failed' || value === 'outlasted-window';
}

function isTimeOrNull(value: ApiJsonValue | undefined): value is number | null {
    return value === null || isPositiveNumber(value);
}

/** One `{ "atEpochMs": …, "value": … }` object per line. */
function decodeSampleLines(text: string): DecodedPoints {
    return decodeLines(
        text,
        (value) =>
            isApiJsonObject(value) && isPositiveNumber(value.atEpochMs) && value.value !== undefined
                ? [{ atEpochMs: value.atEpochMs, agentId: null, value: value.value }]
                : undefined
    );
}

/**
 * The API's timing log: the `api-process` `heap-sample` lines among every other line it writes. A sample taken without
 * a forced full collection measures garbage awaiting collection, so it is skipped.
 */
function decodeHeapSampleLines(text: string): DecodedPoints {
    const heapLines = text.split('\n').filter((line) => line.includes('"heap-sample"')).join('\n');
    return decodeLines(
        heapLines,
        (value) =>
            isApiJsonObject(value) && value.type === 'rallar.timing' && value.component === 'api-process' &&
                value.operation === 'heap-sample' && isPositiveNumber(value.atEpochMs) &&
                isApiJsonObject(value.details) &&
                value.details.forcedGc === true
                ? [{ atEpochMs: value.atEpochMs, agentId: null, value: value.details }]
                : undefined
    );
}

/**
 * Each line is one poll of the control run: the `stats` and `events` envelopes it held. A stats event carries one
 * agent's stats snapshot: a periodic stats, a census reading with `browser`, or a `stats` command's ledger reading.
 * Polls overlap, so a snapshot seen twice counts once.
 */
function decodeBrowserStatsLines(text: string): DecodedPoints {
    const decoded = decodeLines(text, (value) => {
        const poll = isApiJsonObject(value) ? value.value : undefined;
        if (!isApiJsonObject(poll)) {
            return undefined;
        }
        return [poll.stats, poll.events].flatMap((envelopes) =>
            Array.isArray(envelopes) ? envelopes.flatMap(decodeBrowserStatsPoint) : []
        );
    });
    const seen = new Set<string>();
    const points = decoded.points.filter((point) => {
        const census = isApiJsonObject(point.value) && point.value.browser !== undefined;
        const key = `${point.agentId}:${point.atEpochMs}:${census ? 'census' : 'stats'}`;
        const first = !seen.has(key);
        seen.add(key);
        return first;
    });
    return { points, skippedLines: decoded.skippedLines };
}

function decodeBrowserStatsPoint(envelope: ApiJsonValue): readonly V1dGrowthSamplePoint[] {
    const event = isApiJsonObject(envelope) ? envelope.payload : undefined;
    const snapshot = isApiJsonObject(event) && event.kind === 'stats' ? event.payload : undefined;
    if (!isApiJsonObject(envelope) || typeof envelope.agentId !== 'string' || !isApiJsonObject(snapshot)) {
        return [];
    }
    const atEpochMs = isPositiveNumber(snapshot.atEpochMs) ? snapshot.atEpochMs : envelope.atEpochMs;
    return isPositiveNumber(atEpochMs)
        ? [{ atEpochMs, agentId: envelope.agentId, value: toBrowserStatsValue(snapshot) }]
        : [];
}

/**
 * The census lists IndexedDB databases by their scoped names; the readers address rows by database family (the
 * name before its first `:`), as `family` and `family/store` totals.
 */
function toBrowserStatsValue(snapshot: ApiJsonObject): ApiJsonObject {
    const browser = snapshot.browser;
    const indexedDb = isApiJsonObject(browser) ? browser.indexedDb : undefined;
    if (!isApiJsonObject(browser) || !isApiJsonObject(indexedDb) || !Array.isArray(indexedDb.databases)) {
        return snapshot;
    }
    const indexedDbRows = new Map<string, number>();
    const addRows = (key: string, rows: number) => indexedDbRows.set(key, (indexedDbRows.get(key) ?? 0) + rows);
    for (const database of indexedDb.databases.filter(isApiJsonObject)) {
        const family = String(database.name).split(':')[0]!;
        const stores = Array.isArray(database.stores) ? database.stores.filter(isApiJsonObject) : [];
        for (const store of stores) {
            const rows = isPositiveNumber(store.rows) ? store.rows : 0;
            addRows(family, rows);
            addRows(`${family}/${String(store.name)}`, rows);
        }
    }
    return { ...snapshot, browser: { ...browser, indexedDbRows: Object.fromEntries(indexedDbRows) } };
}

function decodeLines(
    text: string,
    toPoints: (value: ApiJsonValue | undefined) => readonly V1dGrowthSamplePoint[] | undefined
): DecodedPoints {
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    const decoded = lines.map((line) => toPoints(decodeJsonLine(line)));
    return {
        points: decoded.flatMap((points) => points ?? []),
        skippedLines: decoded.filter((points) => points === undefined).length
    };
}

/** `JSON.parse` yields JSON values only; undefined for a line that is not JSON. */
function decodeJsonLine(text: string): ApiJsonValue | undefined {
    try {
        return JSON.parse(text) as ApiJsonValue;
    }
    catch {
        return undefined;
    }
}

function isPositiveNumber(value: ApiJsonValue | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
