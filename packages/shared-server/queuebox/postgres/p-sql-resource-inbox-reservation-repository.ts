import { Temporal } from '@js-temporal/polyfill';

import { EnqueuedType } from '@shared/api/api-config.ts';
import {
    toResourceInboxReservationOptions,
    type ResourceInboxReleaseDisposition,
    type ResourceInboxReservationInput,
    type ResourceInboxWorkPage
} from '@shared/queuebox/queue-box-types.ts';
import { validateResourceInboxWorkPageRequest } from '@shared/queuebox/resource-entry-observations.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from './p-sql-resource-inbox-entry-repository.ts';
import type { ResourceInboxObservedReplacement } from './replace-observed-resource-inbox-entry.ts';
import { requeueObservedResourceInboxDeliveryFailure } from './requeue-observed-resource-inbox-delivery-failure.ts';
import {
    rowsToMap,
    toDomain,
    toInstant,
    type ResourceInboxRow
} from './resource-inbox-row-codec.ts';

export interface StartProcessingEntitySkipped {
    readonly kind: 'expired-or-missing';
    readonly key: Key;
}

export namespace PSqlResourceInboxReservationRepository {
    export interface ReservationClaim {
        readonly typeIds: ReadonlySet<string>;
        readonly statusIds: ReadonlySet<EntityStatus>;
        readonly reservationInput: ResourceInboxReservationInput;
    }
    export interface ReservationRead extends ReservationClaim {
        readonly observedRowIds: readonly string[];
    }
    export interface TimeoutReservationRead {
        readonly typeIds: ReadonlySet<string>;
        readonly timeSinceStartMs: number;
        readonly reservationInput: ResourceInboxReservationInput;
        readonly observedRowIds?: readonly string[];
    }

    export interface WorkPosition {
        readonly createdAt: string;
        readonly rowId: bigint;
    }

    export interface WorkPresenceRead {
        readonly typeIds: ReadonlySet<string>;
        readonly maxAttempts: number;
        readonly reservationLeaseMs: number;
        readonly finalizationStaleAfterMs: number;
        readonly staleDueThresholdMs: number;
    }

    /** Whether each lane's selector would find a row now; one statement answers all five. */
    export interface WorkPresence {
        readonly newRow: boolean;
        readonly dueRetry: boolean;
        readonly overdueRetry: boolean;
        readonly timedOutReservation: boolean;
        readonly staleExhaustedReservation: boolean;
    }
}

interface WorkPresenceRow {
    readonly has_new: boolean;
    readonly has_due_retry: boolean;
    readonly has_overdue_retry: boolean;
    readonly has_timed_out_reservation: boolean;
    readonly has_stale_exhausted_reservation: boolean;
}

/** The row after the claim plus the lifecycle it was selected with, which must have been valid to claim. */
interface ClaimedResourceInboxRow extends ResourceInboxRow {
    readonly selected_status: string;
    readonly selected_attempts: bigint | null;
    readonly selected_start_ts: string | null;
    readonly selected_end_ts: string | null;
    readonly selected_next_ts: string | null;
}

const NO_WORK_PRESENCE: PSqlResourceInboxReservationRepository.WorkPresence = {
    newRow: false,
    dueRetry: false,
    overdueRetry: false,
    timedOutReservation: false,
    staleExhaustedReservation: false
};

export class PSqlResourceInboxReservationRepository {
    private readonly sql: PSqlSql;
    private readonly now: () => Date;

    constructor(sql: PSqlSql, now: () => Date) {
        this.sql = sql;
        this.now = now;
    }

    async readWorkPage(input: ResourceInboxWorkPage.Request): Promise<ResourceInboxWorkPage> {
        const request = { ...input, cursor: input.cursor === null ? null : { ...input.cursor } };
        const validated = validateResourceInboxWorkPageRequest(request);
        if (validated.left) {
            throw validated.left;
        }
        const validatedPosition = validateWorkPosition(request.cursor?.position ?? null);
        if (validatedPosition.left) {
            throw validatedPosition.left;
        }
        const position = validatedPosition.right!;
        const rows = position === null
            ? await this.sql<ResourceInboxRow[]>`
                select * from resource_inbox
                where ri_type_id = ${request.typeId} and ri_status = ${request.status}
                order by created_ts, ri_row_id
                limit ${request.maxToRead}
            `
            : await this.sql<ResourceInboxRow[]>`
                select * from resource_inbox
                where ri_type_id = ${request.typeId} and ri_status = ${request.status}
                  and (created_ts, ri_row_id) > (${position.createdAt}::timestamp, ${position.rowId}::bigint)
                order by created_ts, ri_row_id
                limit ${request.maxToRead}
            `;
        const entries = rows.map(toDomain);
        const last = entries.at(-1);
        return {
            entries,
            nextCursor: entries.length === request.maxToRead && last !== undefined
                ? {
                    typeId: request.typeId,
                    status: request.status,
                    position: `${last.audit.createdTs.toString()}/${last.db!.id}`
                }
                : null
        };
    }

