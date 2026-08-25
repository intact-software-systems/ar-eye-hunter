import { AppDataCorruptionError } from '@shared-server/app-data/app-data-corruption-error.ts';
import { decodePSqlAppDataRow } from '@shared-server/app-data/postgres/decode-p-sql-app-data-row.ts';
import type { PSqlAppDataRow } from '@shared-server/app-data/postgres/p-sql-app-data-row.ts';
import { describe, expect, it } from 'vitest';

describe('PostgreSQL app-data row decoding', () => {
    it.each([
        ['malformed JSON', { data_value: '{"broken":' }],
        ['negative schema version', { schema_version: -1 }],
        ['fractional revision', { revision: 1.5 }],
        ['invalid expiry timestamp', { expire_at_ts: 'not-a-date' }]
    ])('rejects %s at the app-data corruption boundary', (_label, override) => {
        expect(() =>
            decodePSqlAppDataRow({
                ...CURRENT_ROW,
                ...override
            })
        ).toThrow(AppDataCorruptionError);
    });
});

const CURRENT_ROW: PSqlAppDataRow = {
    app_namespace: 'app',
    store_name: 'settings',
    data_key: 'theme',
    data_value: '"dark"',
    schema_version: 1,
    expire_at_ts: '2027-01-01T00:00:00.000Z',
    updated_ts: '2026-01-01T00:00:00.000Z',
    revision: 0
};
