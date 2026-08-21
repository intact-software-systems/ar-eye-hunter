import {
    RtcTopologyDeliveryLeaseLostError
} from '../../rallar-system/topology/replay/rtc-topology-delivery-stream-service.ts';
import {
    readRtcTopologyDeliverySafeInteger,
    RtcTopologyDeliveryCorruptionError,
    validateRtcTopologyDeliveryStreamId,
    type RtcTopologyDeliveryBoundaryNumber
} from '../../rallar-system/topology/replay/rtc-topology-delivery-validation.ts';
import type {
    RtcTopologyReplayConsumerInput,
    RtcTopologyReplayCursorCasInput,
    RtcTopologyReplayCursorCasResult,
    RtcTopologyReplayCursorRetirementInput,
    RtcTopologyReplayCursorRetirementResult,
    RtcTopologyReplayCursorSnapshot,
    RtcTopologyReplayPageInput,
    RtcTopologyReplayPageResult,
    RtcTopologyReplayStreamRetirementInput,
    RtcTopologyReplayStreamRetirementResult
} from '../../rallar-system/topology/replay/rtc-topology-replay-contracts.ts';
import { RTC_TOPOLOGY_REPLAY_PAGE_SIZE } from '../../rallar-system/topology/replay/rtc-topology-replay-policy.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';
import {
    retireExpiredRtcTopologyReplayConsumerCursors,
    retireRtcTopologyReplayEmptyStreams
} from './p-sql-rtc-topology-replay-maintenance.ts';
import {
    readCursorSnapshots,
    requireCursorSnapshotRow,
    toCursorSnapshot,
    toLogEntry,
    validateCursorSnapshot,
    type CursorSnapshotRow,
    type DeliveryLogRow,
    type PageBoundaryRow
} from './p-sql-rtc-topology-replay-rows.ts';

export class PSqlRtcTopologyReplayRepository {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async initializeConsumer(
        input: RtcTopologyReplayConsumerInput
    ): Promise<readonly RtcTopologyReplayCursorSnapshot[]> {
        validateRtcTopologyDeliveryStreamId(input.consumerStreamId);
        const rows = await this.sql<CursorSnapshotRow[]>`
      with database_clock as materialized (
        select clock_timestamp() as now
      ),
      active_consumer as materialized (
        select stream_id
        from rtc_topology_delivery_stream
        cross join database_clock
        where stream_id = ${input.consumerStreamId}
          and lease_expires_at > database_clock.now
      ),
      captured_publishers as materialized (
        select
          stream_id,
          head_sequence,
          retained_from_sequence,
          lease_expires_at
        from rtc_topology_delivery_stream
        where exists (select 1 from active_consumer)
      ),
      inserted_cursors as (
        insert into rtc_topology_replay_cursor (
          consumer_stream_id,
          publisher_stream_id,
          last_processed_sequence
        )
        select
          active_consumer.stream_id,
          captured_publishers.stream_id,
          captured_publishers.head_sequence
        from active_consumer
        cross join captured_publishers
        returning
          consumer_stream_id,
          publisher_stream_id,
          last_processed_sequence,
          updated_at
      )
      select
        inserted_cursors.consumer_stream_id::text,
        inserted_cursors.publisher_stream_id::text,
        captured_publishers.head_sequence::double precision as head_sequence,
        captured_publishers.retained_from_sequence::double precision
          as retained_from_sequence,
        inserted_cursors.last_processed_sequence::double precision
          as last_processed_sequence,
        (extract(epoch from inserted_cursors.updated_at) * 1000)::double precision
          as cursor_updated_at_epoch_ms,
        (extract(epoch from captured_publishers.lease_expires_at) * 1000)::double precision
          as publisher_lease_expires_at_epoch_ms
      from inserted_cursors
      join captured_publishers
        on captured_publishers.stream_id = inserted_cursors.publisher_stream_id
      order by inserted_cursors.publisher_stream_id
    `;
        if (rows.length === 0) {
            throw new RtcTopologyDeliveryLeaseLostError(
                `RTC topology replay consumer ${input.consumerStreamId} is absent or lease-lost`
            );
        }
        return rows.map(toCursorSnapshot);
    }

