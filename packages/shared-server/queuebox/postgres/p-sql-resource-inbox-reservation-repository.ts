import { Temporal } from '@js-temporal/polyfill';
import { resolveResourceInboxWorkPosition } from './resolve-resource-inbox-work-position.ts';

import {
    toResourceInboxReservationOptions,
    type ResourceInboxContextClaim,
    type ResourceInboxReleaseDisposition,
    type ResourceInboxReservationInput,
    type ResourceInboxReservationOptions,
    type ResourceInboxWorkPage
} from '@shared/queuebox/queue-box-types.ts';
import {
    hasSameResourceEntryValue,
    resolveResourceInboxWorkPageRequest
} from '@shared/queuebox/resource-entry-observations.ts';
import {
    resolveResourceInboxClaimOrder,
    type ResourceInboxClaimOrder
} from '@shared/queuebox/resource-inbox/resource-inbox-claim-order.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { Either } from '@shared/resilience/Either.ts';

import { PSqlFragment } from '../../postgres/p-sql-fragment.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from './p-sql-resource-inbox-entry-repository.ts';
import {
    readResourceInboxWorkPresences,
    type ResourceInboxWorkPresence,
    type ResourceInboxWorkPresenceRead
} from './read-resource-inbox-work-presences.ts';
import {
    replaceObservedResourceInboxEntries,
    type ResourceInboxObservedReplacement
} from './replace-observed-resource-inbox-entry.ts';
import { requeueObservedResourceInboxDeliveryFailure } from './requeue-observed-resource-inbox-delivery-failure.ts';
import {
    parseTemporalPlainDateTime,
    rowsToMap,
    toDomain,
    toInstant,
    type ResourceInboxRow
} from './resource-inbox-row-codec.ts';
import type { PSqlReservationObservationRow } from './to-p-sql-reservation-observations.ts';

export interface StartProcessingEntitySkipped {
    readonly kind: 'expired-or-missing';
    readonly key: Key;
}

/** The row after the claim plus the lifecycle it was selected with, which must have been valid to claim. */
interface ClaimedResourceInboxRow extends ResourceInboxRow {
    readonly previous_persisted_retry_delay_us: unknown;
    readonly due_to_reservation_observation_us: unknown;
    readonly selected_status: string;
    readonly selected_attempts: bigint | null;
    readonly selected_start_ts: string | null;
    readonly selected_end_ts: string | null;
    readonly selected_next_ts: string | null;
}

export namespace PSqlResourceInboxReservationRepository {
    export interface WorkPosition {
        readonly createdAt: string;
        readonly rowId: bigint;
    }

    export interface ReservationSelection {
        readonly typeIds: ReadonlySet<string>;
        readonly statusIds: ReadonlySet<EntityStatus>;
        readonly reservationInput: ResourceInboxReservationInput;
    }
    export interface ReservationClaim extends ReservationSelection {
        /** Undefined claims in queue order. */
        readonly contextClaim: ResourceInboxContextClaim | undefined;
    }
    export interface ReservationObservationClaim extends ReservationClaim {
        readonly reservationObservation: 'postgres-ordinary-retry-v1';
    }
    export interface ReservationObservationResult {
        readonly entries: Map<string, ResourceEntry>;
        readonly observations: readonly PSqlReservationObservationRow[];
    }
    export interface OverdueRetryReservation extends ResourceInboxReservationOptions {
        /** Overdue rows of these contexts are not claimed. */
        readonly excludedContextIds: ReadonlySet<string>;
    }
    export interface ReservationRead extends ReservationSelection {
        readonly observedRowIds: readonly string[];
    }
    export interface TimeoutReservationRead {
        readonly typeIds: ReadonlySet<string>;
        readonly timeSinceStartMs: number;
        readonly reservationInput: ResourceInboxReservationInput;
        readonly observedRowIds?: readonly string[];
        /** Lapsed reservations of these contexts are not reclaimed. */
        readonly excludedContextIds: ReadonlySet<string>;
    }
}

