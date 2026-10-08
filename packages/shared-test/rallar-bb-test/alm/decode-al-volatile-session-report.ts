import type {
    ALVolatileSessionLimits,
    ALVolatileSessionReport,
    ALVolatileSessionUsage
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

const USAGE_FIELDS = [
    'admissions',
    'bytes',
    'oldestAgeMs',
    'tracks'
] as const satisfies readonly (keyof ALVolatileSessionUsage)[];
const LIMIT_FIELDS = [
    'maxAdmissions',
    'maxBytes',
    'maxAgeMs',
    'maxTracks'
] as const satisfies readonly (keyof ALVolatileSessionLimits)[];

/** A page's session ledger report, read off page output or a recorded `stats` event; the left names every bad field. */
export function decodeALVolatileSessionReport(value: unknown): Either<readonly string[], ALVolatileSessionReport> {
    const record = decodeReportRecord(value);
    const usage = decodeReportRecord(record?.usage);
    const limits = decodeReportRecord(record?.limits);
    const overloaded = record?.overloaded;
    const issues = [
        ...USAGE_FIELDS.filter((field) => !isCount(usage?.[field])).map((field) => `usage.${field} is not a count`),
        ...LIMIT_FIELDS.filter((field) => !isCount(limits?.[field])).map((field) => `limits.${field} is not a count`),
        ...(typeof overloaded === 'boolean' ? [] : ['overloaded is not a boolean'])
    ];
    if (usage === undefined || limits === undefined || typeof overloaded !== 'boolean' || issues.length > 0) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        usage: {
            admissions: usage.admissions as number,
            bytes: usage.bytes as number,
            oldestAgeMs: usage.oldestAgeMs as number,
            tracks: usage.tracks as number
        },
        limits: {
            maxAdmissions: limits.maxAdmissions as number,
            maxBytes: limits.maxBytes as number,
            maxAgeMs: limits.maxAgeMs as number,
            maxTracks: limits.maxTracks as number
        },
        overloaded
    });
}

function decodeReportRecord(value: unknown): RallarBlackBoxTestRecord | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as RallarBlackBoxTestRecord
        : undefined;
}

function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