    /**
     * Selects and starts processing the next eligible rows in one statement: the same rows
     * `findEntriesSkipLocked` would lock, carrying the lease and attempt `startProcessingEntity` gives.
     * A row whose selected lifecycle was corrupt throws, so the caller's transaction rolls the claim
     * back instead of repairing the row. `RETURNING` keeps no order, so the selection order is
     * restored from the selected due time.
     */
    async reserveEntriesSkipLocked(
        { typeIds, statusIds, reservationInput }: PSqlResourceInboxReservationRepository.ReservationClaim
    ): Promise<Map<string, ResourceEntry>> {
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        if (typeIds.size === 0 || statusIds.size === 0 || maxToReserve === 0) {
            return new Map();
        }

        const rows = await this.sql<ClaimedResourceInboxRow[]>`
            update resource_inbox
            set ri_status   = ${EntityStatus.RESERVED},
                ri_attempts = ri_attempts + 1,
                start_ts    = now() at time zone 'UTC',
                end_ts      = null,
                next_ts     = null
            from (
                select ri_row_id,
                       ri_status as selected_status,
                       ri_attempts as selected_attempts,
                       start_ts as selected_start_ts,
                       end_ts as selected_end_ts,
                       next_ts as selected_next_ts
                from resource_inbox
                where ri_type_id in ${this.sql([...typeIds])}
                  and ri_status in ${this.sql([...statusIds])}
                  and ri_status <> ${EntityStatus.FAILED}
                  and expire_ts > (now() at time zone 'UTC')
                  and ri_attempts < ${maxAttempts}
                  and (
                      (ri_status = ${EntityStatus.RETRY} and next_ts <= (now() at time zone 'UTC'))
                      or
                      (ri_status <> ${EntityStatus.RETRY} and start_ts is null
                          and (next_ts is null or next_ts <= (now() at time zone 'UTC')))
                  )
                order by next_ts asc nulls first, ri_row_id asc
                    for update skip locked
                limit ${maxToReserve}
            ) as selected
            where resource_inbox.ri_row_id = selected.ri_row_id
            returning resource_inbox.*,
                      selected.selected_status,
                      selected.selected_attempts,
                      selected.selected_start_ts,
                      selected.selected_end_ts,
                      selected.selected_next_ts
        `;
        for (const row of rows) {
            toDomain(toSelectedResourceInboxRow(row));
        }

        return rowsToMap([...rows].sort(compareClaimedRows));
    }

    /** The observed rows a claim may still start, locked for the transaction that validates their observations. */
    async findEntriesSkipLocked(
        { typeIds, statusIds, reservationInput, observedRowIds }: PSqlResourceInboxReservationRepository.ReservationRead
    ): Promise<Map<string, ResourceEntry>> {
        if (typeIds.size === 0 || statusIds.size === 0 || observedRowIds.length === 0) {
            return new Map();
        }

        const { maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );

        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id in ${this.sql([...typeIds])}
              and ri_status in ${this.sql([...statusIds])}
              and ri_status <> ${EntityStatus.FAILED}
              and ri_row_id = any(${observedRowIds}::bigint[])
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts < ${maxAttempts}
              and (
                  (ri_status = ${EntityStatus.RETRY} and next_ts <= (now() at time zone 'UTC'))
                  or
                  (ri_status <> ${EntityStatus.RETRY} and start_ts is null
                      and (next_ts is null or next_ts <= (now() at time zone 'UTC')))
              )
            order by next_ts asc nulls first, ri_row_id asc
                for update skip locked
            limit ${observedRowIds.length}
        `;

        return rowsToMap(rows);
    }

    async findOverdueRetryEntriesSkipLocked(
        typeIds: ReadonlySet<string>,
        overdueBeforeEpochMs: number,
        reservationInput: ResourceInboxReservationInput
    ): Promise<Map<string, ResourceEntry>> {
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        if (typeIds.size === 0 || maxToReserve <= 0) {
            return new Map();
        }

        const overdueBefore = new Date(overdueBeforeEpochMs);
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id in ${this.sql([...typeIds])}
              and ri_status = ${EntityStatus.RETRY}
              and expire_ts > (now() at time zone 'UTC')
              and next_ts <= ${overdueBefore}
              and ri_attempts < ${maxAttempts}
            order by next_ts asc, ri_row_id asc
                for update skip locked
            limit ${maxToReserve}
        `;

        return rowsToMap(rows);
    }

