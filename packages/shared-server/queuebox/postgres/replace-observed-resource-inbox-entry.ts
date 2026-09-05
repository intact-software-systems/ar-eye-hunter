import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import {
    toPgTimestamp,
    toSystemDate,
    type ResourceInboxRow
} from './resource-inbox-row-codec.ts';

export interface ReplaceObservedResourceInboxEntryInput {
    readonly sql: PSqlSql;
    readonly expected: ResourceEntry;
    readonly replacement: ResourceEntry;
    readonly expectedRowId: bigint;
}

export async function replaceObservedResourceInboxEntry(
    input: ReplaceObservedResourceInboxEntryInput
): Promise<ResourceInboxRow[]> {
    const { sql, expected, replacement, expectedRowId } = input;
    return await sql<ResourceInboxRow[]>`
        update resource_inbox
        set ri_resource = ${replacement.resource},
            ri_type_id = ${replacement.typeId},
            ri_status = ${replacement.status},
            system_date = ${toSystemDate(replacement)},
            created_by = ${replacement.audit.createdBy},
            created_ts = ${toPgTimestamp(replacement.audit.createdTs)},
            expire_ts = ${toPgTimestamp(replacement.audit.expiryTs)},
            start_ts = ${
        replacement.dequeueAudit.startTs
            ? toPgTimestamp(replacement.dequeueAudit.startTs)
            : null
    },
            end_ts = ${
        replacement.dequeueAudit.endTs
            ? toPgTimestamp(replacement.dequeueAudit.endTs)
            : null
    },
            next_ts = ${
        replacement.dequeueAudit.nextTs
            ? toPgTimestamp(replacement.dequeueAudit.nextTs)
            : null
    },
            ri_attempts = ${replacement.dequeueAudit.attempts}
        where ri_row_id = ${expectedRowId}
          and ri_topic_id = ${expected.key.topicId}
          and ri_resource_id = ${expected.key.resourceId}
          and fk_ext_bank_id = ${expected.key.contextId}
          and ri_type_id = ${expected.typeId}
          and ri_resource = ${expected.resource}
          and ri_status = ${expected.status}
          and system_date = ${toSystemDate(expected)}
          and created_by = ${expected.audit.createdBy}
          and created_ts = ${toPgTimestamp(expected.audit.createdTs)}
          and expire_ts = ${toPgTimestamp(expected.audit.expiryTs)}
          and start_ts is not distinct from ${
        expected.dequeueAudit.startTs
            ? toPgTimestamp(expected.dequeueAudit.startTs)
            : null
    }
          and end_ts is not distinct from ${
        expected.dequeueAudit.endTs
            ? toPgTimestamp(expected.dequeueAudit.endTs)
            : null
    }
          and next_ts is not distinct from ${
        expected.dequeueAudit.nextTs
            ? toPgTimestamp(expected.dequeueAudit.nextTs)
            : null
    }
          and ri_attempts = ${expected.dequeueAudit.attempts}
          and expire_ts > (now() at time zone 'UTC')
        returning *
    `;
}
