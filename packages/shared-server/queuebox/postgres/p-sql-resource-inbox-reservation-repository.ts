import { Temporal } from '@js-temporal/polyfill';
import {
    toResourceInboxReleaseDisposition,
    toResourceInboxReservationOptions,
    type ResourceInboxReleaseDisposition,
    type ResourceInboxReservationInput
} from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { requeueObservedResourceInboxDeliveryFailure } from './requeue-observed-resource-inbox-delivery-failure.ts';
import { rowsToMap, toDomain, type ResourceInboxRow } from './resource-inbox-row-codec.ts';

export type StartProcessingEntitySkipped = Readonly<{
    kind: 'expired-or-missing';
    key: Key;
}>;

export class PSqlResourceInboxReservationRepository {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async findEntriesSkipLocked(
        typeIds: ReadonlySet<string>,
        statusIds: ReadonlySet<EntityStatus>,
        reservationInput: ResourceInboxReservationInput
    ): Promise<Map<string, ResourceEntry>> {
        if (typeIds.size === 0 || statusIds.size === 0) {
            return new Map();
        }

        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );

        const rows = await this.sql<ResourceInboxRow[]>`
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
        reservationInput: ResourceInboxReservationInput
    ): Promise<Map<string, ResourceEntry>> {
        if (!Number.isSafeInteger(timeSinceStartMs) || timeSinceStartMs < 0) {
            throw new Error(
                'Reserved-entry timeout must be a non-negative safe integer in milliseconds'
            );
        }
        if (typeIds.size === 0) {
            return new Map();
        }

        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const rows = await this.sql<ResourceInboxRow[]>`
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

    async updateResourceEntry(
        key: Key,
        newStatus: EntityStatus,
        timeUntilNextAttemptMs: number | null
    ): Promise<number> {
        if (
            timeUntilNextAttemptMs !== null &&
            (!Number.isSafeInteger(timeUntilNextAttemptMs) || timeUntilNextAttemptMs < 0)
        ) {
            throw new Error('Resource inbox release delay must be a non-negative integer or null');
        }

        const endTs = new Date();
        const nextTs = timeUntilNextAttemptMs !== null
            ? new Date(endTs.getTime() + timeUntilNextAttemptMs)
            : null;

        const rows = await this.sql<{ ri_row_id: bigint; }[]>`
            update resource_inbox
            set ri_status = ${newStatus},
                end_ts    = ${endTs},
                next_ts   = ${nextTs}
            where ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
            returning ri_row_id
        `;

        return rows.length;
    }

    async releaseReserved(
        key: Key,
        options: Readonly<{
            expectedAttempts: number;
            releasedAt: Temporal.Instant;
            disposition: ResourceInboxReleaseDisposition;
        }>
    ): Promise<ResourceEntry | null> {
        const disposition = toResourceInboxReleaseDisposition(options.disposition);
        const persistedReleasedAt = Temporal.Instant.fromEpochMilliseconds(
            Number(options.releasedAt.epochMilliseconds)
        );
        const endTs = new Date(Number(persistedReleasedAt.epochMilliseconds));
        const nextTs = disposition.delayMs !== null
            ? new Date(endTs.getTime() + disposition.delayMs)
            : null;
        const rows = await this.sql<ResourceInboxRow[]>`
            update resource_inbox
            set ri_status = ${disposition.status},
                end_ts    = ${endTs},
                next_ts   = ${nextTs}
            where ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
              and ri_status = ${EntityStatus.RESERVED}
              and ri_attempts = ${options.expectedAttempts}
              and expire_ts > (now() at time zone 'UTC')
            returning *
        `;

        if (rows.length !== 1) {
            return null;
        }

        const released = toDomain(rows[0]);
        return {
            ...released,
            dequeueAudit: {
                ...released.dequeueAudit,
                endTs: persistedReleasedAt,
                nextTs: disposition.delayMs !== null
                    ? persistedReleasedAt.add({ milliseconds: disposition.delayMs })
                    : undefined
            }
        };
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
