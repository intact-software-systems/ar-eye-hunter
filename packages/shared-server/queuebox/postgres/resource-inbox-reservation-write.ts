import type { EntityStatus, Key } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';

export interface ResourceInboxReservationFinish {
    readonly key: Key;
    readonly expectedAttempts: number;
    readonly status: typeof EntityStatus.COMPLETED | typeof EntityStatus.FAILED;
    readonly completedAt: Date;
}

export async function writeResourceInboxReservationFinish(
    transaction: PSqlSql,
    computed: ResourceInboxReservationFinish
): Promise<boolean> {
    const rows = await transaction<readonly { ri_row_id: bigint; }[]>`
        update resource_inbox
        set ri_status = ${computed.status}, end_ts = ${computed.completedAt}, next_ts = null
        where ri_topic_id = ${computed.key.topicId}
          and ri_resource_id = ${computed.key.resourceId}
          and fk_ext_bank_id = ${computed.key.contextId}
          and ri_status = 'RESERVED'
          and ri_attempts = ${computed.expectedAttempts}
          and expire_ts > (now() at time zone 'UTC')
        returning ri_row_id
    `;

    return rows.length === 1;
}

