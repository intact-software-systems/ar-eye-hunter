import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import type {
    RtcTopologyReplayCursorRetirementInput,
    RtcTopologyReplayCursorRetirementResult,
    RtcTopologyReplayStreamRetirementInput,
    RtcTopologyReplayStreamRetirementResult
} from '../consumer/rtc-topology-replay-contracts.ts';
import { RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE } from '../consumer/rtc-topology-replay-policy.ts';

export async function retireExpiredRtcTopologyReplayConsumerCursors(
    sql: PSqlSql,
    input: RtcTopologyReplayCursorRetirementInput
): Promise<RtcTopologyReplayCursorRetirementResult> {
    validatePositiveSafeInteger(input.retentionMs, 'retention');
    validateRetirementPageSize(input.pageSize);
    const deleted = await sql<Readonly<{ consumer_stream_id: string; }>[]>`
    delete from rtc_topology_replay_cursor
    where (consumer_stream_id, publisher_stream_id) in (
      select cursor.consumer_stream_id, cursor.publisher_stream_id
      from rtc_topology_replay_cursor as cursor
      join rtc_topology_delivery_stream as consumer
        on consumer.stream_id = cursor.consumer_stream_id
      where consumer.lease_expires_at <=
            clock_timestamp() - ${input.retentionMs} * interval '1 millisecond'
      order by cursor.consumer_stream_id, cursor.publisher_stream_id
      limit ${input.pageSize}
    )
    returning consumer_stream_id::text
  `;
    return { deletedCursorCount: deleted.length };
}

export async function retireRtcTopologyReplayEmptyStreams(
    sql: PSqlSql,
    input: RtcTopologyReplayStreamRetirementInput
): Promise<RtcTopologyReplayStreamRetirementResult> {
    validateRetirementPageSize(input.pageSize);
    return await sql.begin(async (transaction) => {
        await releaseSafePublisherCursors(transaction, input.pageSize);
        const deleted = await transaction<Readonly<{ stream_id: string; }>[]>`
      delete from rtc_topology_delivery_stream
      where stream_id in (
        select stream.stream_id
        from rtc_topology_delivery_stream as stream
        where stream.lease_expires_at <= clock_timestamp()
          and stream.retained_from_sequence = stream.head_sequence + 1
          and not exists (
            select 1
            from rtc_topology_delivery_log as entry
            where entry.publisher_stream_id = stream.stream_id
          )
          and not exists (
            select 1
            from rtc_topology_replay_cursor as cursor
            where cursor.consumer_stream_id = stream.stream_id
               or cursor.publisher_stream_id = stream.stream_id
          )
        order by stream.updated_at, stream.stream_id
        limit ${input.pageSize}
      )
      returning stream_id::text
    `;
        return { deletedStreamCount: deleted.length };
    });
}

async function releaseSafePublisherCursors(sql: PSqlSql, pageSize: number): Promise<void> {
    await sql`
    delete from rtc_topology_replay_cursor
    where (consumer_stream_id, publisher_stream_id) in (
      select cursor.consumer_stream_id, cursor.publisher_stream_id
      from rtc_topology_replay_cursor as cursor
      join rtc_topology_delivery_stream as publisher
        on publisher.stream_id = cursor.publisher_stream_id
      join rtc_topology_delivery_stream as consumer
        on consumer.stream_id = cursor.consumer_stream_id
      where publisher.lease_expires_at <= clock_timestamp()
        and publisher.retained_from_sequence = publisher.head_sequence + 1
        and cursor.last_processed_sequence = publisher.head_sequence
        and consumer.lease_expires_at > clock_timestamp()
        and not exists (
          select 1
          from rtc_topology_delivery_log as entry
          where entry.publisher_stream_id = publisher.stream_id
        )
      order by publisher.updated_at, publisher.stream_id, cursor.consumer_stream_id
      limit ${pageSize}
    )
  `;
}

function validateRetirementPageSize(pageSize: number): void {
    if (
        !Number.isSafeInteger(pageSize) ||
        pageSize <= 0 ||
        pageSize > RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE
    ) {
        throw new TypeError(
            `RTC topology retirement page size must be from 1 to ` +
                RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE
        );
    }
}

function validatePositiveSafeInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`RTC topology replay ${label} must be a positive safe integer`);
    }
}
