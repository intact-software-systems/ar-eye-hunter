import type {
    RtcTopologyDeliveryAppendPort
} from '../../rallar-system/topology/replay/rtc-topology-delivery-append-port.ts';
import type {
    RtcTopologyDeliveryAppendInput,
    RtcTopologyDeliveryAppendResult,
    RtcTopologyDeliveryCompactionInput,
    RtcTopologyDeliveryCompactionResult,
    RtcTopologyDeliveryLogEntry,
    RtcTopologyDeliveryStream,
    RtcTopologyDeliveryStreamLeaseRenewalInput,
    RtcTopologyDeliveryStreamLeaseRenewalResult,
    RtcTopologyDeliveryStreamRegistrationInput,
    RtcTopologyDeliveryStreamRegistrationResult
} from '../../rallar-system/topology/replay/rtc-topology-delivery-contracts.ts';
import {
    readRtcTopologyDeliverySafeInteger,
    RtcTopologyDeliveryCorruptionError,
    validateRtcTopologyDeliveryAppendInput,
    validateRtcTopologyDeliveryStreamId,
    type RtcTopologyDeliveryBoundaryNumber
} from '../../rallar-system/topology/replay/rtc-topology-delivery-validation.ts';
import type { PSqlSql } from '../p-sql-sql.ts';
import { compactRtcTopologyDeliveryEntries } from './compact-rtc-topology-delivery-entries.ts';

interface StreamRow {
    readonly stream_id: string;
    readonly head_sequence: RtcTopologyDeliveryBoundaryNumber;
    readonly retained_from_sequence: RtcTopologyDeliveryBoundaryNumber;
    readonly lease_expires_at_epoch_ms: RtcTopologyDeliveryBoundaryNumber;
}

interface AppendStreamRow extends StreamRow {
    readonly lease_valid: boolean;
}

interface DeliveryLogRow {
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

interface AppendQueryRow extends DeliveryLogRow {
    readonly result_kind: 'appended' | 'existing';
}

export class PSqlRtcTopologyDeliveryRepository implements RtcTopologyDeliveryAppendPort {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async registerStream(
        input: RtcTopologyDeliveryStreamRegistrationInput
    ): Promise<RtcTopologyDeliveryStreamRegistrationResult> {
        validateRtcTopologyDeliveryStreamId(input.streamId);
        validatePositiveDuration(input.leaseDurationMs);
        const rows = await this.sql<StreamRow[]>`
      insert into rtc_topology_delivery_stream (
        stream_id,
        head_sequence,
        retained_from_sequence,
        lease_expires_at
      ) values (
        ${input.streamId},
        0,
        1,
        clock_timestamp() + ${input.leaseDurationMs} * interval '1 millisecond'
      )
      on conflict (stream_id) do nothing
      returning
        stream_id::text,
        head_sequence::double precision as head_sequence,
        retained_from_sequence::double precision as retained_from_sequence,
        (extract(epoch from lease_expires_at) * 1000)::double precision
          as lease_expires_at_epoch_ms
    `;
        const row = rows[0];
        if (!row) {
            return { status: 'conflict' };
        }

        return { status: 'registered', stream: toStream(row) };
    }

    async appendOrValidate(
        transaction: PSqlSql,
        input: RtcTopologyDeliveryAppendInput
    ): Promise<RtcTopologyDeliveryAppendResult> {
        validateRtcTopologyDeliveryAppendInput(input);
        const result = await appendOrReadExistingEntry(transaction, input);
        if (result) {
            const entry = toLogEntry(result);
            validateExistingEntry(entry, input);
            return { status: result.result_kind, entry };
        }

        const stream = await readAppendStream(transaction, input.publisherStreamId);
        if (!stream?.lease_valid) {
            return { status: 'lease-lost' };
        }
        const headSequence = readRtcTopologyDeliverySafeInteger(
            stream.head_sequence,
            'RTC topology delivery HEAD'
        );
        if (headSequence === Number.MAX_SAFE_INTEGER) {
            throw new RtcTopologyDeliveryCorruptionError(
                `RTC topology delivery HEAD is exhausted for ${input.publisherStreamId}`
            );
        }

        return { status: 'conflict' };
    }

    async renewStreamLease(
        input: RtcTopologyDeliveryStreamLeaseRenewalInput
    ): Promise<RtcTopologyDeliveryStreamLeaseRenewalResult> {
        validateRtcTopologyDeliveryStreamId(input.streamId);
        validatePositiveDuration(input.leaseDurationMs);
        const rows = await this.sql<StreamRow[]>`
      update rtc_topology_delivery_stream
      set lease_expires_at = clock_timestamp() +
            ${input.leaseDurationMs} * interval '1 millisecond',
          updated_at = clock_timestamp()
      where stream_id = ${input.streamId}
        and lease_expires_at > clock_timestamp()
      returning
        stream_id::text,
        head_sequence::double precision as head_sequence,
        retained_from_sequence::double precision as retained_from_sequence,
        (extract(epoch from lease_expires_at) * 1000)::double precision
          as lease_expires_at_epoch_ms
    `;
        const row = rows[0];
        return row ? { status: 'renewed', stream: toStream(row) } : { status: 'lease-lost' };
    }

