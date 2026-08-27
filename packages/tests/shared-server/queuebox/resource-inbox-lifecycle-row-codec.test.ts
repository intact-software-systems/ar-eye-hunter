import { describe, expect, it } from 'vitest';

import { isValidResourceInboxLifecycle, type ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
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
    it('accepts a current new row with no dequeue timestamps', () => {
        expect(isValidResourceInboxLifecycle(NEW_ROW)).toBe(true);
    });

    it('rejects a new row that already records a processing attempt', () => {
        expect(isValidResourceInboxLifecycle({ ...NEW_ROW, ri_attempts: 1n })).toBe(false);
    });
});
