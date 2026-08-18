import { Temporal } from '@js-temporal/polyfill';
import { Either } from '@shared/resilience/Either.ts';
import { EntityStatus, type Key, type ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import {
    type ResourceInboxReleaseDisposition,
    type ResourceInboxReservationInput,
    toResourceInboxReleaseDisposition,
    toResourceInboxReservationOptions,
} from '@shared/queuebox/QueueBoxTypes.ts';
import type { PSqlSql, PSqlTransactionSql } from '../PostgresSqlClient.ts';
import {
    ResourceInboxRow,
    rowsToMap,
    toDomain,
    toPgTimestamp,
    toSystemDate
} from './repository-utils.ts';
import { requeueObservedResourceInboxDeliveryFailure } from './resource-inbox-delivery-failure.ts';
export {
    initResourceInboxExpiryEviction,
    RESOURCE_INBOX_EXPIRY_EVICTION_INTERVAL_MS,
} from './ResourceInboxMaintenance.ts';

export type StartProcessingEntitySkipped = Readonly<{
    kind: 'expired-or-missing';
    key: Key;
}>;

export class ResourceInboxInvariantCorruptionError extends Error {
    readonly code = 'resource-inbox-invariant-corruption';
    readonly status = 409;

    readonly key: Key;

    constructor(key: Key, message: string) {
        super(`${message}: ${key.contextId}/${key.topicId}/${key.resourceId}`);
        this.key = key;
        this.name = 'ResourceInboxInvariantCorruptionError';
    }
}

export class ResourceInboxRepository {
    static readonly MAX_ROWS_TO_RETURN = 50;

    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    /**
     * Run repository operations inside a transaction.
     * Required for SELECT ... FOR UPDATE SKIP LOCKED to be meaningful.
     */
    async begin<T>(fn: (repo: ResourceInboxRepository) => Promise<T>): Promise<T> {
        const newVar = await this.sql.begin<T>(
            async (sql: PSqlTransactionSql) => {
                return await fn(new ResourceInboxRepository(sql));
            }
        );

        return newVar as T;
    }

    // ---------------------------------
    // Inserts / Reads
    // ---------------------------------

    async write(entry: ResourceEntry): Promise<ResourceEntry> {
        // ri_row_id uses DEFAULT nextval(...) so we don't supply it.
        const systemDate = toSystemDate(entry);

        const rows = await this.sql<ResourceInboxRow[]>`
            insert into resource_inbox (ri_resource_id,
                                        ri_topic_id,
                                        ri_resource,
                                        ri_type_id,
                                        ri_status,
                                        fk_ext_bank_id,
                                        system_date,
                                        created_by,
                                        created_ts,
                                        expire_ts,
                                        start_ts,
                                        end_ts,
                                        next_ts,
                                        ri_attempts)
            values (${entry.key.resourceId},
                    ${entry.key.topicId},
                    ${entry.resource},
                    ${entry.typeId},
                    ${entry.status},
                    ${entry.key.contextId},
                    ${systemDate},
                    ${entry.audit.createdBy},
                    ${toPgTimestamp(entry.audit.createdTs)},
                    ${toPgTimestamp(entry.audit.expiryTs)},
                    ${entry.dequeueAudit.startTs ? toPgTimestamp(entry.dequeueAudit.startTs) : null},
                    ${entry.dequeueAudit.endTs ? toPgTimestamp(entry.dequeueAudit.endTs) : null},
                    ${entry.dequeueAudit.nextTs ? toPgTimestamp(entry.dequeueAudit.nextTs) : null},
                    ${entry.dequeueAudit.attempts ?? 0})
            returning *
        `;

        if (rows.length !== 1) throw new Error('Insert failed: expected exactly one row');
        return toDomain(rows[0]);
    }

    async writeIfAbsentOrMatch(
        entry: ResourceEntry,
    ): Promise<'inserted' | 'matched'> {
        const systemDate = toSystemDate(entry);
        const inserted = await this.sql<ResourceInboxRow[]>`
            insert into resource_inbox (ri_resource_id,
                                        ri_topic_id,
                                        ri_resource,
                                        ri_type_id,
                                        ri_status,
                                        fk_ext_bank_id,
                                        system_date,
                                        created_by,
                                        created_ts,
                                        expire_ts,
                                        start_ts,
                                        end_ts,
                                        next_ts,
                                        ri_attempts)
            values (${entry.key.resourceId},
                    ${entry.key.topicId},
                    ${entry.resource},
                    ${entry.typeId},
                    ${entry.status},
                    ${entry.key.contextId},
                    ${systemDate},
                    ${entry.audit.createdBy},
                    ${toPgTimestamp(entry.audit.createdTs)},
                    ${toPgTimestamp(entry.audit.expiryTs)},
                    ${entry.dequeueAudit.startTs ? toPgTimestamp(entry.dequeueAudit.startTs) : null},
                    ${entry.dequeueAudit.endTs ? toPgTimestamp(entry.dequeueAudit.endTs) : null},
                    ${entry.dequeueAudit.nextTs ? toPgTimestamp(entry.dequeueAudit.nextTs) : null},
                    ${entry.dequeueAudit.attempts ?? 0})
            on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id)
                do nothing
            returning *
        `;

        if (inserted.length === 1) {
            return 'inserted';
        }
        if (inserted.length !== 0) {
            throw new ResourceInboxInvariantCorruptionError(
                entry.key,
                'Resource inbox insert returned an unexpected row count',
            );
        }

        const rows = await this.sql<ResourceInboxRow[]>`
            select ri_row_id,
                   ri_resource_id,
                   ri_topic_id,
                   ri_resource,
                   ri_type_id,
                   ri_status,
                   fk_ext_bank_id,
                   case
                       when extract(year from system_date) > 9999
                           then '+' || lpad(extract(year from system_date)::text, 6, '0') ||
                                to_char(system_date, '-MM-DD')
                       else to_char(system_date, 'YYYY-MM-DD')
                       end as system_date,
                   created_by,
                   case
                       when extract(year from created_ts) > 9999
                           then '+' || lpad(extract(year from created_ts)::text, 6, '0') ||
                                to_char(created_ts, '-MM-DD"T"HH24:MI:SS.US')
                       else to_char(created_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US')
                       end as created_ts,
                   case
                       when extract(year from expire_ts) > 9999
                           then '+' || lpad(extract(year from expire_ts)::text, 6, '0') ||
                                to_char(expire_ts, '-MM-DD"T"HH24:MI:SS.US')
                       else to_char(expire_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US')
                       end as expire_ts,
                   case
                       when extract(year from start_ts) > 9999
                           then '+' || lpad(extract(year from start_ts)::text, 6, '0') ||
                                to_char(start_ts, '-MM-DD"T"HH24:MI:SS.US')
                       else to_char(start_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US')
                       end as start_ts,
                   case
                       when extract(year from end_ts) > 9999
                           then '+' || lpad(extract(year from end_ts)::text, 6, '0') ||
                                to_char(end_ts, '-MM-DD"T"HH24:MI:SS.US')
                       else to_char(end_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US')
                       end as end_ts,
                   case
                       when extract(year from next_ts) > 9999
                           then '+' || lpad(extract(year from next_ts)::text, 6, '0') ||
                                to_char(next_ts, '-MM-DD"T"HH24:MI:SS.US')
                       else to_char(next_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US')
                       end as next_ts,
                   ri_attempts
            from resource_inbox
            where ri_topic_id = ${entry.key.topicId}
              and ri_resource_id = ${entry.key.resourceId}
              and fk_ext_bank_id = ${entry.key.contextId}
            limit 1
        `;
        const existing = rows[0];
        if (
            rows.length !== 1 ||
            !existing ||
            !isValidResourceInboxLifecycle(existing) ||
            !hasMatchingImmutableResourceInboxContent(existing, entry)
        ) {
            throw new ResourceInboxInvariantCorruptionError(
                entry.key,
                'Resource inbox immutable content or lifecycle differs',
            );
        }

        return 'matched';
    }

    async replacePendingIfMatch(
        expected: ResourceEntry,
        next: ResourceEntry,
        expectedGeneration: number,
    ): Promise<ResourceEntry | null> {
        if (
            expected.key.topicId !== next.key.topicId ||
            expected.key.resourceId !== next.key.resourceId ||
            expected.key.contextId !== next.key.contextId ||
            expected.typeId !== next.typeId ||
            !([EntityStatus.NEW, EntityStatus.RETRY] as readonly EntityStatus[])
                .includes(expected.status) ||
            !([EntityStatus.NEW, EntityStatus.RETRY] as readonly EntityStatus[])
                .includes(next.status) ||
            next.dequeueAudit.attempts !== expected.dequeueAudit.attempts ||
            !Number.isSafeInteger(expectedGeneration) ||
            expectedGeneration < 1
        ) {
            throw new ResourceInboxInvariantCorruptionError(
                next.key,
                'Resource inbox pending replacement identity or lifecycle differs',
            );
        }

        const rows = await this.sql<ResourceInboxRow[]>`
            update resource_inbox
            set ri_resource = ${next.resource},
                ri_status = ${next.status},
                next_ts = ${next.dequeueAudit.nextTs
                    ? toPgTimestamp(next.dequeueAudit.nextTs)
                    : null}
            where ri_topic_id = ${expected.key.topicId}
              and ri_resource_id = ${expected.key.resourceId}
              and fk_ext_bank_id = ${expected.key.contextId}
              and ri_type_id = ${expected.typeId}
              and ri_status = ${expected.status}
              and ri_resource = ${expected.resource}
              and (((ri_resource::jsonb #>> '{payload,resource}')::jsonb
                    #>> '{data,__rallarCoalescedWork,generation}')::bigint) =
                  ${expectedGeneration}
              and ri_attempts = ${expected.dequeueAudit.attempts}
            returning *
        `;

        if (rows.length === 0) {
            return null;
        }
        if (rows.length !== 1) {
            throw new ResourceInboxInvariantCorruptionError(
                next.key,
                'Resource inbox pending replacement returned an unexpected row count',
            );
        }

        const updated = toDomain(rows[0]);
        if (
            updated.resource !== next.resource ||
            updated.status !== next.status ||
            updated.typeId !== next.typeId
        ) {
            throw new ResourceInboxInvariantCorruptionError(
                next.key,
                'Resource inbox pending replacement returned different content',
            );
        }
        return updated;
    }

    async replace(entry: ResourceEntry): Promise<ResourceEntry> {
        const systemDate = toSystemDate(entry);

        const rows = await this.sql<ResourceInboxRow[]>`
            insert into resource_inbox (ri_resource_id,
                                        ri_topic_id,
                                        ri_resource,
                                        ri_type_id,
                                        ri_status,
                                        fk_ext_bank_id,
                                        system_date,
                                        created_by,
                                        created_ts,
                                        expire_ts,
                                        start_ts,
                                        end_ts,
                                        next_ts,
                                        ri_attempts)
            values (${entry.key.resourceId},
                    ${entry.key.topicId},
                    ${entry.resource},
                    ${entry.typeId},
                    ${entry.status},
                    ${entry.key.contextId},
                    ${systemDate},
                    ${entry.audit.createdBy},
                    ${toPgTimestamp(entry.audit.createdTs)},
                    ${toPgTimestamp(entry.audit.expiryTs)},
                    ${entry.dequeueAudit.startTs ? toPgTimestamp(entry.dequeueAudit.startTs) : null},
                    ${entry.dequeueAudit.endTs ? toPgTimestamp(entry.dequeueAudit.endTs) : null},
                    ${entry.dequeueAudit.nextTs ? toPgTimestamp(entry.dequeueAudit.nextTs) : null},
                    ${entry.dequeueAudit.attempts ?? 0})
            on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id)
                do update set ri_resource = excluded.ri_resource,
                              ri_type_id  = excluded.ri_type_id,
                              ri_status   = excluded.ri_status,
                              system_date = excluded.system_date,
                              created_by  = excluded.created_by,
                              created_ts  = excluded.created_ts,
                              expire_ts   = excluded.expire_ts,
                              start_ts    = excluded.start_ts,
                              end_ts      = excluded.end_ts,
                              next_ts     = excluded.next_ts,
                              ri_attempts = excluded.ri_attempts
            returning *
        `;

        if (rows.length !== 1) throw new Error('Replace failed: expected exactly one row');
        return toDomain(rows[0]);
    }

    async writeIfAbsentOrReplaceExpired(entry: ResourceEntry): Promise<ResourceEntry> {
        const systemDate = toSystemDate(entry);

        const rows = await this.sql<ResourceInboxRow[]>`
            insert into resource_inbox (ri_resource_id,
                                        ri_topic_id,
                                        ri_resource,
                                        ri_type_id,
                                        ri_status,
                                        fk_ext_bank_id,
                                        system_date,
                                        created_by,
                                        created_ts,
                                        expire_ts,
                                        start_ts,
                                        end_ts,
                                        next_ts,
                                        ri_attempts)
            values (${entry.key.resourceId},
                    ${entry.key.topicId},
                    ${entry.resource},
                    ${entry.typeId},
                    ${entry.status},
                    ${entry.key.contextId},
                    ${systemDate},
                    ${entry.audit.createdBy},
                    ${toPgTimestamp(entry.audit.createdTs)},
                    ${toPgTimestamp(entry.audit.expiryTs)},
                    ${entry.dequeueAudit.startTs ? toPgTimestamp(entry.dequeueAudit.startTs) : null},
                    ${entry.dequeueAudit.endTs ? toPgTimestamp(entry.dequeueAudit.endTs) : null},
                    ${entry.dequeueAudit.nextTs ? toPgTimestamp(entry.dequeueAudit.nextTs) : null},
                    ${entry.dequeueAudit.attempts ?? 0})
            on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id)
                do update set ri_resource = excluded.ri_resource,
                              ri_type_id  = excluded.ri_type_id,
                              ri_status   = excluded.ri_status,
                              system_date = excluded.system_date,
                              created_by  = excluded.created_by,
                              created_ts  = excluded.created_ts,
                              expire_ts   = excluded.expire_ts,
                              start_ts    = excluded.start_ts,
                              end_ts      = excluded.end_ts,
                              next_ts     = excluded.next_ts,
                              ri_attempts = excluded.ri_attempts
            where resource_inbox.expire_ts <= (now() at time zone 'UTC')
            returning *
        `;

        if (rows.length === 1) {
            return toDomain(rows[0]);
        }

        const existing = await this.findAnyByKey(entry.key);
        if (existing) {
            return existing;
        }

        throw new Error('Write-if-absent failed: conflicting row was not returned and no active row exists');
    }

    async findByKey(key: Key): Promise<ResourceEntry | null> {
        const now = new Date();
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
              and expire_ts > ${now}
            limit 1
        `;

        return rows.length === 0 ? null : toDomain(rows[0]);
    }

    async findAnyByKey(key: Key): Promise<ResourceEntry | null> {
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
            limit 1
        `;

        return rows.length === 0 ? null : toDomain(rows[0]);
    }

    async findAllKeys(): Promise<Key[]> {
        const now = new Date();
        const rows = await this.sql<Pick<ResourceInboxRow, 'ri_topic_id' | 'ri_resource_id' | 'fk_ext_bank_id'>[]>`
            select ri_topic_id, ri_resource_id, fk_ext_bank_id
            from resource_inbox
            where expire_ts > ${now}
            order by ri_row_id
        `;

        return rows.map(row => ({
            topicId: row.ri_topic_id,
            resourceId: row.ri_resource_id,
            contextId: row.fk_ext_bank_id,
        }));
    }

    async findByTopicId(topicId: string): Promise<Map<string, ResourceEntry>> {
        const now = new Date();
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_topic_id = ${topicId}
              and expire_ts > ${now}
            order by ri_row_id
            limit ${ResourceInboxRepository.MAX_ROWS_TO_RETURN}
        `;
        return rowsToMap(rows);
    }

    async findByTypeId(typeId: string): Promise<Map<string, ResourceEntry>> {
        const now = new Date();
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id = ${typeId}
              and expire_ts > ${now}
            order by ri_row_id
            limit ${ResourceInboxRepository.MAX_ROWS_TO_RETURN}
        `;
        return rowsToMap(rows);
    }

    // ---------------------------------
    // SKIP LOCKED selectors (must be in tx)
    // ---------------------------------

    async findEntriesSkipLocked(
        typeIds: ReadonlySet<string>,
        statusIds: ReadonlySet<EntityStatus>,
        reservationInput: ResourceInboxReservationInput,
    ): Promise<Map<string, ResourceEntry>> {
        if (typeIds.size === 0 || statusIds.size === 0) {
            return new Map();
        }

        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
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
        reservationInput: ResourceInboxReservationInput,
    ): Promise<Map<string, ResourceEntry>> {
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
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
    ): Promise<Map<string, ResourceEntry>> {
        if (!Number.isSafeInteger(timeSinceStartMs) || timeSinceStartMs < 0) {
            throw new Error('Reserved-entry timeout must be a non-negative safe integer in milliseconds');
        }
        if (typeIds.size === 0) {
            return new Map();
        }

        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
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

    async findRetryExhaustionFinalizationsSkipLocked(
        typeIds: ReadonlySet<string>,
        staleAfterMs: number,
        options: Readonly<{ processingAttempts: number; maxToReserve: number }>,
    ): Promise<Map<string, ResourceEntry>> {
        if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) {
            throw new Error('Finalization stale duration must be a non-negative safe integer');
        }
        if (!Number.isSafeInteger(options.processingAttempts) || options.processingAttempts < 1) {
            throw new Error('Finalization processing attempts must be a positive safe integer');
        }
        if (!Number.isSafeInteger(options.maxToReserve) || options.maxToReserve < 0) {
            throw new Error('Finalization reservation limit must be a non-negative safe integer');
        }
        if (!typeIds.has(EnqueuedType.APP_INBOX) || options.maxToReserve === 0) return new Map();
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id = ${EnqueuedType.APP_INBOX}
              and ri_status = ${EntityStatus.RESERVED}
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts >= ${options.processingAttempts}
              and ri_attempts < ${Number.MAX_SAFE_INTEGER}
              and start_ts is not null
              and start_ts <= (now() - (${staleAfterMs} * interval '1 millisecond')) at time zone 'UTC'
            order by start_ts asc, ri_row_id asc
                for update skip locked
            limit ${options.maxToReserve}
        `;
        return rowsToMap(rows);
    }

    // ---------------------------------
    // Existence checks
    // ---------------------------------

    async isEntriesToLock(
        typeIds: ReadonlySet<string>,
        statusIds: ReadonlySet<EntityStatus>,
        maxAttempts: number = DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
    ): Promise<boolean> {
        if (typeIds.size === 0 || statusIds.size === 0) {
            return false;
        }

        if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
            throw new Error('maxAttempts must be a positive safe integer');
        }

        const rows = await this.sql<{ one: number }[]>`
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

    async isAnyWithStatuses(statuses: ReadonlySet<EntityStatus>): Promise<boolean> {
        if (statuses.size === 0) {
            return false;
        }

        const now = new Date();

        const rows = await this.sql<{ one: number }[]>`
            select 1 as one
            from resource_inbox
            where ri_status in ${this.sql([...statuses])}
              and expire_ts > ${now}
            limit 1
        `;

        return rows.length > 0;
    }

    async isTimeoutOnReservedEntries(
        typeIds: ReadonlySet<string>,
        timeSinceStartTs: Temporal.Duration,
        maxAttempts: number = DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
    ): Promise<boolean> {
        if (typeIds.size === 0) {
            return false;
        }

        const timeoutMs = timeSinceStartTs.total({ unit: 'milliseconds' });
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
            throw new Error('Reserved-entry timeout must be a non-negative safe integer in milliseconds');
        }
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
            throw new Error('maxAttempts must be a positive safe integer');
        }

        const rows =
            await this.sql<{ one: number }[]>
                `
                    select 1 as one
                    from resource_inbox
                    where ri_type_id in ${this.sql([...typeIds])}
                      and ri_status in ${this.sql([EntityStatus.RESERVED])}
                      and expire_ts > (now() at time zone 'UTC')
                      and ri_attempts < ${maxAttempts}
                      and start_ts is not null
                      and start_ts < (now() - (${timeoutMs} * interval '1 millisecond')) at time zone 'UTC'
                    limit 1
                `;

        return rows.length > 0;
    }

    async isRetryExhaustionFinalizationRequired(
        typeIds: ReadonlySet<string>,
        staleAfterMs: number,
        processingAttempts: number,
    ): Promise<boolean> {
        if (!typeIds.has(EnqueuedType.APP_INBOX)) return false;
        const rows = await this.sql<{ one: number }[]>`
            select 1 as one
            from resource_inbox
            where ri_type_id = ${EnqueuedType.APP_INBOX}
              and ri_status = ${EntityStatus.RESERVED}
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts >= ${processingAttempts}
              and ri_attempts < ${Number.MAX_SAFE_INTEGER}
              and start_ts is not null
              and start_ts <= (now() - (${staleAfterMs} * interval '1 millisecond')) at time zone 'UTC'
            limit 1
        `;
        return rows.length > 0;
    }

    async isEntryWithStatus(key: Key, statuses: EntityStatus[]) {
        if (statuses.length === 0) {
            return false;
        }

        const now = new Date();

        const rows = await this.sql<{ one: number }[]>`
            select 1 as one
            from resource_inbox
            where ri_status in ${this.sql(statuses)}
              and ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
              and expire_ts > ${now}
            limit 1
        `;

        return rows.length > 0;
    }

    // ---------------------------------
    // State transitions
    // ---------------------------------

    async startProcessingEntity(
        entry: ResourceEntry,
        maxAttempts: number = DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
    ): Promise<Either<StartProcessingEntitySkipped, ResourceEntry>> {
        const attempts = (entry.dequeueAudit.attempts ?? 0) + 1;

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
                key: entry.key,
            })
            : Either.ofRight<StartProcessingEntitySkipped, ResourceEntry>(toDomain(rows[0]));
    }

    async startFinalizationRecovery(
        entry: ResourceEntry,
        processingAttempts: number,
    ): Promise<Either<StartProcessingEntitySkipped, ResourceEntry>> {
        if (entry.dequeueAudit.attempts >= Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Resource inbox finalization reservation generation overflow');
        }
        const rows = await this.sql<ResourceInboxRow[]>`
            update resource_inbox
            set ri_attempts = ri_attempts + 1,
                start_ts = now() at time zone 'UTC',
                end_ts = null,
                next_ts = null
            where ri_topic_id = ${entry.key.topicId}
              and ri_resource_id = ${entry.key.resourceId}
              and fk_ext_bank_id = ${entry.key.contextId}
              and ri_type_id = ${EnqueuedType.APP_INBOX}
              and ri_status = ${EntityStatus.RESERVED}
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts = ${entry.dequeueAudit.attempts}
              and ri_attempts >= ${processingAttempts}
              and ri_attempts < ${Number.MAX_SAFE_INTEGER}
            returning *
        `;
        return rows.length === 0
            ? Either.ofLeft({ kind: 'expired-or-missing', key: entry.key })
            : Either.ofRight(toDomain(rows[0]));
    }

    async updateResourceEntry(
        key: Key,
        newStatus: EntityStatus,
        timeUntilNextAttemptMs: number | null,
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

        const rows = await this.sql<{ ri_row_id: bigint }[]>`
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
        }>,
    ): Promise<ResourceEntry | null> {
        const disposition = toResourceInboxReleaseDisposition(options.disposition);

        const persistedReleasedAt = Temporal.Instant.fromEpochMilliseconds(
            Number(options.releasedAt.epochMilliseconds),
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
                    : undefined,
            },
        };
    }

    async finishReserved(
        key: Key,
        expectedAttempts: number,
        status: typeof EntityStatus.COMPLETED | typeof EntityStatus.FAILED,
        completedAt: Date,
    ): Promise<boolean> {
        if (
            status !== EntityStatus.COMPLETED &&
            status !== EntityStatus.FAILED
        ) {
            throw new Error(
                'Resource inbox reservation finish status must be COMPLETED or FAILED',
            );
        }

        const rows = await this.sql<{ ri_row_id: bigint }[]>`
            update resource_inbox
            set ri_status = ${status}, end_ts = ${completedAt}, next_ts = null
            where ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
              and ri_status = 'RESERVED'
              and ri_attempts = ${expectedAttempts}
              and expire_ts > (now() at time zone 'UTC')
            returning ri_row_id
        `;

        return rows.length === 1;
    }

    async requeueObservedDeliveryFailure(
        observed: ResourceEntry,
        disposition: ResourceInboxReleaseDisposition,
    ): Promise<ResourceEntry | null> {
        return await requeueObservedResourceInboxDeliveryFailure(this.sql, observed, disposition);
    }

    async upsert(entry: ResourceEntry): Promise<ResourceEntry> {
        const systemDate = toSystemDate(entry);

        const rows = await this.sql<ResourceInboxRow[]>`
            insert into resource_inbox (ri_resource_id,
                                        ri_topic_id,
                                        ri_resource,
                                        ri_type_id,
                                        ri_status,
                                        fk_ext_bank_id,
                                        system_date,
                                        created_by,
                                        created_ts,
                                        expire_ts,
                                        start_ts,
                                        end_ts,
                                        next_ts,
                                        ri_attempts)
            values (${entry.key.resourceId},
                    ${entry.key.topicId},
                    ${entry.resource},
                    ${entry.typeId},
                    ${entry.status},
                    ${entry.key.contextId},
                    ${systemDate},
                    ${entry.audit.createdBy},
                    ${toPgTimestamp(entry.audit.createdTs)},
                    ${toPgTimestamp(entry.audit.expiryTs)},
                    ${entry.dequeueAudit.startTs ? toPgTimestamp(entry.dequeueAudit.startTs) : null},
                    ${entry.dequeueAudit.endTs ? toPgTimestamp(entry.dequeueAudit.endTs) : null},
                    ${entry.dequeueAudit.nextTs ? toPgTimestamp(entry.dequeueAudit.nextTs) : null},
                    ${entry.dequeueAudit.attempts ?? 0})
            on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id)
                do update set ri_resource = excluded.ri_resource,
                              ri_type_id  = excluded.ri_type_id,
                              ri_status   = excluded.ri_status,
                              start_ts    = excluded.start_ts,
                              end_ts      = excluded.end_ts,
                              next_ts     = excluded.next_ts,
                              ri_attempts = excluded.ri_attempts
            returning *
        `;

        if (rows.length !== 1) throw new Error('Upsert failed: expected exactly one row');
        return toDomain(rows[0]);
    }

    // ---------------------------------
    // Deletes
    // ---------------------------------

    async deleteByKey(key: Key): Promise<boolean> {
        const rows = await this.sql<{ ri_row_id: bigint }[]>`
            delete
            from resource_inbox
            where ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
            returning ri_row_id
        `;

        return rows.length === 1;
    }

    async deleteExpired(): Promise<number> {
        const rows = await this.sql<{ ri_row_id: bigint }[]>`
            delete
            from resource_inbox
            where expire_ts <= (now() at time zone 'UTC')
            returning ri_row_id
        `;

        return rows.length;
    }
}

const RESOURCE_INBOX_STATUSES = new Set<string>(Object.values(EntityStatus));

function isValidResourceInboxLifecycle(row: ResourceInboxRow): boolean {
    if (row.ri_attempts == null) {
        return false;
    }

    const attempts = Number(row.ri_attempts);
    if (
        !RESOURCE_INBOX_STATUSES.has(row.ri_status) ||
        !Number.isSafeInteger(attempts) ||
        attempts < 0
    ) {
        return false;
    }

    let createdTs: Temporal.PlainDateTime;
    let expiryTs: Temporal.PlainDateTime;
    let startTs: Temporal.PlainDateTime | null;
    let endTs: Temporal.PlainDateTime | null;
    let nextTs: Temporal.PlainDateTime | null;
    try {
        createdTs = parsePostgresTimestamp6(row.created_ts);
        expiryTs = parsePostgresTimestamp6(row.expire_ts);
        startTs = row.start_ts ? parsePostgresTimestamp6(row.start_ts) : null;
        endTs = row.end_ts ? parsePostgresTimestamp6(row.end_ts) : null;
        nextTs = row.next_ts ? parsePostgresTimestamp6(row.next_ts) : null;
    } catch {
        return false;
    }

    if (
        Temporal.PlainDateTime.compare(createdTs, expiryTs) >= 0 ||
        (startTs && Temporal.PlainDateTime.compare(startTs, createdTs) < 0) ||
        (endTs && (!startTs || Temporal.PlainDateTime.compare(endTs, startTs) < 0)) ||
        (nextTs && endTs && Temporal.PlainDateTime.compare(nextTs, endTs) < 0) ||
        (nextTs && !endTs && Temporal.PlainDateTime.compare(nextTs, createdTs) < 0)
    ) {
        return false;
    }

    switch (row.ri_status as EntityStatus) {
        case EntityStatus.NEW:
            return attempts === 0 && !startTs && !endTs && !nextTs;
        case EntityStatus.RETRY:
            return attempts === 0
                ? !startTs && !endTs && nextTs !== null
                : startTs !== null && endTs !== null && nextTs !== null;
        case EntityStatus.RESERVED:
            return attempts > 0 && startTs !== null && !endTs && !nextTs;
        case EntityStatus.FAILED:
            return attempts > 0 && startTs !== null && endTs !== null;
        case EntityStatus.COMPLETED:
        case EntityStatus.ABORTED:
        case EntityStatus.NON_RETRYABLE:
        case EntityStatus.PARTITIONED:
        case EntityStatus.MERGED:
            return attempts > 0 && startTs !== null && endTs !== null && !nextTs;
    }
}

function hasMatchingImmutableResourceInboxContent(
    row: ResourceInboxRow,
    entry: ResourceEntry,
): boolean {
    try {
        return row.ri_topic_id === entry.key.topicId &&
            row.ri_resource_id === entry.key.resourceId &&
            row.fk_ext_bank_id === entry.key.contextId &&
            row.ri_type_id === entry.typeId &&
            row.ri_resource === entry.resource &&
            row.created_by === entry.audit.createdBy &&
            isSamePostgresTimestamp6(row.created_ts, entry.audit.createdTs) &&
            isSamePostgresTimestamp6(row.expire_ts, entry.audit.expiryTs);
    } catch {
        return false;
    }
}

function isSamePostgresTimestamp6(
    persisted: string,
    candidate: Temporal.PlainDateTime | Temporal.Instant,
): boolean {
    return Temporal.PlainDateTime.compare(
        parsePostgresTimestamp6(persisted),
        toPostgresTimestamp6(candidate),
    ) === 0;
}

function parsePostgresTimestamp6(value: string): Temporal.PlainDateTime {
    if (/[zZ]$/u.test(value) || /[+-]\d{2}(?::?\d{2})?$/u.test(value)) {
        throw new RangeError('PostgreSQL timestamp without time zone contains a zone');
    }

    const timestamp = Temporal.PlainDateTime.from(value.replace(' ', 'T'));
    if (timestamp.nanosecond !== 0) {
        throw new RangeError('PostgreSQL timestamp(6) exceeds microsecond precision');
    }
    return timestamp;
}

function toPostgresTimestamp6(
    value: Temporal.PlainDateTime | Temporal.Instant,
): Temporal.PlainDateTime {
    const timestamp = value instanceof Temporal.Instant
        ? value.toZonedDateTimeISO('UTC').toPlainDateTime()
        : value;

    return timestamp.round({
        smallestUnit: 'microsecond',
        roundingMode: 'halfEven',
    });
}