export class PSqlResourceInboxReservationRepository {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async readWorkPage(input: ResourceInboxWorkPage.Request): Promise<ResourceInboxWorkPage> {
        const request = { ...input, cursor: input.cursor === null ? null : { ...input.cursor } };
        const validated = resolveResourceInboxWorkPageRequest(request);
        if (validated.left) {
            throw validated.left;
        }
        const validatedPosition = resolveResourceInboxWorkPosition(request.cursor?.position ?? null);
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
     * Rows are taken in their `ResourceInboxClaimOrder`; creation order matters here because row ids
     * follow each session's cached sequence block rather than arrival. A context claim selects only its
     * contexts' heads: each context's first eligible row in claim order, of a context its caller did not
     * exclude. A row whose selected lifecycle was corrupt throws, so the caller's transaction rolls the
     * claim back instead of repairing the row. `RETURNING` keeps no order, so the claim order is restored
     * from the returned creation time or the selected due time.
     */
    reserveEntriesSkipLocked(
        claim: PSqlResourceInboxReservationRepository.ReservationObservationClaim
    ): Promise<PSqlResourceInboxReservationRepository.ReservationObservationResult>;
    reserveEntriesSkipLocked(
        claim: PSqlResourceInboxReservationRepository.ReservationClaim
    ): Promise<Map<string, ResourceEntry>>;
    async reserveEntriesSkipLocked(
        claim:
            | PSqlResourceInboxReservationRepository.ReservationClaim
            | PSqlResourceInboxReservationRepository.ReservationObservationClaim
    ): Promise<Map<string, ResourceEntry> | PSqlResourceInboxReservationRepository.ReservationObservationResult> {
        const { typeIds, statusIds, reservationInput, contextClaim } = claim;
        const capture = 'reservationObservation' in claim;
        const { maxToReserve, maxAttempts, allowedTopicIds } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        if (typeIds.size === 0 || statusIds.size === 0 || maxToReserve === 0) {
            return capture ? { entries: new Map(), observations: [] } : new Map();
        }
        const eligibility = { typeIds: [...typeIds], statusIds: [...statusIds], maxAttempts, allowedTopicIds };
        const order = resolveResourceInboxClaimOrder(statusIds);
        const statement = toReservationStatement({ eligibility, order, contextClaim, maxToReserve, capture });
        const rows = await this.sql<ClaimedResourceInboxRow[]>(...statement.toStatement());
        for (const row of rows) {
            toDomain(toSelectedResourceInboxRow(row));
        }

        const entries = rowsToMap([...rows].sort((left, right) => compareClaimedRows(order, left, right)));
        return capture
            ? {
                entries,
                observations: rows.map((row) => ({
                    entry: entries.get(row.ri_row_id.toString())!,
                    selectedStatus: row.selected_status,
                    selectedEndTs: row.selected_end_ts,
                    selectedNextTs: row.selected_next_ts,
                    previousPersistedRetryDelayUs: row.previous_persisted_retry_delay_us,
                    dueToReservationObservationUs: row.due_to_reservation_observation_us
                }))
            }
            : entries;
    }

    /** The observed rows a claim may still start, locked for the transaction that validates their observations. */
    async findEntriesSkipLocked(
        { typeIds, statusIds, reservationInput, observedRowIds }: PSqlResourceInboxReservationRepository.ReservationRead
    ): Promise<Map<string, ResourceEntry>> {
        if (typeIds.size === 0 || statusIds.size === 0 || observedRowIds.length === 0) {
            return new Map();
        }

        const { maxAttempts, allowedTopicIds } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const eligibility = { typeIds: [...typeIds], statusIds: [...statusIds], maxAttempts, allowedTopicIds };
        const statement = PSqlFragment.of`
            select candidate.*
            from resource_inbox candidate
            where candidate.ri_row_id = any(${observedRowIds}::bigint[])
              and ${toEligibleRowPredicate('candidate', eligibility)}
            order by candidate.next_ts asc nulls first, candidate.ri_row_id asc
                for update skip locked
            limit ${observedRowIds.length}
        `;
        const rows = await this.sql<ResourceInboxRow[]>(...statement.toStatement());

        return rowsToMap(rows);
    }

