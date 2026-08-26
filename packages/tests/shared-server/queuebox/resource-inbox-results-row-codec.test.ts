import { describe, expect, it } from 'vitest';

import { toResultsDomain } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

describe('resource inbox results row codec', () => {
    it('maps ris columns into a queue entry', () => {
        const entry = toResultsDomain({
            ris_row_id: 123n,
            ris_resource_id: 'request-1',
            ris_topic_id: 'app-inbox.group-state',
            ris_resource: JSON.stringify({ ok: true }),
            ris_type_id: 'APP_INBOX',
            ris_status: EntityStatus.COMPLETED,
            fk_ext_bank_id: 'group-create',
            system_date: '2026-05-20',
            created_by: 'server-1',
            created_ts: '2026-05-20T10:00:00.000',
            expire_ts: '2026-05-20T10:05:00.000'
        });

        expect(entry.key).toEqual({
            topicId: 'app-inbox.group-state',
            resourceId: 'request-1',
            contextId: 'group-create'
        });
        expect(entry.resource).toBe(JSON.stringify({ ok: true }));
        expect(entry.status).toBe(EntityStatus.COMPLETED);
        expect(entry.dequeueAudit.attempts).toBe(0);
        expect(entry.db?.id).toBe('123');
    });
});