    async discoverPublishers(
        input: RtcTopologyReplayConsumerInput
    ): Promise<readonly RtcTopologyReplayCursorSnapshot[]> {
        validateRtcTopologyDeliveryStreamId(input.consumerStreamId);
        return await this.sql.begin(async (transaction) => {
            const activeConsumer = await transaction<Readonly<{ stream_id: string; }>[]>`
        select stream_id::text
        from rtc_topology_delivery_stream
        where stream_id = ${input.consumerStreamId}
          and lease_expires_at > clock_timestamp()
      `;
            if (activeConsumer.length !== 1) {
                throw new RtcTopologyDeliveryLeaseLostError(
                    `RTC topology replay consumer ${input.consumerStreamId} is absent or lease-lost`
                );
            }
            await transaction`
        insert into rtc_topology_replay_cursor (
          consumer_stream_id,
          publisher_stream_id,
          last_processed_sequence
        )
        select
          ${input.consumerStreamId},
          publisher.stream_id,
          publisher.retained_from_sequence - 1
        from rtc_topology_delivery_stream as publisher
        where not exists (
          select 1
          from rtc_topology_replay_cursor as cursor
          where cursor.consumer_stream_id = ${input.consumerStreamId}
            and cursor.publisher_stream_id = publisher.stream_id
        )
        on conflict (consumer_stream_id, publisher_stream_id) do nothing
      `;
            const rows = await readCursorSnapshots(transaction, input.consumerStreamId);
            if (rows.length === 0) {
                throw new RtcTopologyDeliveryCorruptionError(
                    `RTC topology replay consumer ${input.consumerStreamId} has no durable cursors`
                );
            }
            return rows.map(toCursorSnapshot);
        });
    }

    async capturePage(
        input: RtcTopologyReplayPageInput
    ): Promise<RtcTopologyReplayPageResult> {
        validateRtcTopologyDeliveryStreamId(input.consumerStreamId);
        validateRtcTopologyDeliveryStreamId(input.publisherStreamId);
        validatePageSize(input.pageSize, RTC_TOPOLOGY_REPLAY_PAGE_SIZE, 'replay');
        return await this.sql.begin(async (transaction) => {
            const boundaries = await transaction<PageBoundaryRow[]>`
        with database_clock as materialized (
          select clock_timestamp() as now
        )
        select
          cursor.consumer_stream_id::text,
          publisher.stream_id::text as publisher_stream_id,
          publisher.head_sequence::double precision as head_sequence,
          publisher.retained_from_sequence::double precision as retained_from_sequence,
          cursor.last_processed_sequence::double precision as last_processed_sequence,
          (extract(epoch from cursor.updated_at) * 1000)::double precision
            as cursor_updated_at_epoch_ms,
          (extract(epoch from publisher.lease_expires_at) * 1000)::double precision
            as publisher_lease_expires_at_epoch_ms,
          consumer.lease_expires_at > database_clock.now as consumer_lease_valid,
          floor(extract(epoch from database_clock.now) * 1000)::double precision
            as database_now_epoch_ms
        from rtc_topology_delivery_stream as consumer
        cross join database_clock
        left join rtc_topology_delivery_stream as publisher
          on publisher.stream_id = ${input.publisherStreamId}
        left join rtc_topology_replay_cursor as cursor
          on cursor.consumer_stream_id = consumer.stream_id
         and cursor.publisher_stream_id = publisher.stream_id
        where consumer.stream_id = ${input.consumerStreamId}
      `;
            const boundary = boundaries[0];
            if (!boundary) {
                throw new RtcTopologyDeliveryLeaseLostError(
                    `RTC topology replay consumer ${input.consumerStreamId} is absent or lease-lost`
                );
            }
            if (!boundary.consumer_lease_valid) {
                throw new RtcTopologyDeliveryLeaseLostError(
                    `RTC topology replay consumer ${input.consumerStreamId} lost its lease`
                );
            }
            if (boundary.publisher_stream_id === null) {
                throw new RtcTopologyDeliveryCorruptionError(
                    `RTC topology replay publisher ${input.publisherStreamId} is missing`
                );
            }
            if (boundary.last_processed_sequence === null) {
                throw new RtcTopologyDeliveryCorruptionError(
                    `RTC topology replay consumer ${input.consumerStreamId} is missing ` +
                        `a cursor for ${input.publisherStreamId}`
                );
            }
            const snapshot = toCursorSnapshot(requireCursorSnapshotRow(boundary));
            const databaseNowEpochMs = readRtcTopologyDeliverySafeInteger(
                boundary.database_now_epoch_ms,
                'RTC topology replay database time'
            );
            validateCursorSnapshot(snapshot);
            const capture = {
                capturedHeadSequence: snapshot.headSequence,
                retainedFromSequence: snapshot.retainedFromSequence,
                databaseNowEpochMs
            };
            if (snapshot.lastProcessedSequence + 1 < snapshot.retainedFromSequence) {
                return {
                    status: 'gap',
                    ...capture,
                    cursorSequence: snapshot.lastProcessedSequence
                };
            }
            if (snapshot.lastProcessedSequence === snapshot.headSequence) {
                return {
                    status: 'caught-up',
                    ...capture,
                    cursorSequence: snapshot.lastProcessedSequence
                };
            }

            const rows = await transaction<DeliveryLogRow[]>`
        select
          publisher_stream_id::text,
          sequence::double precision as sequence,
          application_id,
          workspace_id,
          group_id,
          publication_id,
          outbox_topic_id,
          outbox_resource_id,
          outbox_context_id,
          (extract(epoch from retain_until) * 1000)::double precision
            as retain_until_epoch_ms,
          (extract(epoch from inserted_at) * 1000)::double precision
            as inserted_at_epoch_ms
        from rtc_topology_delivery_log
        where publisher_stream_id = ${input.publisherStreamId}
          and sequence > ${snapshot.lastProcessedSequence}
          and sequence <= ${snapshot.headSequence}
        order by sequence
        limit ${input.pageSize}
      `;
            const expectedCount = Math.min(
                input.pageSize,
                snapshot.headSequence - snapshot.lastProcessedSequence
            );
            if (rows.length !== expectedCount) {
                throw new RtcTopologyDeliveryCorruptionError(
                    `RTC topology replay publisher ${input.publisherStreamId} has an ` +
                        'unexplained physical hole'
                );
            }
            const entries = rows.map(toLogEntry);
            for (const [index, entry] of entries.entries()) {
                if (entry.sequence !== snapshot.lastProcessedSequence + index + 1) {
                    throw new RtcTopologyDeliveryCorruptionError(
                        `RTC topology replay publisher ${input.publisherStreamId} is not contiguous`
                    );
                }
            }
            return {
                status: 'page',
                ...capture,
                expectedCursorSequence: snapshot.lastProcessedSequence,
                entries,
                hasMore: entries.at(-1)!.sequence < snapshot.headSequence
            };
        });
    }