    async compactExpiredEntries(
        input: RtcTopologyDeliveryCompactionInput
    ): Promise<RtcTopologyDeliveryCompactionResult> {
        return await compactRtcTopologyDeliveryEntries({
            database: this.sql,
            compaction: input
        });
    }
}

async function appendOrReadExistingEntry(
    sql: PSqlSql,
    input: RtcTopologyDeliveryAppendInput
): Promise<AppendQueryRow | undefined> {
    const rows = await sql<AppendQueryRow[]>`
    with existing_publication as materialized (
      select
        publisher_stream_id,
        sequence,
        application_id,
        workspace_id,
        group_id,
        publication_id,
        outbox_topic_id,
        outbox_resource_id,
        outbox_context_id,
        retain_until,
        inserted_at
      from rtc_topology_delivery_log
      where application_id = ${input.groupRef.applicationId}
        and workspace_id = ${input.groupRef.workspaceId}
        and group_id = ${input.groupRef.groupId}
        and publication_id = ${input.publicationId}
    ),
    append_stream as (
      select stream.head_sequence
      from rtc_topology_delivery_stream as stream
      where stream.stream_id = ${input.publisherStreamId}
        and stream.lease_expires_at > statement_timestamp()
        and stream.head_sequence < ${Number.MAX_SAFE_INTEGER}
        and not exists (select 1 from existing_publication)
    ),
    advanced_stream as (
      update rtc_topology_delivery_stream as stream
      set head_sequence = stream.head_sequence + 1,
          updated_at = statement_timestamp()
      from append_stream
      where stream.stream_id = ${input.publisherStreamId}
        and stream.head_sequence = append_stream.head_sequence
        and stream.lease_expires_at > statement_timestamp()
        and stream.head_sequence < ${Number.MAX_SAFE_INTEGER}
      returning stream.head_sequence
    ),
    inserted_entry as (
      insert into rtc_topology_delivery_log (
        publisher_stream_id,
        sequence,
        application_id,
        workspace_id,
        group_id,
        publication_id,
        outbox_topic_id,
        outbox_resource_id,
        outbox_context_id,
        retain_until
      )
      select
        ${input.publisherStreamId},
        advanced_stream.head_sequence,
        ${input.groupRef.applicationId},
        ${input.groupRef.workspaceId},
        ${input.groupRef.groupId},
        ${input.publicationId},
        ${input.outboxKey.topicId},
        ${input.outboxKey.resourceId},
        ${input.outboxKey.contextId},
        ${new Date(input.retainUntilEpochMs)}
      from advanced_stream
      returning
        publisher_stream_id,
        sequence,
        application_id,
        workspace_id,
        group_id,
        publication_id,
        outbox_topic_id,
        outbox_resource_id,
        outbox_context_id,
        retain_until,
        inserted_at
    )
    select
      'existing'::text as result_kind,
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
    from existing_publication
    union all
    select
      'appended'::text as result_kind,
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
    from inserted_entry
  `;
    return rows[0];
}

async function readAppendStream(
    sql: PSqlSql,
    streamId: string
): Promise<AppendStreamRow | undefined> {
    const rows = await sql<AppendStreamRow[]>`
    select
      stream_id::text,
      head_sequence::double precision as head_sequence,
      retained_from_sequence::double precision as retained_from_sequence,
      (extract(epoch from lease_expires_at) * 1000)::double precision
        as lease_expires_at_epoch_ms,
      lease_expires_at > clock_timestamp() as lease_valid
    from rtc_topology_delivery_stream
    where stream_id = ${streamId}
  `;
    return rows[0];
}

function toStream(row: StreamRow): RtcTopologyDeliveryStream {
    return {
        streamId: row.stream_id,
        headSequence: readRtcTopologyDeliverySafeInteger(
            row.head_sequence,
            'RTC topology delivery HEAD'
        ),
        retainedFromSequence: readRtcTopologyDeliverySafeInteger(
            row.retained_from_sequence,
            'RTC topology delivery retained floor'
        ),
        leaseExpiresAtEpochMs: readRtcTopologyDeliverySafeInteger(
            row.lease_expires_at_epoch_ms,
            'RTC topology delivery lease expiry'
        )
    };
}

function toLogEntry(row: DeliveryLogRow): RtcTopologyDeliveryLogEntry {
    return {
        publisherStreamId: row.publisher_stream_id,
        sequence: readRtcTopologyDeliverySafeInteger(row.sequence, 'RTC topology delivery sequence'),
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

function validateExistingEntry(
    entry: RtcTopologyDeliveryLogEntry,
    input: RtcTopologyDeliveryAppendInput
): void {
    if (
        entry.groupRef.applicationId !== input.groupRef.applicationId ||
        entry.groupRef.workspaceId !== input.groupRef.workspaceId ||
        entry.groupRef.groupId !== input.groupRef.groupId ||
        entry.publicationId !== input.publicationId ||
        entry.outboxKey.topicId !== input.outboxKey.topicId ||
        entry.outboxKey.resourceId !== input.outboxKey.resourceId ||
        entry.outboxKey.contextId !== input.outboxKey.contextId ||
        entry.retainUntilEpochMs !== input.retainUntilEpochMs
    ) {
        throw new RtcTopologyDeliveryCorruptionError(
            `RTC topology delivery publication ${input.publicationId} has conflicting durable identity`
        );
    }
}

function validatePositiveDuration(durationMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
        throw new TypeError('RTC topology delivery lease duration must be a positive safe integer');
    }
}
