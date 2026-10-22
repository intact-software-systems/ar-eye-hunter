import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { PSqlFragment } from '../../postgres/p-sql-fragment.ts';
import {
    toPgTimestamp,
    toSystemDate
} from './resource-inbox-row-codec.ts';

export interface ResourceInboxEntryInsertValues {
    readonly entry: ResourceEntry;
    readonly systemDate: string;
    readonly createdTimestamp: string;
    readonly expiryTimestamp: string;
    readonly startTimestamp: string | null;
    readonly endTimestamp: string | null;
    readonly nextTimestamp: string | null;
    readonly attempts: number;
}

/** One row of a multi-row write, named as the statement's recordset columns. */
export interface ResourceInboxEntryInsertRow {
    readonly resourceId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly resource: string;
    readonly typeId: string;
    readonly status: string;
    readonly systemDate: string;
    readonly createdBy: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly nextAt: string | null;
    readonly attempts: number;
}

/** The recordset columns of a row's stored content, everything but its key. */
export const RESOURCE_INBOX_ENTRY_CONTENT_RECORDSET_COLUMNS = PSqlFragment.of`resource text, "typeId" text,
                        status text, "systemDate" text, "createdBy" text, "createdAt" text, "expiresAt" text,
                        "startedAt" text, "finishedAt" text, "nextAt" text, attempts bigint`;

export function computeResourceInboxEntryInsertValues(entry: ResourceEntry): ResourceInboxEntryInsertValues {
    const snapshot = { ...entry };
    return {
        entry: snapshot,
        systemDate: toSystemDate(snapshot),
        createdTimestamp: toPgTimestamp(snapshot.audit.createdTs),
        expiryTimestamp: toPgTimestamp(snapshot.audit.expiryTs),
        startTimestamp: snapshot.dequeueAudit.startTs ? toPgTimestamp(snapshot.dequeueAudit.startTs) : null,
        endTimestamp: snapshot.dequeueAudit.endTs ? toPgTimestamp(snapshot.dequeueAudit.endTs) : null,
        nextTimestamp: snapshot.dequeueAudit.nextTs ? toPgTimestamp(snapshot.dequeueAudit.nextTs) : null,
        attempts: snapshot.dequeueAudit.attempts
    };
}

export function toResourceInboxEntryInsertRow(values: ResourceInboxEntryInsertValues): ResourceInboxEntryInsertRow {
    const { entry } = values;
    return {
        resourceId: entry.key.resourceId,
        topicId: entry.key.topicId,
        contextId: entry.key.contextId,
        resource: entry.resource,
        typeId: entry.typeId,
        status: entry.status,
        systemDate: values.systemDate,
        createdBy: entry.audit.createdBy,
        createdAt: values.createdTimestamp,
        expiresAt: values.expiryTimestamp,
        startedAt: values.startTimestamp,
        finishedAt: values.endTimestamp,
        nextAt: values.nextTimestamp,
        attempts: values.attempts
    };
}

/** Every row inserted in one statement and in the given order; the caller appends its conflict rule and answer. */
export function toResourceInboxEntryInsert(rows: readonly ResourceInboxEntryInsertRow[]): PSqlFragment {
    return PSqlFragment.of`
        insert into resource_inbox (
            ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
            fk_ext_bank_id, system_date, created_by, created_ts, expire_ts,
            start_ts, end_ts, next_ts, ri_attempts
        )
        select inserted."resourceId", inserted."topicId", inserted.resource, inserted."typeId", inserted.status,
               inserted."contextId", inserted."systemDate"::date, inserted."createdBy",
               inserted."createdAt"::timestamp(6), inserted."expiresAt"::timestamp(6),
               inserted."startedAt"::timestamp(6), inserted."finishedAt"::timestamp(6),
               inserted."nextAt"::timestamp(6), inserted.attempts
        from jsonb_to_recordset(${rows}::jsonb)
            as inserted("resourceId" text, "topicId" text, "contextId" text,
                        ${RESOURCE_INBOX_ENTRY_CONTENT_RECORDSET_COLUMNS})`;
}
