import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE } from '../consumer/rtc-topology-replay-policy.ts';
import type {
    RtcTopologyDeliveryCompactionInput,
    RtcTopologyDeliveryCompactionResult
} from '../delivery/rtc-topology-delivery-contracts.ts';
import {
    readRtcTopologyDeliverySafeInteger,
    RtcTopologyDeliveryCorruptionError,
    type RtcTopologyDeliveryBoundaryNumber
} from '../delivery/rtc-topology-delivery-validation.ts';

interface CompactRtcTopologyDeliveryEntriesInput {
    readonly database: PSqlSql;
    readonly compaction: RtcTopologyDeliveryCompactionInput;
}

interface CompactionStreamRow {
    readonly head_sequence: RtcTopologyDeliveryBoundaryNumber;
    readonly retained_from_sequence: RtcTopologyDeliveryBoundaryNumber;
    readonly database_now_epoch_ms: RtcTopologyDeliveryBoundaryNumber;
}

interface CompactionEntryRow {
    readonly sequence: RtcTopologyDeliveryBoundaryNumber;
    readonly retain_until_epoch_ms: RtcTopologyDeliveryBoundaryNumber;
}

export async function compactRtcTopologyDeliveryEntries(
    input: CompactRtcTopologyDeliveryEntriesInput
): Promise<RtcTopologyDeliveryCompactionResult> {
    validateCompactionPageSize(input.compaction.pageSize);
    const streams = await input.database<Readonly<{ stream_id: string; }>[]>`
    select stream_id::text
    from rtc_topology_delivery_stream
    order by created_at, stream_id
  `;
    let deletedEntryCount = 0;
    for (const stream of streams) {
        deletedEntryCount += await input.database.begin(
            async (transaction) => await compactStreamEntries(transaction, stream.stream_id, input.compaction.pageSize)
        );
    }
    return {
        scannedStreamCount: streams.length,
        deletedEntryCount
    };
}

async function compactStreamEntries(
    sql: PSqlSql,
    streamId: string,
    pageSize: number
): Promise<number> {
    const streamRows = await sql<CompactionStreamRow[]>`
    select
      head_sequence::double precision as head_sequence,
      retained_from_sequence::double precision as retained_from_sequence,
      floor(extract(epoch from clock_timestamp()) * 1000)::double precision
        as database_now_epoch_ms
    from rtc_topology_delivery_stream
    where stream_id = ${streamId}
    for update
  `;
    const stream = streamRows[0];
    if (!stream) {
        return 0;
    }

    const headSequence = readRtcTopologyDeliverySafeInteger(
        stream.head_sequence,
        'RTC topology delivery HEAD'
    );
    const retainedFromSequence = readRtcTopologyDeliverySafeInteger(
        stream.retained_from_sequence,
        'RTC topology delivery retained floor'
    );
    const databaseNowEpochMs = readRtcTopologyDeliverySafeInteger(
        stream.database_now_epoch_ms,
        'RTC topology delivery database time'
    );
    if (retainedFromSequence === headSequence + 1) {
        return 0;
    }
    if (retainedFromSequence > headSequence + 1) {
        throw new RtcTopologyDeliveryCorruptionError(
            `RTC topology delivery retained floor exceeds HEAD for ${streamId}`
        );
    }

    const expectedCount = Math.min(pageSize, headSequence - retainedFromSequence + 1);
    const rows = await sql<CompactionEntryRow[]>`
    select
      sequence::double precision as sequence,
      floor(extract(epoch from retain_until) * 1000)::double precision
        as retain_until_epoch_ms
    from rtc_topology_delivery_log
    where publisher_stream_id = ${streamId}
      and sequence >= ${retainedFromSequence}
      and sequence <= ${headSequence}
    order by sequence
    limit ${pageSize}
  `;
    if (rows.length !== expectedCount) {
        throw new RtcTopologyDeliveryCorruptionError(
            `RTC topology delivery stream ${streamId} has an unexplained physical hole`
        );
    }

    let expiredCount = 0;
    for (const [index, row] of rows.entries()) {
        const sequence = readRtcTopologyDeliverySafeInteger(
            row.sequence,
            'RTC topology delivery sequence'
        );
        if (sequence !== retainedFromSequence + index) {
            throw new RtcTopologyDeliveryCorruptionError(
                `RTC topology delivery stream ${streamId} is not contiguous`
            );
        }
        const retainUntilEpochMs = readRtcTopologyDeliverySafeInteger(
            row.retain_until_epoch_ms,
            'RTC topology delivery retention timestamp'
        );
        if (retainUntilEpochMs > databaseNowEpochMs) {
            break;
        }
        expiredCount += 1;
    }
    if (expiredCount === 0) {
        return 0;
    }

    const lastDeletedSequence = retainedFromSequence + expiredCount - 1;
    const deleted = await sql<Readonly<{ sequence: RtcTopologyDeliveryBoundaryNumber; }>[]>`
    delete from rtc_topology_delivery_log
    where publisher_stream_id = ${streamId}
      and sequence >= ${retainedFromSequence}
      and sequence <= ${lastDeletedSequence}
    returning sequence::double precision as sequence
  `;
    if (deleted.length !== expiredCount) {
        throw new RtcTopologyDeliveryCorruptionError(
            `RTC topology delivery compaction changed unexpectedly for ${streamId}`
        );
    }
    const updated = await sql<Readonly<{ stream_id: string; }>[]>`
    update rtc_topology_delivery_stream
    set retained_from_sequence = ${lastDeletedSequence + 1},
        updated_at = clock_timestamp()
    where stream_id = ${streamId}
      and retained_from_sequence = ${retainedFromSequence}
    returning stream_id::text
  `;
    if (updated.length !== 1) {
        throw new RtcTopologyDeliveryCorruptionError(
            `RTC topology delivery retained floor changed unexpectedly for ${streamId}`
        );
    }
    return expiredCount;
}

function validateCompactionPageSize(pageSize: number): void {
    if (
        !Number.isSafeInteger(pageSize) ||
        pageSize <= 0 ||
        pageSize > RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE
    ) {
        throw new TypeError(
            'RTC topology delivery compaction page size must be from 1 to ' +
                RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE
        );
    }
}
