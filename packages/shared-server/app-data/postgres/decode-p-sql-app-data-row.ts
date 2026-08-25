import { decodeJsonWireValue } from '../../rallar-system/protocol/json-wire-identity.ts';
import { AppDataCorruptionError } from '../app-data-corruption-error.ts';
import type { AppDataEntry } from '../app-data-repository.ts';
import type { PSqlAppDataRow } from './p-sql-app-data-row.ts';

export function decodePSqlAppDataRow(row: PSqlAppDataRow): AppDataEntry {
    assertIdentity(row);
    const schemaVersion = decodeNonNegativeInteger(row, row.schema_version, 'schema version');
    const revision = decodeNonNegativeInteger(row, row.revision, 'revision');
    const expireAtTimestamp = Date.parse(row.expire_at_ts);
    if (!Number.isFinite(expireAtTimestamp)) {
        throwCorruption(row, 'has an invalid expiry timestamp.');
    }
    if (!Number.isFinite(Date.parse(row.updated_ts))) {
        throwCorruption(row, 'has an invalid update timestamp.');
    }

    return {
        namespace: row.app_namespace,
        storeName: row.store_name,
        key: row.data_key,
        value: decodeStoredValue(row),
        schemaVersion,
        expireAtTimestamp,
        updatedTimestamp: row.updated_ts,
        revision
    };
}

function decodeStoredValue(row: PSqlAppDataRow): AppDataEntry['value'] {
    try {
        return decodeJsonWireValue(
            JSON.parse(row.data_value),
            'app_data_store.data_value'
        );
    }
    catch (error) {
        throwCorruption(
            row,
            'contains malformed JSON data.',
            error instanceof Error
                ? error
                : new Error('App data JSON decoding threw a non-Error value.')
        );
    }
}

function decodeNonNegativeInteger(
    row: PSqlAppDataRow,
    value: number | string,
    label: string
): number {
    const decoded = Number(value);
    if (!Number.isSafeInteger(decoded) || decoded < 0) {
        throwCorruption(row, `has an invalid ${label}.`);
    }
    return decoded;
}

function assertIdentity(row: PSqlAppDataRow): void {
    if (!row.app_namespace.trim() || !row.store_name.trim() || !row.data_key.trim()) {
        throwCorruption(row, 'has an incomplete persisted identity.');
    }
}

function throwCorruption(
    row: PSqlAppDataRow,
    reason: string,
    cause?: Error
): never {
    throw new AppDataCorruptionError({
        entry: {
            namespace: row.app_namespace,
            storeName: row.store_name,
            key: row.data_key
        },
        reason,
        cause
    });
}