    async findOverdueRetryEntriesSkipLocked(
        typeIds: ReadonlySet<string>,
        overdueBeforeEpochMs: number,
        reservation: PSqlResourceInboxReservationRepository.OverdueRetryReservation
    ): Promise<Map<string, ResourceEntry>> {
        const { maxToReserve, maxAttempts, excludedContextIds, allowedTopicIds } = reservation;
        if (typeIds.size === 0 || maxToReserve <= 0) {
            return new Map();
        }

        const overdueBefore = new Date(overdueBeforeEpochMs);
        const statement = PSqlFragment.of`
            select *
            from resource_inbox
            where ${PSqlFragment.toTextListPredicate(PSqlFragment.identifier('ri_type_id'), [...typeIds])}
              and (${allowedTopicIds === undefined} or ri_topic_id = any(${[...allowedTopicIds ?? []]}::text[]))
              and ri_status = ${EntityStatus.RETRY}
              and expire_ts > (now() at time zone 'UTC')
              and next_ts <= ${overdueBefore}
              and ri_attempts < ${maxAttempts}
              and fk_ext_bank_id <> all(${[...excludedContextIds]}::varchar[])
            order by next_ts asc, ri_row_id asc
                for update skip locked
            limit ${maxToReserve}
        `;
        const rows = await this.sql<ResourceInboxRow[]>(...statement.toStatement());

        return rowsToMap(rows);
    }

    async findTimedOutReservedEntriesSkipLocked(
        { typeIds, timeSinceStartMs, reservationInput, observedRowIds, excludedContextIds }:
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

        const { maxToReserve, maxAttempts, allowedTopicIds } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        // Separate query shapes let observed reads use the row-ID index even with a generic plan.
        const rows = observedRowIds === undefined
            ? await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id = any(${[...typeIds]}::text[])
              and (${allowedTopicIds === undefined} or ri_topic_id = any(${[...allowedTopicIds ?? []]}::text[]))
              and ri_status = ${EntityStatus.RESERVED}
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts < ${maxAttempts}
              and start_ts is not null
              and start_ts < (now() - (${timeSinceStartMs} * interval '1 millisecond')) at time zone 'UTC'
              and fk_ext_bank_id <> all(${[...excludedContextIds]}::varchar[])
            order by ri_row_id
                for update skip locked
            limit ${maxToReserve}
        `
            : await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id = any(${[...typeIds]}::text[])
              and (${allowedTopicIds === undefined} or ri_topic_id = any(${[...allowedTopicIds ?? []]}::text[]))
              and ri_status = ${EntityStatus.RESERVED}
              and ri_row_id = any(${observedRowIds}::bigint[])
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts < ${maxAttempts}
              and start_ts is not null
              and start_ts < (now() - (${timeSinceStartMs} * interval '1 millisecond')) at time zone 'UTC'
              and fk_ext_bank_id <> all(${[...excludedContextIds]}::varchar[])
            order by ri_row_id
                for update skip locked
            limit ${observedRowIds.length}
        `;

        return rowsToMap(rows);
    }

