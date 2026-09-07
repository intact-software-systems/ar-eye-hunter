import { Temporal } from '@js-temporal/polyfill';
import {
    toResourceInboxReleaseDisposition,
    toResourceInboxReservationOptions,
    type ResourceInboxReleaseDisposition,
    type ResourceInboxReservationInput,
    type ResourceInboxWorkPage
} from '@shared/queuebox/queue-box-types.ts';
import { validateResourceInboxWorkPageRequest } from '@shared/queuebox/resource-entry-observations.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from './p-sql-resource-inbox-entry-repository.ts';
import { requeueObservedResourceInboxDeliveryFailure } from './requeue-observed-resource-inbox-delivery-failure.ts';
import { rowsToMap, toDomain, type ResourceInboxRow } from './resource-inbox-row-codec.ts';

export type StartProcessingEntitySkipped = Readonly<{
    kind: 'expired-or-missing';
    key: Key;
}>;

export namespace PSqlResourceInboxReservationRepository {
    export interface WorkPosition {
        readonly createdAt: string;
        readonly rowId: bigint;
    }
}

export class PSqlResourceInboxReservationRepository {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
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

    async findEntriesSkipLocked(
        typeIds: ReadonlySet<string>,
        statusIds: ReadonlySet<EntityStatus>,
        reservationInput: ResourceInboxReservationInput,
        observedRowIds?: readonly string[]
    ): Promise<Map<string, ResourceEntry>> {
        if (typeIds.size === 0 || statusIds.size === 0 || observedRowIds?.length === 0) {
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
        `
            : await this.sql<ResourceInboxRow[]>`
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
        typeIds: ReadonlySet<string>,
        timeSinceStartMs: number,
        reservationInput: ResourceInboxReservationInput,
        observedRowIds?: readonly string[]
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

    async isEntriesToLock(
        typeIds: ReadonlySet<string>,
        statusIds: ReadonlySet<EntityStatus>,
        maxAttempts: number = DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
    ): Promise<boolean> {
        if (typeIds.size === 0 || statusIds.size === 0) {
            return false;
        }
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
            throw new Error('maxAttempts must be a positive safe integer');
        }

        const rows = await this.sql<{ one: number; }[]>`
            select 1 as one
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
            limit 1
        `;

        return rows.length > 0;
    }

    async isTimeoutOnReservedEntries(
        typeIds: ReadonlySet<string>,
        timeSinceStartTs: Temporal.Duration,
        maxAttempts: number = DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
    ): Promise<boolean> {
        if (typeIds.size === 0) {
            return false;
        }

        const timeoutMs = timeSinceStartTs.total({ unit: 'milliseconds' });
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
            throw new Error(
                'Reserved-entry timeout must be a non-negative safe integer in milliseconds'
            );
        }
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
            throw new Error('maxAttempts must be a positive safe integer');
        }

        const rows = await this.sql<{ one: number; }[]>`
            select 1 as one
            from resource_inbox
            where ri_type_id in ${this.sql([...typeIds])}
              and ri_status = ${EntityStatus.RESERVED}
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts < ${maxAttempts}
              and start_ts is not null
              and start_ts < (now() - (${timeoutMs} * interval '1 millisecond')) at time zone 'UTC'
            limit 1
        `;

        return rows.length > 0;
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
        expected: ResourceEntry,
        options: Readonly<{
            releasedAt: Temporal.Instant;
            disposition: ResourceInboxReleaseDisposition;
        }>
    ): Promise<ResourceEntry | null> {
        const disposition = toResourceInboxReleaseDisposition(options.disposition);
        if (expected.status !== EntityStatus.RESERVED) {
            return null;
        }
        const persistedReleasedAt = Temporal.Instant.fromEpochMilliseconds(
            Number(options.releasedAt.epochMilliseconds)
        );
        const computed: ResourceEntry = {
            ...expected,
            status: disposition.status,
            dequeueAudit: {
                ...expected.dequeueAudit,
                endTs: persistedReleasedAt,
                nextTs: disposition.delayMs !== null
                    ? persistedReleasedAt.add({ milliseconds: disposition.delayMs })
                    : undefined
            }
        };
        return await new PSqlResourceInboxEntryRepository(this.sql).replaceIfObserved(expected, computed);
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
