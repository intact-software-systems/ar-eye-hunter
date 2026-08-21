import type { FleetWorkspaceReportEvidence } from './fleet-workspace-model.ts';
import { createFleetWorkspaceReportEvidence } from './fleet-workspace-model.ts';

export type FleetReportEvidenceCacheResult = Readonly<{
    evidence: FleetWorkspaceReportEvidence;
    revision: object;
}>;

export type FleetReportEvidenceCache = Readonly<{
    get(rawReports: unknown): FleetReportEvidenceCacheResult;
}>;

type CacheEntry = Readonly<{
    key: string;
    result: FleetReportEvidenceCacheResult;
}>;

/** Keeps one validated/indexed Fleet collection without retaining raw input. */
export function createFleetReportEvidenceCache(): FleetReportEvidenceCache {
    let entry: CacheEntry | undefined;
    return Object.freeze({
        get(rawReports) {
            const key = fleetReportRevisionKey(rawReports);
            if (key !== undefined && entry?.key === key) {
                return entry.result;
            }
            const evidence = createFleetWorkspaceReportEvidence(rawReports);
            const result = Object.freeze({
                evidence,
                revision: Object.freeze(Object.create(null)) as object
            });
            entry = key !== undefined && evidence.validation?.ok !== false
                ? { key, result }
                : undefined;
            return result;
        }
    });
}

function fleetReportRevisionKey(rawReports: unknown): string | undefined {
    if (rawReports === undefined) {
        return '["fleet-reports","absent"]';
    }
    if (!Array.isArray(rawReports)) {
        return undefined;
    }
    const revisions: [unknown, string, number][] = [];
    for (const candidate of rawReports) {
        if (!candidate || typeof candidate !== 'object') {
            return undefined;
        }
        const report = candidate as Record<string, unknown>;
        if (
            typeof report.distributedRunId !== 'string' ||
            typeof report.generatedAtEpochMs !== 'number' ||
            !Number.isSafeInteger(report.generatedAtEpochMs)
        ) {
            return undefined;
        }
        revisions.push([
            report.fleetReportSchemaVersion,
            report.distributedRunId,
            report.generatedAtEpochMs
        ]);
    }
    return JSON.stringify(['fleet-reports', revisions]);
}