    /** Every read's lane presence, in the order given, from one statement. */
    async readWorkPresences(
        reads: readonly ResourceInboxWorkPresenceRead[]
    ): Promise<readonly ResourceInboxWorkPresence[]> {
        return await readResourceInboxWorkPresences(this.sql, reads);
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

    /**
     * Every reservation of a batch released in one statement, answered in the order given: the released row, or null
     * where the observation was no reservation or its row no longer holds it. A row observed twice is released by its
     * first replacement only; the later one finds the row moved, as a second statement would have.
     */
    async releaseReserved(
        computed: readonly ResourceInboxObservedReplacement[]
    ): Promise<readonly (ResourceEntry | null)[]> {
        const releasable = new Map<bigint, ResourceInboxObservedReplacement>();
        for (const replacement of computed) {
            if (
                replacement.expected.entry.status === EntityStatus.RESERVED &&
                !releasable.has(replacement.expectedRowId)
            ) {
                releasable.set(replacement.expectedRowId, replacement);
            }
        }
        const released = await replaceObservedRowsById(this.sql, releasable);
        return computed.map((replacement) =>
            releasable.get(replacement.expectedRowId) === replacement
                ? released.get(replacement.expectedRowId) ?? null
                : null
        );
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

/** Creation time or due instant, with unscheduled rows ahead, then row identity. */
function compareClaimedRows(
    order: ResourceInboxClaimOrder,
    left: ClaimedResourceInboxRow,
    right: ClaimedResourceInboxRow
): number {
    const placeOrder = order === 'creation'
        ? Temporal.PlainDateTime.compare(
            parseTemporalPlainDateTime(left.created_ts),
            parseTemporalPlainDateTime(right.created_ts)
        )
        : Math.sign(Number(toSelectedDueRank(left) - toSelectedDueRank(right)));
    return placeOrder !== 0 ? placeOrder : Math.sign(Number(BigInt(left.ri_row_id) - BigInt(right.ri_row_id)));
}

/** An unscheduled row ranks before every due instant, which is never before the epoch. */
function toSelectedDueRank(row: ClaimedResourceInboxRow): bigint {
    return row.selected_next_ts === null ? -1n : toInstant(row.selected_next_ts).epochNanoseconds;
}

interface ResourceInboxEligibility {
    readonly allowedTopicIds: ReadonlySet<string> | undefined;
    readonly typeIds: readonly string[];
    readonly statusIds: readonly EntityStatus[];
    readonly maxAttempts: number;
}

interface ResourceInboxContextHeadSelection {
    readonly eligibility: ResourceInboxEligibility;
    readonly order: ResourceInboxClaimOrder;
    readonly contextClaim: ResourceInboxContextClaim;
}

interface ResourceInboxReservationStatement {
    readonly eligibility: ResourceInboxEligibility;
    readonly order: ResourceInboxClaimOrder;
    readonly contextClaim: ResourceInboxContextClaim | undefined;
    readonly maxToReserve: number;
    readonly capture: boolean;
}

function toReservationStatement(
    { eligibility, order, contextClaim, maxToReserve, capture }: ResourceInboxReservationStatement
): PSqlFragment {
    const contextHead = contextClaim === undefined
        ? PSqlFragment.of``
        : toContextHeadPredicate({ eligibility, order, contextClaim });
    return PSqlFragment.of`
            update resource_inbox
            set ri_status   = ${EntityStatus.RESERVED},
                ri_attempts = ri_attempts + 1,
                start_ts    = now() at time zone 'UTC',
                end_ts      = null,
                next_ts     = null
            from (
                select candidate.ri_row_id,
                       candidate.ri_status as selected_status,
                       candidate.ri_attempts as selected_attempts,
                       candidate.start_ts as selected_start_ts,
                       candidate.end_ts as selected_end_ts,
                       candidate.next_ts as selected_next_ts
                from resource_inbox candidate
                where ${toEligibleRowPredicate('candidate', eligibility)}
                  ${contextHead}
                order by ${toClaimOrderBy('candidate', order)}
                    for update of candidate skip locked
                limit ${maxToReserve}
            ) as selected
            where resource_inbox.ri_row_id = selected.ri_row_id
            returning resource_inbox.*,
                      selected.selected_status,
                      selected.selected_attempts,
                      selected.selected_start_ts,
                      selected.selected_end_ts,
                      selected.selected_next_ts
                      ${
        capture
            ? PSqlFragment.of`,
                          case when selected.selected_status = 'RETRY' then
                              trunc(extract(epoch from (selected.selected_next_ts - selected.selected_end_ts)) * 1000000)::text
                          end as previous_persisted_retry_delay_us,
                          case when selected.selected_status = 'RETRY' then
                              trunc(extract(epoch from ((clock_timestamp() at time zone 'UTC') - selected.selected_next_ts)) * 1000000)::text
                          end as due_to_reservation_observation_us`
            : PSqlFragment.of``
    }
        `;
}

/** A row a NEW or RETRY claim may start now: its type and status, alive, attempts left, and due. */
function toEligibleRowPredicate(alias: 'candidate' | 'head', eligibility: ResourceInboxEligibility): PSqlFragment {
    const row = PSqlFragment.identifier(alias);
    return PSqlFragment.of`(
        ${PSqlFragment.toTextListPredicate(PSqlFragment.of`${row}.ri_type_id`, eligibility.typeIds)}
        and ${PSqlFragment.toTextListPredicate(PSqlFragment.of`${row}.ri_status`, eligibility.statusIds)}
        and (${eligibility.allowedTopicIds === undefined} or ${row}.ri_topic_id = any(${[
        ...eligibility.allowedTopicIds ?? []
    ]}::text[]))
        and ${row}.ri_status <> ${EntityStatus.FAILED}
        and ${row}.expire_ts > (now() at time zone 'UTC')
        and ${row}.ri_attempts < ${eligibility.maxAttempts}
        and (
            (${row}.ri_status = ${EntityStatus.RETRY} and ${row}.next_ts <= (now() at time zone 'UTC'))
            or
            (${row}.ri_status <> ${EntityStatus.RETRY} and ${row}.start_ts is null
                and (${row}.next_ts is null or ${row}.next_ts <= (now() at time zone 'UTC')))
        )
    )`;
}

/**
 * The candidate is its context's first eligible row in claim order, and its context is not excluded. One sort of the
 * eligible rows names every context's head; a per-candidate probe for an eligible row ahead is quadratic in them.
 */
function toContextHeadPredicate({ eligibility, order, contextClaim }: ResourceInboxContextHeadSelection): PSqlFragment {
    return PSqlFragment.of`
        and candidate.ri_row_id in (
            select distinct on (head.fk_ext_bank_id) head.ri_row_id
            from resource_inbox head
            where ${toEligibleRowPredicate('head', eligibility)}
              and head.fk_ext_bank_id <> all(${[...contextClaim.excludedContextIds]}::varchar[])
            order by head.fk_ext_bank_id, ${toClaimOrderBy('head', order)}
        )`;
}

function toClaimOrderBy(alias: 'candidate' | 'head', order: ResourceInboxClaimOrder): PSqlFragment {
    const row = PSqlFragment.identifier(alias);
    return order === 'creation'
        ? PSqlFragment.of`${row}.created_ts asc, ${row}.ri_row_id asc`
        : PSqlFragment.of`${row}.next_ts asc nulls first, ${row}.ri_row_id asc`;
}

/**
 * Every replacement of a distinct row in one statement: the replaced rows by row identity, none for a row that
 * moved.
 */
async function replaceObservedRowsById(
    sql: PSqlSql,
    replacementsByRowId: ReadonlyMap<bigint, ResourceInboxObservedReplacement>
): Promise<ReadonlyMap<bigint, ResourceEntry>> {
    if (replacementsByRowId.size === 0) {
        return new Map();
    }
    const rows = await replaceObservedResourceInboxEntries(sql, [...replacementsByRowId.values()]);
    return new Map(rows.map((row) => {
        const rowId = BigInt(row.ri_row_id);
        return [rowId, toReplacedEntry(row, replacementsByRowId.get(rowId))];
    }));
}

function toReplacedEntry(row: ResourceInboxRow, computed: ResourceInboxObservedReplacement | undefined): ResourceEntry {
    const updated = toDomain(row);
    if (
        computed === undefined || !hasSameResourceEntryValue(updated, { ...computed.replacement.entry, db: updated.db })
    ) {
        throw new ResourceInboxInvariantCorruptionError(
            updated.key,
            'Resource inbox compare-and-replace returned a row other than its replacement'
        );
    }
    return updated;
}
