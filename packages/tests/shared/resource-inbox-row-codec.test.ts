import { Temporal } from '@js-temporal/polyfill';

import {
    ResourceInboxRowCorruptionError,
    toDomain,
    toPgTimestamp,
    type ResourceInboxRow
} from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

describe('resource inbox row decoding', () => {
    it('rejects a row without the current mandatory attempt count', () => {
        expect(() => toDomain(createRow({ ri_attempts: null }))).toThrow(
            ResourceInboxRowCorruptionError
        );
    });

    it('rejects a row with an unknown status', () => {
        expect(() => toDomain(createRow({ ri_status: 'UNKNOWN' }))).toThrow(
            ResourceInboxRowCorruptionError
        );
    });

    it('writes timestamps at the millisecond precision returned by database adapters', () => {
        expect(
            toPgTimestamp(Temporal.PlainDateTime.from('2026-09-05T16:28:39.847520'))
        ).toBe('2026-09-05T16:28:39.847Z');
        expect(
            toPgTimestamp(Temporal.Instant.from('2026-09-05T14:28:39.847520Z'))
        ).toBe('2026-09-05T14:28:39.847Z');
    });
});

function createRow(overrides: Partial<ResourceInboxRow>): ResourceInboxRow {
    return {
        ri_row_id: 1n,
        ri_resource_id: 'resource-1',
        ri_topic_id: 'topic-1',
        ri_resource: '{}',
        ri_type_id: 'APP_INBOX',
        ri_status: EntityStatus.NEW,
        fk_ext_bank_id: 'context-1',
        system_date: '2026-08-23',
        created_by: 'server-1',
        created_ts: '2026-08-23 10:00:00.000000',
        expire_ts: '2026-08-23 11:00:00.000000',
        start_ts: null,
        end_ts: null,
        next_ts: null,
        ri_attempts: 0n,
        ...overrides
    };
}
