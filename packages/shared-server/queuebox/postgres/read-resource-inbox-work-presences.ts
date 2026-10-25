import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { PSqlFragment } from '../../postgres/p-sql-fragment.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';

/** One lane owner's probe: its types and the durations its work advertisement options validated. */
export interface ResourceInboxWorkPresenceRead {
    readonly allowedTopicIds?: ReadonlySet<string>;
    readonly typeIds: ReadonlySet<string>;
    readonly maxAttempts: number;
    readonly reservationLeaseMs: number;
    readonly finalizationStaleAfterMs: number;
    readonly staleDueThresholdMs: number;
}

/** Whether each lane's selector would find a row now. */
export interface ResourceInboxWorkPresence {
    readonly newRow: boolean;
    readonly dueRetry: boolean;
    readonly overdueRetry: boolean;
    readonly timedOutReservation: boolean;
    readonly staleExhaustedReservation: boolean;
}

interface WorkPresenceRow {
    readonly read_ordinal: number;
    readonly has_new: boolean;
    readonly has_due_retry: boolean;
    readonly has_overdue_retry: boolean;
    readonly has_timed_out_reservation: boolean;
    readonly has_stale_exhausted_reservation: boolean;
}

const NO_WORK_PRESENCE: ResourceInboxWorkPresence = {
    newRow: false,
    dueRetry: false,
    overdueRetry: false,
    timedOutReservation: false,
    staleExhaustedReservation: false
};

/**
 * However many reads, one statement answers them all, each on its own types and durations, in the
 * order given. Exhaustion recovery is an AppInbox lane; other types never advertise it.
 */
export async function readResourceInboxWorkPresences(
    sql: PSqlSql,
    reads: readonly ResourceInboxWorkPresenceRead[]
): Promise<readonly ResourceInboxWorkPresence[]> {
    const probed = reads.flatMap((read, ordinal) => read.typeIds.size === 0 ? [] : [{ read, ordinal }]);
    if (probed.length === 0) {
        return reads.map(() => NO_WORK_PRESENCE);
    }
    const statement = probed
        .map(({ read, ordinal }) => toWorkPresenceSelect(read, ordinal))
        .reduce((joined, select) =>
            PSqlFragment.of`${joined}
            union all ${select}`
        );
    const rows = await sql<WorkPresenceRow[]>(...statement.toStatement());
    const presenceByOrdinal = new Map(rows.map((row) => [Number(row.read_ordinal), toWorkPresence(row)]));
    return reads.map((read, ordinal) => {
        const presence = read.typeIds.size === 0 ? NO_WORK_PRESENCE : presenceByOrdinal.get(ordinal);
        if (presence === undefined) {
            throw new Error('Resource inbox work presence statement returned no row for a read');
        }
        return presence;
    });
}

function toWorkPresenceSelect(read: ResourceInboxWorkPresenceRead, ordinal: number): PSqlFragment {
    const { typeIds, maxAttempts, reservationLeaseMs, finalizationStaleAfterMs, staleDueThresholdMs } = read;
    const typeIdPredicate = PSqlFragment.toTextListPredicate(PSqlFragment.identifier('ri_type_id'), [...typeIds]);
    const topicPredicate = read.allowedTopicIds === undefined
        ? PSqlFragment.of`true`
        : PSqlFragment.toTextListPredicate(PSqlFragment.identifier('ri_topic_id'), [...read.allowedTopicIds]);
    const finalizationTypeId = typeIds.has(EnqueuedType.APP_INBOX) ? EnqueuedType.APP_INBOX : null;
    return PSqlFragment.of`
            select
                ${ordinal}::int as read_ordinal,
                exists(select 1 from resource_inbox
                    where ${typeIdPredicate}
                      and ${topicPredicate}
                      and ri_status = ${EntityStatus.NEW}
                      and expire_ts > (now() at time zone 'UTC')
                      and ri_attempts < ${maxAttempts}
                      and start_ts is null
                      and (next_ts is null or next_ts <= (now() at time zone 'UTC'))) as has_new,
                exists(select 1 from resource_inbox
                    where ${typeIdPredicate}
                      and ${topicPredicate}
                      and ri_status = ${EntityStatus.RETRY}
                      and expire_ts > (now() at time zone 'UTC')
                      and ri_attempts < ${maxAttempts}
                      and next_ts <= (now() at time zone 'UTC')) as has_due_retry,
                exists(select 1 from resource_inbox
                    where ${typeIdPredicate}
                      and ${topicPredicate}
                      and ri_status = ${EntityStatus.RETRY}
                      and expire_ts > (now() at time zone 'UTC')
                      and ri_attempts < ${maxAttempts}
                      and next_ts <= (now() - (${staleDueThresholdMs} * interval '1 millisecond')) at time zone 'UTC'
                ) as has_overdue_retry,
                exists(select 1 from resource_inbox
                    where ${typeIdPredicate}
                      and ${topicPredicate}
                      and ri_status = ${EntityStatus.RESERVED}
                      and expire_ts > (now() at time zone 'UTC')
                      and ri_attempts < ${maxAttempts}
                      and start_ts is not null
                      and start_ts < (now() - (${reservationLeaseMs} * interval '1 millisecond')) at time zone 'UTC'
                ) as has_timed_out_reservation,
                exists(select 1 from resource_inbox
                    where ri_type_id = ${finalizationTypeId}
                      and ${topicPredicate}
                      and ri_status = ${EntityStatus.RESERVED}
                      and expire_ts > (now() at time zone 'UTC')
                      and ri_attempts >= ${maxAttempts}
                      and ri_attempts < ${Number.MAX_SAFE_INTEGER}
                      and start_ts is not null
                      and start_ts <= (now() - (${finalizationStaleAfterMs} * interval '1 millisecond')) at time zone 'UTC'
                ) as has_stale_exhausted_reservation`;
}

function toWorkPresence(row: WorkPresenceRow): ResourceInboxWorkPresence {
    return {
        newRow: row.has_new,
        dueRetry: row.has_due_retry,
        overdueRetry: row.has_overdue_retry,
        timedOutReservation: row.has_timed_out_reservation,
        staleExhaustedReservation: row.has_stale_exhausted_reservation
    };
}