    async findTimedOutReservedEntriesSkipLocked(
        { typeIds, timeSinceStartMs, reservationInput, observedRowIds }:
            PSqlResourceInboxReservationRepository.TimeoutReservationRead
    ): Promise<Map<string, ResourceEntry>> {
        if (!Number.isSafeInteger(timeSinceStartMs) || timeSinceStartMs < 0) {
            throw new Error(
                'Reserved-entry timeout must be a non-negative safe integer in milliseconds'
            );
        }
        if (typeIds.size === 0 || observedRowIds?.length === 0) {
            return new Map();
        }

        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        // Separate query shapes let observed reads use the row-ID index even with a generic plan.
        const rows = observedRowIds === undefined
            ? await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id in ${this.sql([...typeIds])}
              and ri_status = ${EntityStatus.RESERVED}
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts < ${maxAttempts}
              and start_ts is not null
              and start_ts < (now() - (${timeSinceStartMs} * interval '1 millisecond')) at time zone 'UTC'
            order by ri_row_id
                for update skip locked
            limit ${maxToReserve}
        `
            : await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id in ${this.sql([...typeIds])}
              and ri_status = ${EntityStatus.RESERVED}
              and ri_row_id = any(${observedRowIds}::bigint[])
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts < ${maxAttempts}
              and start_ts is not null
              and start_ts < (now() - (${timeSinceStartMs} * interval '1 millisecond')) at time zone 'UTC'
            order by ri_row_id
                for update skip locked
            limit ${observedRowIds.length}
        `;

        return rowsToMap(rows);
    }

    /**
     * The caller validated the durations with its work advertisement options. Exhaustion recovery is
     * an AppInbox lane; other types never advertise it.
     */
    async readWorkPresence(
        read: PSqlResourceInboxReservationRepository.WorkPresenceRead
    ): Promise<PSqlResourceInboxReservationRepository.WorkPresence> {
        const { typeIds, maxAttempts, reservationLeaseMs, finalizationStaleAfterMs, staleDueThresholdMs } = read;
        if (typeIds.size === 0) {
            return NO_WORK_PRESENCE;
        }
        const finalizationTypeId = typeIds.has(EnqueuedType.APP_INBOX) ? EnqueuedType.APP_INBOX : null;

        const [row] = await this.sql<WorkPresenceRow[]>`
            select
                exists(select 1 from resource_inbox
                    where ri_type_id in ${this.sql([...typeIds])}
                      and ri_status = ${EntityStatus.NEW}
                      and expire_ts > (now() at time zone 'UTC')
                      and ri_attempts < ${maxAttempts}
                      and start_ts is null
                      and (next_ts is null or next_ts <= (now() at time zone 'UTC'))) as has_new,
                exists(select 1 from resource_inbox
                    where ri_type_id in ${this.sql([...typeIds])}
                      and ri_status = ${EntityStatus.RETRY}
                      and expire_ts > (now() at time zone 'UTC')
                      and ri_attempts < ${maxAttempts}
                      and next_ts <= (now() at time zone 'UTC')) as has_due_retry,
                exists(select 1 from resource_inbox
                    where ri_type_id in ${this.sql([...typeIds])}
                      and ri_status = ${EntityStatus.RETRY}
                      and expire_ts > (now() at time zone 'UTC')
                      and ri_attempts < ${maxAttempts}
                      and next_ts <= (now() - (${staleDueThresholdMs} * interval '1 millisecond')) at time zone 'UTC'
                ) as has_overdue_retry,
                exists(select 1 from resource_inbox
                    where ri_type_id in ${this.sql([...typeIds])}
                      and ri_status = ${EntityStatus.RESERVED}
                      and expire_ts > (now() at time zone 'UTC')
                      and ri_attempts < ${maxAttempts}
                      and start_ts is not null
                      and start_ts < (now() - (${reservationLeaseMs} * interval '1 millisecond')) at time zone 'UTC'
                ) as has_timed_out_reservation,
                exists(select 1 from resource_inbox
                    where ri_type_id = ${finalizationTypeId}
                      and ri_status = ${EntityStatus.RESERVED}
                      and expire_ts > (now() at time zone 'UTC')
                      and ri_attempts >= ${maxAttempts}
                      and ri_attempts < ${Number.MAX_SAFE_INTEGER}
                      and start_ts is not null
                      and start_ts <= (now() - (${finalizationStaleAfterMs} * interval '1 millisecond')) at time zone 'UTC'
                ) as has_stale_exhausted_reservation
        `;
        if (row === undefined) {
            throw new Error('Resource inbox work presence statement returned no row');
        }

        return {
            newRow: row.has_new,
            dueRetry: row.has_due_retry,
            overdueRetry: row.has_overdue_retry,
            timedOutReservation: row.has_timed_out_reservation,
            staleExhaustedReservation: row.has_stale_exhausted_reservation
        };
    }

