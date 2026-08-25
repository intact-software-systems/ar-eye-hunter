import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import type { RtcTopologyReplayCursorSnapshot } from '../consumer/rtc-topology-replay-contracts.ts';
import type { RtcTopologyDeliveryLogEntry } from '../delivery/rtc-topology-delivery-contracts.ts';
import {
    readRtcTopologyDeliverySafeInteger,
    RtcTopologyDeliveryCorruptionError,
    type RtcTopologyDeliveryBoundaryNumber
} from '../delivery/rtc-topology-delivery-validation.ts';

export interface CursorSnapshotRow {
    readonly consumer_stream_id: string;
    readonly publisher_stream_id: string;
    readonly head_sequence: RtcTopologyDeliveryBoundaryNumber;
    readonly retained_from_sequence: RtcTopologyDeliveryBoundaryNumber;
    readonly last_processed_sequence: RtcTopologyDeliveryBoundaryNumber;
    readonly cursor_updated_at_epoch_ms: RtcTopologyDeliveryBoundaryNumber;
    readonly publisher_lease_expires_at_epoch_ms: RtcTopologyDeliveryBoundaryNumber;
}

export interface PageBoundaryRow {
    readonly consumer_stream_id: string;
    readonly publisher_stream_id: string | null;
    readonly head_sequence: RtcTopologyDeliveryBoundaryNumber | null;
    readonly retained_from_sequence: RtcTopologyDeliveryBoundaryNumber | null;
    readonly last_processed_sequence: RtcTopologyDeliveryBoundaryNumber | null;
    readonly cursor_updated_at_epoch_ms: RtcTopologyDeliveryBoundaryNumber | null;
    readonly publisher_lease_expires_at_epoch_ms: RtcTopologyDeliveryBoundaryNumber | null;
    readonly consumer_lease_valid: boolean;
    readonly database_now_epoch_ms: RtcTopologyDeliveryBoundaryNumber;
}

export interface DeliveryLogRow {
    readonly publisher_stream_id: string;
    readonly sequence: RtcTopologyDeliveryBoundaryNumber;
    readonly application_id: string;
    readonly workspace_id: string;
    readonly group_id: string;
    readonly publication_id: string;
    readonly outbox_topic_id: string;
    readonly outbox_resource_id: string;
    readonly outbox_context_id: string;
    readonly retain_until_epoch_ms: RtcTopologyDeliveryBoundaryNumber;
    readonly inserted_at_epoch_ms: RtcTopologyDeliveryBoundaryNumber;
}

export function requireCursorSnapshotRow(row: PageBoundaryRow): CursorSnapshotRow {
    if (
        row.publisher_stream_id === null ||
        row.head_sequence === null ||
        row.retained_from_sequence === null ||
        row.last_processed_sequence === null ||
        row.cursor_updated_at_epoch_ms === null ||
        row.publisher_lease_expires_at_epoch_ms === null
    ) {
        throw new RtcTopologyDeliveryCorruptionError(
            'RTC topology replay page boundary is incomplete'
        );
    }
    return {
        consumer_stream_id: row.consumer_stream_id,
        publisher_stream_id: row.publisher_stream_id,
        head_sequence: row.head_sequence,
        retained_from_sequence: row.retained_from_sequence,
        last_processed_sequence: row.last_processed_sequence,
        cursor_updated_at_epoch_ms: row.cursor_updated_at_epoch_ms,
        publisher_lease_expires_at_epoch_ms: row.publisher_lease_expires_at_epoch_ms
    };
}

export async function readCursorSnapshots(
    sql: PSqlSql,
    consumerStreamId: string
): Promise<CursorSnapshotRow[]> {
    return await sql<CursorSnapshotRow[]>`
    select
      cursor.consumer_stream_id::text,
      cursor.publisher_stream_id::text,
      publisher.head_sequence::double precision as head_sequence,
      publisher.retained_from_sequence::double precision as retained_from_sequence,
      cursor.last_processed_sequence::double precision as last_processed_sequence,
      (extract(epoch from cursor.updated_at) * 1000)::double precision
        as cursor_updated_at_epoch_ms,
      (extract(epoch from publisher.lease_expires_at) * 1000)::double precision
        as publisher_lease_expires_at_epoch_ms
    from rtc_topology_replay_cursor as cursor
    join rtc_topology_delivery_stream as publisher
      on publisher.stream_id = cursor.publisher_stream_id
    where cursor.consumer_stream_id = ${consumerStreamId}
    order by cursor.publisher_stream_id
  `;
}

export function toCursorSnapshot(row: CursorSnapshotRow): RtcTopologyReplayCursorSnapshot {
    const snapshot = {
        consumerStreamId: row.consumer_stream_id,
        publisherStreamId: row.publisher_stream_id,
        headSequence: readRtcTopologyDeliverySafeInteger(
            row.head_sequence,
            'RTC topology replay publisher HEAD'
        ),
        retainedFromSequence: readRtcTopologyDeliverySafeInteger(
            row.retained_from_sequence,
            'RTC topology replay retained floor'
        ),
        lastProcessedSequence: readRtcTopologyDeliverySafeInteger(
            row.last_processed_sequence,
            'RTC topology replay cursor'
        ),
        cursorUpdatedAtEpochMs: readRtcTopologyDeliverySafeInteger(
            row.cursor_updated_at_epoch_ms,
            'RTC topology replay cursor update time'
        ),
        publisherLeaseExpiresAtEpochMs: readRtcTopologyDeliverySafeInteger(
            row.publisher_lease_expires_at_epoch_ms,
            'RTC topology replay publisher lease expiry'
        )
    };
    validateCursorSnapshot(snapshot);
    return snapshot;
}

export function validateCursorSnapshot(snapshot: RtcTopologyReplayCursorSnapshot): void {
    if (
        snapshot.retainedFromSequence < 1 ||
        snapshot.retainedFromSequence > snapshot.headSequence + 1
    ) {
        throw new RtcTopologyDeliveryCorruptionError(
            `RTC topology replay retained floor is invalid for ${snapshot.publisherStreamId}`
        );
    }
    if (snapshot.lastProcessedSequence > snapshot.headSequence) {
        throw new RtcTopologyDeliveryCorruptionError(
            `RTC topology replay cursor exceeds HEAD for ${snapshot.publisherStreamId}`
        );
    }
}

export function toLogEntry(row: DeliveryLogRow): RtcTopologyDeliveryLogEntry {
    return {
        publisherStreamId: row.publisher_stream_id,
        sequence: readRtcTopologyDeliverySafeInteger(
            row.sequence,
            'RTC topology delivery sequence'
        ),
        groupRef: {
            applicationId: row.application_id,
            workspaceId: row.workspace_id,
            groupId: row.group_id
        },
        publicationId: row.publication_id,
        outboxKey: {
            topicId: row.outbox_topic_id,
            resourceId: row.outbox_resource_id,
            contextId: row.outbox_context_id
        },
        retainUntilEpochMs: readRtcTopologyDeliverySafeInteger(
            row.retain_until_epoch_ms,
            'RTC topology delivery retention timestamp'
        ),
        insertedAtEpochMs: readRtcTopologyDeliverySafeInteger(
            row.inserted_at_epoch_ms,
            'RTC topology delivery insertion timestamp'
        )
    };
}
