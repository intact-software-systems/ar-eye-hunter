import { Temporal } from '@js-temporal/polyfill';
import { Either } from '@shared/resilience/Either.ts';
import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';
import { EntityStatus, type Key, type ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql, PSqlTransactionSql } from '../PostgresSqlClient.ts';
import {
    ResourceInboxRow,
    rowsToMap,
    toDomain,
    toPgTimestamp,
    toSystemDate
} from '@shared-server/postgres/resource-inbox/repository-utils.ts';

export const RESOURCE_INBOX_EXPIRY_EVICTION_INTERVAL_MS = 15_000;

export type StartProcessingEntitySkipped = Readonly<{
    kind: 'expired-or-missing';
    key: Key;
}>;

export class ResourceInboxRepository {
    static readonly MAX_ROWS_TO_RETURN = 50;

    constructor(private readonly sql: PSqlSql) {
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
            where resource_inbox.expire_ts <= now()
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
        maxToReserve: number,
    ): Promise<Map<string, ResourceEntry>> {
        if (typeIds.size === 0 || statusIds.size === 0) {
            return new Map();
        }

        const now = new Date();

        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id in ${this.sql([...typeIds])}
              and ri_status in ${this.sql([...statusIds])}
              and expire_ts > ${now}
              and (start_ts is null or next_ts < ${now})
            order by ri_row_id
                for update skip locked
            limit ${maxToReserve}
        `;

        return rowsToMap(rows);
    }

    async findTimedOutReservedEntriesSkipLocked(
        typeIds: ReadonlySet<string>,
        timeSinceStartMs: number,
        maxToReserve: number,
    ): Promise<Map<string, ResourceEntry>> {
        if (typeIds.size === 0) {
            return new Map();
        }

        const timedOutBefore = new Date(Date.now() - timeSinceStartMs);
        const now = new Date();

        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id in ${this.sql([...typeIds])}
              and ri_status = ${EntityStatus.RESERVED}
              and expire_ts > ${now}
              and start_ts is not null
              and start_ts < ${timedOutBefore}
            order by ri_row_id
                for update skip locked
            limit ${maxToReserve}
        `;

        return rowsToMap(rows);
    }

    // ---------------------------------
    // Existence checks
    // ---------------------------------

    async isEntriesToLock(typeIds: ReadonlySet<string>, statusIds: ReadonlySet<EntityStatus>): Promise<boolean> {
        if (typeIds.size === 0 || statusIds.size === 0) {
            return false;
        }

        const now = new Date();

        const rows = await this.sql<{ one: number }[]>`
            select 1 as one
            from resource_inbox
            where ri_type_id in ${this.sql([...typeIds])}
              and ri_status in ${this.sql([...statusIds])}
              and expire_ts > ${now}
              and (start_ts is null or next_ts < ${now})
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

    async isTimeoutOnReservedEntries(typeIds: ReadonlySet<string>, timeSinceStartTs: Temporal.Duration): Promise<boolean> {
        if (typeIds.size === 0) {
            return false;
        }

        const now = new Date();
        const timeoutTs = new Date(now.getTime() - timeSinceStartTs.total('milliseconds'));


        const rows =
            await this.sql<{ one: number }[]>
                `
                    select 1 as one
                    from resource_inbox
                    where ri_type_id in ${this.sql([...typeIds])}
                      and ri_status in ${this.sql([EntityStatus.RESERVED])}
                      and expire_ts > ${now}
                      and start_ts is not null
                      and next_ts < ${timeoutTs}
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
    ): Promise<Either<StartProcessingEntitySkipped, ResourceEntry>> {
        const serverStart = new Date();
        const attempts = (entry.dequeueAudit.attempts ?? 0) + 1;

        const rows = await this.sql<ResourceInboxRow[]>`
            update resource_inbox
            set ri_status   = ${EntityStatus.RESERVED},
                ri_attempts = ${attempts},
                start_ts    = ${serverStart},
                end_ts      = ${null},
                next_ts     = ${null}
            where ri_topic_id = ${entry.key.topicId}
              and ri_resource_id = ${entry.key.resourceId}
              and fk_ext_bank_id = ${entry.key.contextId}
              and expire_ts > now()
            returning *
        `;

        return rows.length === 0
            ? Either.ofLeft<StartProcessingEntitySkipped, ResourceEntry>({
                kind: 'expired-or-missing',
                key: entry.key,
            })
            : Either.ofRight<StartProcessingEntitySkipped, ResourceEntry>(toDomain(rows[0]));
    }

    async updateResourceEntry(
        key: Key,
        newStatus: EntityStatus,
        timeUntilNextAttemptMs?: number | null,
    ): Promise<number> {
        const endTs = new Date();
        const nextTs = timeUntilNextAttemptMs != null ? new Date(Date.now() + timeUntilNextAttemptMs) : null;

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
            where expire_ts <= now()
            returning ri_row_id
        `;

        return rows.length;
    }
}

export async function initResourceInboxExpiryEviction(
    repository: Pick<ResourceInboxRepository, 'deleteExpired'>,
    intervalMs: number = RESOURCE_INBOX_EXPIRY_EVICTION_INTERVAL_MS,
): Promise<void> {
    await tryRunInIntervals(
        async () => {
            const removed = await repository.deleteExpired();
            if (removed > 0) {
                console.log(`Evicted expired resource_inbox rows: ${removed}`);
            }
        },
        intervalMs,
    );
}