    async startProcessingEntity(
        entry: ResourceEntry,
        maxAttempts: number = DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
    ): Promise<Either<StartProcessingEntitySkipped, ResourceEntry>> {
        const attempts = entry.dequeueAudit.attempts + 1;

        const rows = await this.sql<ResourceInboxRow[]>`
            update resource_inbox
            set ri_status   = ${EntityStatus.RESERVED},
                ri_attempts = ${attempts},
                start_ts    = now() at time zone 'UTC',
                end_ts      = ${null},
                next_ts     = ${null}
            where ri_topic_id = ${entry.key.topicId}
              and ri_resource_id = ${entry.key.resourceId}
              and fk_ext_bank_id = ${entry.key.contextId}
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts < ${maxAttempts}
            returning *
        `;

        return rows.length === 0
            ? Either.ofLeft<StartProcessingEntitySkipped, ResourceEntry>({
                kind: 'expired-or-missing',
                key: entry.key
            })
            : Either.ofRight<StartProcessingEntitySkipped, ResourceEntry>(toDomain(rows[0]));
    }

    async releaseReserved(
        computed: ResourceInboxObservedReplacement
    ): Promise<ResourceEntry | null> {
        if (computed.expected.entry.status !== EntityStatus.RESERVED) {
            return null;
        }
        return await new PSqlResourceInboxEntryRepository(this.sql, this.now).writeObservedReplacement(computed);
    }

    async requeueObservedDeliveryFailure(
        observed: ResourceEntry,
        disposition: ResourceInboxReleaseDisposition
    ): Promise<ResourceEntry | null> {
        return await requeueObservedResourceInboxDeliveryFailure(
            this.sql,
            observed,
            disposition
        );
    }
}

function toSelectedResourceInboxRow(row: ClaimedResourceInboxRow): ResourceInboxRow {
    return {
        ...row,
        ri_status: row.selected_status,
        ri_attempts: row.selected_attempts,
        start_ts: row.selected_start_ts,
        end_ts: row.selected_end_ts,
        next_ts: row.selected_next_ts
    };
}

/** The selection order: due instant first with unscheduled rows ahead, then row identity. */
function compareClaimedRows(left: ClaimedResourceInboxRow, right: ClaimedResourceInboxRow): number {
    const dueOrder = compareSelectedDueTs(left.selected_next_ts, right.selected_next_ts);
    return dueOrder !== 0 ? dueOrder : compareRowIds(left.ri_row_id, right.ri_row_id);
}

function compareSelectedDueTs(left: string | null, right: string | null): number {
    if (left === null || right === null) {
        return left === right ? 0 : left === null ? -1 : 1;
    }
    return Temporal.Instant.compare(toInstant(left), toInstant(right));
}

function compareRowIds(left: bigint, right: bigint): number {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function validateWorkPosition(
    position: string | null
): Either<TypeError, PSqlResourceInboxReservationRepository.WorkPosition | null> {
    if (position === null) {
        return Either.ofRight(null);
    }
    if (position.length > 128) {
        return Either.ofLeft(
            new TypeError('PostgreSQL queue work cursor exceeds its timestamp and row identity bound')
        );
    }
    const value = position.split('/');
    if (value.length !== 2) {
        return Either.ofLeft(
            new TypeError('PostgreSQL queue work cursor requires a timestamp and positive row identity')
        );
    }
    const issues: string[] = [];
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u.test(value[0])) {
        issues.push('PostgreSQL queue work cursor timestamp is invalid');
    }
    else {
        try {
            Temporal.PlainDateTime.from(value[0]);
        }
        catch {
            issues.push('PostgreSQL queue work cursor timestamp is invalid');
        }
    }
    if (!/^[1-9]\d{0,18}$/u.test(value[1]) || BigInt(value[1]) > 9_223_372_036_854_775_807n) {
        issues.push('PostgreSQL queue work cursor requires a positive row identity within bigint range');
    }
    return issues.length > 0
        ? Either.ofLeft(new TypeError(issues.join('; ')))
        : Either.ofRight({ createdAt: value[0], rowId: BigInt(value[1]) });
}
