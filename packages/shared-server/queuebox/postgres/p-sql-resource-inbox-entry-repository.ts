import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import {
    hasMatchingImmutableResourceInboxContent,
    isValidResourceInboxLifecycle,
    ResourceInboxRow,
    rowsToMap,
    toDomain,
    toPgTimestamp,
    toSystemDate
} from './resource-inbox-row-codec.ts';

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

export class PSqlResourceInboxEntryRepository {
    static readonly MAX_ROWS_TO_RETURN = 50;

    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
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

        if (rows.length !== 1) {
            throw new Error('Insert failed: expected exactly one row');
        }
        return toDomain(rows[0]);
    }

    async writeIfAbsentOrMatch(
        entry: ResourceEntry
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
                'Resource inbox insert returned an unexpected row count'
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
                'Resource inbox immutable content or lifecycle differs'
            );
        }

        return 'matched';
    }

    async replacePendingIfMatch(
        expected: ResourceEntry,
        next: ResourceEntry,
        expectedGeneration: number
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
                'Resource inbox pending replacement identity or lifecycle differs'
            );
        }

        const rows = await this.sql<ResourceInboxRow[]>`
            update resource_inbox
            set ri_resource = ${next.resource},
                ri_status = ${next.status},
                next_ts = ${next.dequeueAudit.nextTs ? toPgTimestamp(next.dequeueAudit.nextTs) : null}
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
                'Resource inbox pending replacement returned an unexpected row count'
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
                'Resource inbox pending replacement returned different content'
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

        if (rows.length !== 1) {
            throw new Error('Replace failed: expected exactly one row');
        }
        return toDomain(rows[0]);
    }

    async writeIfAbsentOrReplaceExpired(entry: ResourceEntry): Promise<ResourceEntry> {
        const written = await this.tryWriteIfAbsentOrReplaceExpired(entry);
        if (written) {
            return written;
        }

        const existing = await this.findAnyByKey(entry.key);
        if (existing) {
            return existing;
        }

        throw new Error(
            'Write-if-absent failed: conflicting row was not returned and no active row exists'
        );
    }

    async writeMaterializedIfAbsentOrReplaceExpired(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry> {
        return await this.sql.begin(async (transactionSql) => {
            const transaction = new PSqlResourceInboxEntryRepository(transactionSql);
            const reserved = await transaction.tryWriteIfAbsentOrReplaceExpired(placeholder);
            if (!reserved) {
                const existing = await transaction.findAnyByKey(placeholder.key);
                if (existing) {
                    return existing;
                }
                throw new Error('Materialized write lost its conflicting resource inbox row');
            }

            const materialized = await materialize();
            if (!hasReservedIdentity(reserved, materialized)) {
                throw new ResourceInboxInvariantCorruptionError(
                    reserved.key,
                    'Materialized resource inbox identity differs from its reservation'
                );
            }
            return await transaction.replace({
                ...reserved,
                resource: materialized.resource
            });
        });
    }

    async tryWriteIfAbsentOrReplaceExpired(
        entry: ResourceEntry
    ): Promise<ResourceEntry | null> {
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

        return rows.length === 1 ? toDomain(rows[0]) : null;
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

    async findAllByTopicAndResourceId(
        topicId: string,
        resourceId: string
    ): Promise<readonly ResourceEntry[]> {
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_topic_id = ${topicId}
              and ri_resource_id = ${resourceId}
              and expire_ts > (now() at time zone 'UTC')
            order by ri_row_id
        `;
        return rows.map(toDomain);
    }

    async findAllKeys(): Promise<Key[]> {
        const now = new Date();
        const rows = await this.sql<Pick<ResourceInboxRow, 'ri_topic_id' | 'ri_resource_id' | 'fk_ext_bank_id'>[]>`
            select ri_topic_id, ri_resource_id, fk_ext_bank_id
            from resource_inbox
            where expire_ts > ${now}
            order by ri_row_id
        `;

        return rows.map((row) => ({
            topicId: row.ri_topic_id,
            resourceId: row.ri_resource_id,
            contextId: row.fk_ext_bank_id
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
            limit ${PSqlResourceInboxEntryRepository.MAX_ROWS_TO_RETURN}
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
            limit ${PSqlResourceInboxEntryRepository.MAX_ROWS_TO_RETURN}
        `;
        return rowsToMap(rows);
    }

    // ---------------------------------
    // SKIP LOCKED selectors (must be in tx)
    // ---------------------------------

    async isAnyWithStatuses(statuses: ReadonlySet<EntityStatus>): Promise<boolean> {
        if (statuses.size === 0) {
            return false;
        }

        const now = new Date();

        const rows = await this.sql<{ one: number; }[]>`
            select 1 as one
            from resource_inbox
            where ri_status in ${this.sql([...statuses])}
              and expire_ts > ${now}
            limit 1
        `;

        return rows.length > 0;
    }

    async isEntryWithStatus(key: Key, statuses: EntityStatus[]) {
        if (statuses.length === 0) {
            return false;
        }

        const now = new Date();

        const rows = await this.sql<{ one: number; }[]>`
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

        if (rows.length !== 1) {
            throw new Error('Upsert failed: expected exactly one row');
        }
        return toDomain(rows[0]);
    }

    // ---------------------------------
    // Deletes
    // ---------------------------------

    async deleteByKey(key: Key): Promise<boolean> {
        const rows = await this.sql<{ ri_row_id: bigint; }[]>`
            delete
            from resource_inbox
            where ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
            returning ri_row_id
        `;

        return rows.length === 1;
    }

}

function hasReservedIdentity(
    reserved: ResourceEntry,
    materialized: ResourceEntry
): boolean {
    return materialized.key.topicId === reserved.key.topicId &&
        materialized.key.resourceId === reserved.key.resourceId &&
        materialized.key.contextId === reserved.key.contextId &&
        materialized.typeId === reserved.typeId;
}
