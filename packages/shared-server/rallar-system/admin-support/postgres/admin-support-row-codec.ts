import type { AdminSupportQueueEntryRead } from '../admin-support-contracts.ts';

export interface AdminSupportInboxRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly ri_resource: string;
    readonly ri_type_id: string;
    readonly ri_status: string;
    readonly fk_ext_bank_id: string;
    readonly created_ts: Date | string | null;
    readonly start_ts: Date | string | null;
    readonly end_ts: Date | string | null;
    readonly next_ts: Date | string | null;
    readonly expire_ts: Date | string | null;
    readonly ri_attempts: number | string | null;
}

export interface AdminSupportResultRow {
    readonly ris_resource_id: string;
    readonly ris_topic_id: string;
    readonly ris_resource: string;
    readonly ris_type_id: string;
    readonly ris_status: string;
    readonly fk_ext_bank_id: string;
    readonly created_ts: Date | string | null;
    readonly expire_ts: Date | string | null;
}

export function toAdminSupportInboxRead(
    row: AdminSupportInboxRow
): AdminSupportQueueEntryRead {
    return {
        source: 'resource_inbox',
        key: {
            topicId: row.ri_topic_id,
            resourceId: row.ri_resource_id,
            contextId: row.fk_ext_bank_id
        },
        typeId: row.ri_type_id,
        status: row.ri_status,
        attempts: toNumber(row.ri_attempts),
        createdAtEpochMs: toEpochMs(row.created_ts),
        startedAtEpochMs: toEpochMs(row.start_ts),
        endedAtEpochMs: toEpochMs(row.end_ts),
        nextRetryAtEpochMs: toEpochMs(row.next_ts),
        expiresAtEpochMs: toEpochMs(row.expire_ts),
        payload: row.ri_resource
    };
}

export function toAdminSupportResultRead(
    row: AdminSupportResultRow
): AdminSupportQueueEntryRead {
    return {
        source: 'resource_inbox_results',
        key: {
            topicId: row.ris_topic_id,
            resourceId: row.ris_resource_id,
            contextId: row.fk_ext_bank_id
        },
        typeId: row.ris_type_id,
        status: row.ris_status,
        attempts: 0,
        createdAtEpochMs: toEpochMs(row.created_ts),
        expiresAtEpochMs: toEpochMs(row.expire_ts),
        payload: row.ris_resource
    };
}

function toEpochMs(value: Date | string | null): number | undefined {
    if (value === null) {
        return undefined;
    }
    const epochMs = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(epochMs) ? epochMs : undefined;
}

function toNumber(value: number | string | null): number {
    if (value === null) {
        return 0;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}
