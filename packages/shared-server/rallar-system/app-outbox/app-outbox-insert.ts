import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { toPgTimestamp, toSystemDate } from '../../queuebox/postgres/resource-inbox-row-codec.ts';

export interface AppOutboxInsert {
    readonly entry: Readonly<ResourceEntry>;
    readonly systemDate: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly nextAt: string | null;
    readonly attempts: number;
}

/** One row of the multi-row outbox insert, named as the statement's recordset columns. */
export interface AppOutboxInsertRow {
    readonly resourceId: string;
    readonly topicId: string;
    readonly resource: string;
    readonly typeId: string;
    readonly status: string;
    readonly contextId: string;
    readonly systemDate: string;
    readonly createdBy: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly nextAt: string | null;
    readonly attempts: number;
}

interface AppOutboxInsertedRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly fk_ext_bank_id: string;
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
        attempts: snapshot.dequeueAudit.attempts
    };
}

export function isExactAppOutboxInsert(
    entry: ResourceEntry,
    computed: AppOutboxInsert
): boolean {
    const expected = computeAppOutboxInsert(entry);
    return computed.entry.key.topicId === expected.entry.key.topicId &&
        computed.entry.key.resourceId === expected.entry.key.resourceId &&
        computed.entry.key.contextId === expected.entry.key.contextId &&
        computed.entry.resource === expected.entry.resource &&
        computed.entry.typeId === expected.entry.typeId &&
        computed.entry.status === expected.entry.status &&
        computed.entry.audit.createdBy === expected.entry.audit.createdBy &&
        computed.systemDate === expected.systemDate &&
        computed.createdAt === expected.createdAt &&
        computed.expiresAt === expected.expiresAt &&
        computed.startedAt === expected.startedAt &&
        computed.finishedAt === expected.finishedAt &&
        computed.nextAt === expected.nextAt &&
        computed.attempts === expected.attempts;
}

export async function writeAppOutboxInsert(transaction: PSqlSql, computed: AppOutboxInsert): Promise<void> {
    await writeAppOutboxInserts(transaction, [computed]);
}

/**
 * Every row in one statement and in the given order; each must return its row id, since a row whose key already
 * exists is the corruption the insert reports.
 */
export async function writeAppOutboxInserts(
    transaction: PSqlSql,
    computed: readonly AppOutboxInsert[]
): Promise<void> {
    if (computed.length === 0) {
        return;
    }
    const inserted = await insertAbsentAppOutboxRows(transaction, computed);
    if (inserted.length !== computed.length) {
        const missing = computed.find(({ entry: { key } }) =>
            !inserted.some((row) =>
                row.ri_resource_id === key.resourceId && row.ri_topic_id === key.topicId &&
                row.fk_ext_bank_id === key.contextId
            )
        );
        throw new ResourceInboxInvariantCorruptionError(
            (missing ?? computed[0]).entry.key,
            'App outbox insert did not create exactly one row'
        );
    }
}

/** Whether the row was created; a row already stored under its key is left as it is. */
export async function writeAppOutboxInsertIfAbsent(transaction: PSqlSql, computed: AppOutboxInsert): Promise<boolean> {
    return (await insertAbsentAppOutboxRows(transaction, [computed])).length === 1;
}

async function insertAbsentAppOutboxRows(
    transaction: PSqlSql,
    computed: readonly AppOutboxInsert[]
): Promise<readonly AppOutboxInsertedRow[]> {
    return await transaction<readonly AppOutboxInsertedRow[]>`
        insert into resource_inbox (ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status, fk_ext_bank_id,
                                    system_date, created_by, created_ts, expire_ts, start_ts, end_ts, next_ts,
                                    ri_attempts)
        select row."resourceId", row."topicId", row.resource, row."typeId", row.status, row."contextId",
               row."systemDate"::date, row."createdBy", row."createdAt"::timestamp(6), row."expiresAt"::timestamp(6),
               row."startedAt"::timestamp(6), row."finishedAt"::timestamp(6), row."nextAt"::timestamp(6), row.attempts
        from jsonb_to_recordset(${computed.map(toAppOutboxInsertRow)}::jsonb)
            as row("resourceId" text, "topicId" text, resource text, "typeId" text, status text, "contextId" text,
                   "systemDate" text, "createdBy" text, "createdAt" text, "expiresAt" text, "startedAt" text,
                   "finishedAt" text, "nextAt" text, attempts bigint)
        on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id) do nothing
        returning ri_row_id, ri_resource_id, ri_topic_id, fk_ext_bank_id
    `;
}

function toAppOutboxInsertRow(computed: AppOutboxInsert): AppOutboxInsertRow {
    const { entry } = computed;
    return {
        resourceId: entry.key.resourceId,
        topicId: entry.key.topicId,
        resource: entry.resource,
        typeId: entry.typeId,
        status: entry.status,
        contextId: entry.key.contextId,
        systemDate: computed.systemDate,
        createdBy: entry.audit.createdBy,
        createdAt: computed.createdAt,
        expiresAt: computed.expiresAt,
        startedAt: computed.startedAt,
        finishedAt: computed.finishedAt,
        nextAt: computed.nextAt,
        attempts: computed.attempts
    };
}
