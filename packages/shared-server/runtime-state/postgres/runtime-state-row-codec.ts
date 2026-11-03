import { decodePostgresTimestamp } from '../../postgres/postgres-timestamp.ts';
import type { RuntimeStateEntry } from '../runtime-state-repository.ts';

export interface RuntimeStateDatabaseRow {
    readonly store_namespace: string;
    readonly store_key: string;
    readonly store_value: string;
    readonly updated_ts: string | Date;
    readonly expire_at_ts: string | Date;
    readonly revision: number | string;
}

export function decodeRuntimeStateRow(row: RuntimeStateDatabaseRow): RuntimeStateEntry {
    return {
        key: row.store_key,
        value: row.store_value,
        expireAtTimestamp: decodePostgresTimestamp(
            row.expire_at_ts,
            'runtime state expire_at_ts'
        ).getTime(),
        updatedTimestamp: decodePostgresTimestamp(
            row.updated_ts,
            'runtime state updated_ts'
        ).toISOString(),
        revision: decodeRuntimeStateRevision(row.revision)
    };
}

export function decodeRuntimeStateRevision(value: number | string): number {
    if (typeof value === 'string' && !/^(0|[1-9]\d*)$/u.test(value)) {
        throw new Error(`Invalid runtime state revision: ${value}`);
    }

    const revision = typeof value === 'number' ? value : Number(value);
    if (
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        Object.is(revision, -0)
    ) {
        throw new Error(`Invalid runtime state revision: ${value}`);
    }

    return revision;
}
