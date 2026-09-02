import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import {
    isValidResourceInboxLifecycle,
    toPgTimestamp,
    toSystemDate,
    type ResourceInboxRow
} from '../../queuebox/postgres/resource-inbox-row-codec.ts';

export interface AppOutboxInsert {
    readonly entry: Readonly<ResourceEntry>;
    readonly systemDate: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly nextAt: string | null;
    readonly attempts: number;
    readonly conflict: ResourceInboxInvariantCorruptionError;
}

export interface AppOutboxInsertOrMatch extends AppOutboxInsert {
    readonly matchCreatedAt: string;
    readonly matchExpiresAt: string;
    readonly mismatch: ResourceInboxInvariantCorruptionError;
}

interface AppOutboxCollisionRow extends ResourceInboxRow {
    readonly immutable_matches: boolean;
}

export function computeAppOutboxInsert(entry: ResourceEntry): AppOutboxInsert {
    const snapshot: Readonly<ResourceEntry> = {
        ...entry,
        key: { ...entry.key },
        audit: { ...entry.audit },
        dequeueAudit: { ...entry.dequeueAudit },
        ...(entry.db === undefined ? {} : { db: { ...entry.db } })
    };
    return {
        entry: snapshot,
        systemDate: toSystemDate(snapshot),
        createdAt: toPgTimestamp(snapshot.audit.createdTs),
        expiresAt: toPgTimestamp(snapshot.audit.expiryTs),
        startedAt: snapshot.dequeueAudit.startTs ? toPgTimestamp(snapshot.dequeueAudit.startTs) : null,
        finishedAt: snapshot.dequeueAudit.endTs ? toPgTimestamp(snapshot.dequeueAudit.endTs) : null,
        nextAt: snapshot.dequeueAudit.nextTs ? toPgTimestamp(snapshot.dequeueAudit.nextTs) : null,
        attempts: snapshot.dequeueAudit.attempts,
        conflict: new ResourceInboxInvariantCorruptionError(
            snapshot.key,
            'App outbox insert did not create exactly one row'
        )
    };
}

export async function writeAppOutboxInsert(transaction: PSqlSql, computed: AppOutboxInsert): Promise<void> {
    if (!await insertAppOutboxRow(transaction, computed)) {
        throw computed.conflict;
    }
}

export function computeAppOutboxInsertOrMatch(entry: ResourceEntry): AppOutboxInsertOrMatch {
    const computed = computeAppOutboxInsert(entry);
    return {
        ...computed,
        matchCreatedAt: toPgTimestamp(computed.entry.audit.createdTs.round({
            smallestUnit: 'microsecond',
            roundingMode: 'halfEven'
        })),
        matchExpiresAt: toPgTimestamp(computed.entry.audit.expiryTs.round({
            smallestUnit: 'microsecond',
            roundingMode: 'halfEven'
        })),
        mismatch: new ResourceInboxInvariantCorruptionError(
            computed.entry.key,
            'Resource inbox immutable content or lifecycle differs'
        )
    };
}

export async function writeAppOutboxInsertOrMatch(
    transaction: PSqlSql,
    computed: AppOutboxInsertOrMatch
): Promise<'inserted' | 'matched'> {
    if (await insertAppOutboxRow(transaction, computed)) {
        return 'inserted';
    }
    // Bind timestamp strings as text so postgres.js does not truncate them through Date.
    const rows = await transaction<readonly AppOutboxCollisionRow[]>`
        select ri_row_id, ri_resource_id, ri_topic_id, ri_resource, ri_type_id,
               ri_status, fk_ext_bank_id, system_date, created_by, ri_attempts,
               case when extract(year from created_ts) > 9999
                    then '+' || lpad(extract(year from created_ts)::text, 6, '0') || to_char(created_ts, '-MM-DD"T"HH24:MI:SS.US')
                    else to_char(created_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US') end as created_ts,
               case when extract(year from expire_ts) > 9999
                    then '+' || lpad(extract(year from expire_ts)::text, 6, '0') || to_char(expire_ts, '-MM-DD"T"HH24:MI:SS.US')
                    else to_char(expire_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US') end as expire_ts,
               case when extract(year from start_ts) > 9999
                    then '+' || lpad(extract(year from start_ts)::text, 6, '0') || to_char(start_ts, '-MM-DD"T"HH24:MI:SS.US')
                    else to_char(start_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US') end as start_ts,
               case when extract(year from end_ts) > 9999
                    then '+' || lpad(extract(year from end_ts)::text, 6, '0') || to_char(end_ts, '-MM-DD"T"HH24:MI:SS.US')
                    else to_char(end_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US') end as end_ts,
               case when extract(year from next_ts) > 9999
                    then '+' || lpad(extract(year from next_ts)::text, 6, '0') || to_char(next_ts, '-MM-DD"T"HH24:MI:SS.US')
                    else to_char(next_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US') end as next_ts,
               ri_type_id = ${computed.entry.typeId}
                   and ri_resource = ${computed.entry.resource}
                   and created_by = ${computed.entry.audit.createdBy}
                   and created_ts = ${computed.matchCreatedAt}::text::timestamp(6)
                   and expire_ts = ${computed.matchExpiresAt}::text::timestamp(6) as immutable_matches
        from resource_inbox
        where ri_topic_id = ${computed.entry.key.topicId}
          and ri_resource_id = ${computed.entry.key.resourceId}
          and fk_ext_bank_id = ${computed.entry.key.contextId}
        limit 1
    `;
    const existing = rows[0];
    if (rows.length !== 1 || !existing || !existing.immutable_matches || !isValidResourceInboxLifecycle(existing)) {
        throw computed.mismatch;
    }
    return 'matched';
}

async function insertAppOutboxRow(transaction: PSqlSql, computed: AppOutboxInsert): Promise<boolean> {
    const entry = computed.entry;
    const inserted = await transaction<readonly { ri_row_id: bigint; }[]>`
        insert into resource_inbox (ri_resource_id,
                                    ri_topic_id,
                                    ri_resource,
                                    ri_type_id,
                                    ri_status,
                                    fk_ext_bank_id,
                                    system_date,
                                    created_by,
                                    created_ts,
                                    expire_ts,
                                    start_ts,
                                    end_ts,
                                    next_ts,
                                    ri_attempts)
        values (${entry.key.resourceId},
                ${entry.key.topicId},
                ${entry.resource},
                ${entry.typeId},
                ${entry.status},
                ${entry.key.contextId},
                ${computed.systemDate},
                ${entry.audit.createdBy},
                ${computed.createdAt},
                ${computed.expiresAt},
                ${computed.startedAt},
                ${computed.finishedAt},
                ${computed.nextAt},
                ${computed.attempts})
        on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id) do nothing
        returning ri_row_id
    `;
    if (inserted.length > 1) {
        throw computed.conflict;
    }
    return inserted.length === 1;
}

