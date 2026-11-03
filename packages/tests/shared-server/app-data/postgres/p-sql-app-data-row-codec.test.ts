import { AppDataCorruptionError } from '@shared-server/app-data/app-data-corruption-error.ts';
import { decodePSqlAppDataRow } from '@shared-server/app-data/postgres/decode-p-sql-app-data-row.ts';
import type { PSqlAppDataRow } from '@shared-server/app-data/postgres/p-sql-app-data-row.ts';
import { describe, expect, it } from 'vitest';

describe('PostgreSQL app-data row decoding', () => {
    it.each(['text', 'date'] as const)('preserves milliseconds from a %s SQL driver timestamp', (driver) => {
        const expiry = '9999-12-31T23:59:59.999Z';
        const updated = '2026-11-03T12:00:00.123Z';
        const value = decodePSqlAppDataRow({
            ...CURRENT_ROW,
            expire_at_ts: driver === 'text' ? expiry : new Date(expiry),
            updated_ts: driver === 'text' ? updated : new Date(updated)
        });
        expect(value.expireAtTimestamp).toBe(Date.parse(expiry));
        expect(value.updatedTimestamp).toBe(updated);
    });

    it.each([
        ['malformed JSON', { data_value: '{"broken":' }],
        ['negative schema version', { schema_version: -1 }],
        ['fractional revision', { revision: 1.5 }],
        ['invalid expiry timestamp', { expire_at_ts: 'not-a-date' }],
        ['invalid driver date', { updated_ts: new Date(NaN) }],
        ['impossible calendar day', { expire_at_ts: '2026-02-30T00:00:00.000Z' }]
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
