import type {
    ALVolatileSessionLimits,
    ALVolatileSessionReport,
    ALVolatileSessionUsage
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { decodeBoolean, decodeRecord } from '../runtime/decode-runtime-result-values.ts';

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
    const record = decodeRecord(value);
    const usage = decodeCounts(record.usage, USAGE_FIELDS, 'usage');
    const limits = decodeCounts(record.limits, LIMIT_FIELDS, 'limits');
    const overloaded = decodeBoolean(record.overloaded);
    if (usage.right === undefined || limits.right === undefined || overloaded === undefined) {
        return Either.ofLeft([
            ...(usage.left ?? []),
            ...(limits.left ?? []),
            ...(overloaded === undefined ? ['overloaded is not a boolean'] : [])
        ]);
    }
    const { admissions, bytes, oldestAgeMs, tracks } = usage.right;
    const { maxAdmissions, maxBytes, maxAgeMs, maxTracks } = limits.right;
    return Either.ofRight({
        usage: { admissions, bytes, oldestAgeMs, tracks },
        limits: { maxAdmissions, maxBytes, maxAgeMs, maxTracks },
        overloaded
    });
}

function decodeCounts<Field extends string>(
    value: unknown,
    fields: readonly Field[],
    path: string
): Either<readonly string[], Readonly<Record<Field, number>>> {
    const record = decodeRecord(value);
    return hasCounts(record, fields)
        ? Either.ofRight(record)
        : Either.ofLeft(
            fields.filter((field) => !isCount(record[field])).map((field) => `${path}.${field} is not a count`)
        );
}

function hasCounts<Field extends string>(
    record: RallarBlackBoxTestRecord,
    fields: readonly Field[]
): record is RallarBlackBoxTestRecord & Readonly<Record<Field, number>> {
    return fields.every((field) => isCount(record[field]));
}

function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