    async compareAndSetCursor(
        input: RtcTopologyReplayCursorCasInput
    ): Promise<RtcTopologyReplayCursorCasResult> {
        validateRtcTopologyDeliveryStreamId(input.consumerStreamId);
        validateRtcTopologyDeliveryStreamId(input.publisherStreamId);
        const expectedSequence = readRtcTopologyDeliverySafeInteger(
            input.expectedSequence,
            'RTC topology replay expected cursor'
        );
        const nextSequence = readRtcTopologyDeliverySafeInteger(
            input.nextSequence,
            'RTC topology replay next cursor'
        );
        if (nextSequence <= expectedSequence) {
            throw new TypeError('RTC topology replay cursor must advance');
        }
        const advanced = await this.sql<Readonly<{ consumer_stream_id: string; }>[]>`
      update rtc_topology_replay_cursor
      set last_processed_sequence = ${nextSequence},
          updated_at = clock_timestamp()
      where consumer_stream_id = ${input.consumerStreamId}
        and publisher_stream_id = ${input.publisherStreamId}
        and last_processed_sequence = ${expectedSequence}
        and exists (
          select 1
          from rtc_topology_delivery_stream as consumer
          where consumer.stream_id = ${input.consumerStreamId}
            and consumer.lease_expires_at > clock_timestamp()
        )
      returning consumer_stream_id::text
    `;
        if (advanced.length === 1) {
            return { status: 'advanced' };
        }

        const current = await this.sql<Readonly<{
            consumer_lease_valid: boolean;
            last_processed_sequence: RtcTopologyDeliveryBoundaryNumber | null;
        }>[]>`
      select
        consumer.lease_expires_at > clock_timestamp() as consumer_lease_valid,
        cursor.last_processed_sequence::double precision as last_processed_sequence
      from rtc_topology_delivery_stream as consumer
      left join rtc_topology_replay_cursor as cursor
        on cursor.consumer_stream_id = consumer.stream_id
       and cursor.publisher_stream_id = ${input.publisherStreamId}
      where consumer.stream_id = ${input.consumerStreamId}
    `;
        const row = current[0];
        if (!row || !row.consumer_lease_valid) {
            throw new RtcTopologyDeliveryLeaseLostError(
                `RTC topology replay consumer ${input.consumerStreamId} is absent or lease-lost`
            );
        }
        if (row.last_processed_sequence === null) {
            return { status: 'missing' };
        }
        return {
            status: 'conflict',
            currentSequence: readRtcTopologyDeliverySafeInteger(
                row.last_processed_sequence,
                'RTC topology replay current cursor'
            )
        };
    }

    async retireExpiredConsumerCursors(
        input: RtcTopologyReplayCursorRetirementInput
    ): Promise<RtcTopologyReplayCursorRetirementResult> {
        return await retireExpiredRtcTopologyReplayConsumerCursors(this.sql, input);
    }

    async retireEmptyStreams(
        input: RtcTopologyReplayStreamRetirementInput
    ): Promise<RtcTopologyReplayStreamRetirementResult> {
        return await retireRtcTopologyReplayEmptyStreams(this.sql, input);
    }
}

function validatePageSize(pageSize: number, maximum: number, label: string): void {
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > maximum) {
        throw new TypeError(`RTC topology ${label} page size must be from 1 to ${maximum}`);
    }
}
