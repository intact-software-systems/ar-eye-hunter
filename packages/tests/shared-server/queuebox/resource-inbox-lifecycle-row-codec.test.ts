import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    isValidResourceInboxLifecycle,
    ResourceInboxRowCorruptionError,
    toDomain,
    type ResourceInboxRow
} from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

const NEW_ROW: ResourceInboxRow = {
    ri_row_id: 123n,
    ri_resource_id: 'request-1',
    ri_topic_id: 'app-inbox.group-state',
    ri_resource: JSON.stringify({ ok: true }),
    ri_type_id: 'APP_INBOX',
    ri_status: EntityStatus.NEW,
    fk_ext_bank_id: 'group-create',
    system_date: '2026-05-20',
    created_by: 'server-1',
    created_ts: '2026-05-20 10:00:00.000000',
    expire_ts: '2026-05-20 10:05:00.000000',
    start_ts: null,
    end_ts: null,
    next_ts: null,
    ri_attempts: 0n
};

describe('resource inbox lifecycle row codec', () => {
    it('accepts a completed readiness reservation without a processing attempt and rejects incomplete timestamps', () => {
        const waiting = {
            ...NEW_ROW,
            ri_status: EntityStatus.RETRY,
            start_ts: '2026-05-20 10:00:01.000000',
            end_ts: '2026-05-20 10:00:02.000000',
            next_ts: '2026-05-20 10:00:03.000000'
        };
        expect(isValidResourceInboxLifecycle(waiting)).toBe(true);
        expect(isValidResourceInboxLifecycle({ ...waiting, start_ts: null })).toBe(false);
        expect(isValidResourceInboxLifecycle({ ...waiting, end_ts: null })).toBe(false);
        expect(isValidResourceInboxLifecycle({ ...waiting, next_ts: null })).toBe(false);
        expect(isValidResourceInboxLifecycle({ ...waiting, ri_attempts: -1n })).toBe(false);
    });
    it.each([
        ['microsecond creation and millisecond SQL reservation', {
            ri_status: EntityStatus.RESERVED,
            ri_attempts: 1n,
            created_ts: '2026-10-13 21:54:00.375440',
            expire_ts: '9999-12-31 23:59:59.999000',
            start_ts: '2026-10-13 21:54:00.375000',
            end_ts: null
        }],
        ['independent completion clock before SQL reservation', {
            ri_status: EntityStatus.COMPLETED,
            ri_attempts: 1n,
            start_ts: '2026-05-20 10:00:01.000001',
            end_ts: '2026-05-20 10:00:01.000000'
        }]
    ])('preserves %s through full read and immutable replay validation', (_scenario, clocks) => {
        const row = { ...NEW_ROW, ...clocks };
        const before = { ...row };
        expect(isValidResourceInboxLifecycle(row)).toBe(true);
        const entry = toDomain(row);
        expect(entry.audit.createdTs.equals(Temporal.PlainDateTime.from(row.created_ts.replace(' ', 'T')))).toBe(true);
        expect(entry.dequeueAudit.startTs!.equals(Temporal.Instant.from(`${row.start_ts!.replace(' ', 'T')}Z`))).toBe(true);
        expect(entry.dequeueAudit.endTs?.equals(Temporal.Instant.from(`${row.end_ts?.replace(' ', 'T')}Z`))).toBe(row.end_ts === null ? undefined : true);
        expect(row).toEqual(before);
    });

    it('accepts a current new row with no dequeue timestamps', () => {
        expect(isValidResourceInboxLifecycle(NEW_ROW)).toBe(true);
    });

    it('rejects a new row that already records a processing attempt', () => {
        expect(isValidResourceInboxLifecycle({ ...NEW_ROW, ri_attempts: 1n })).toBe(false);
    });

    it.each(
        [
            ['reservation start', { ri_status: EntityStatus.RESERVED, ri_attempts: 1n, start_ts: '' }],
            ['completion end', { ri_status: EntityStatus.COMPLETED, ri_attempts: 1n, start_ts: '2026-05-20 10:00:01.000000', end_ts: '' }],
            ['retry schedule', {
                ri_status: EntityStatus.RETRY,
                ri_attempts: 1n,
                start_ts: '2026-05-20 10:00:01.000000',
                end_ts: '2026-05-20 10:00:02.000000',
                next_ts: ''
            }]
        ] as const
    )('rejects an empty %s instead of treating it as a stored timestamp', (_field, corruption) => {
        const row = { ...NEW_ROW, ...corruption };
        expect(isValidResourceInboxLifecycle(row)).toBe(false);
        expect(() => toDomain(row)).toThrow(ResourceInboxRowCorruptionError);
    });
});
