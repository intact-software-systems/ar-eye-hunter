import type { AdminSupportQueueEntryRead } from '../../rallar-system/admin-support/admin-support-contracts.ts';

export type AdminSupportInboxRow = Readonly<{
    ri_resource_id: string;
    ri_topic_id: string;
    ri_resource: string;
    ri_type_id: string;
    ri_status: string;
    fk_ext_bank_id: string;
    created_ts: Date | string | null;
    start_ts: Date | string | null;
    end_ts: Date | string | null;
    next_ts: Date | string | null;
    expire_ts: Date | string | null;
    ri_attempts: number | string | null;
}>;

export type AdminSupportResultRow = Readonly<{
    ris_resource_id: string;
    ris_topic_id: string;
    ris_resource: string;
    ris_type_id: string;
    ris_status: string;
    fk_ext_bank_id: string;
    created_ts: Date | string | null;
    expire_ts: Date | string | null;
}>;

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
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
}

function toNumber(value: number | string | null): number {
    if (value === null) {
        return 0;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
