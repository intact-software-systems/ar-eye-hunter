import { hasSameResourceEntryValue } from '@shared/queuebox/has-same-resource-entry-value.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryReader } from './p-sql-resource-inbox-entry-reader.ts';
import { replaceObservedResourceInboxEntry } from './replace-observed-resource-inbox-entry.ts';
import {
    ResourceInboxRow,
    toDomain,
    toPgTimestamp,
    toSystemDate
} from './resource-inbox-row-codec.ts';
import { writeResourceInboxEntryIfAbsentOrMatch } from './write-resource-inbox-entry-if-absent-or-match.ts';

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
    private readonly sql: PSqlSql;
    private readonly reader: PSqlResourceInboxEntryReader;

    constructor(sql: PSqlSql) {
        this.sql = sql;
        this.reader = new PSqlResourceInboxEntryReader(sql);
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
        const result = await writeResourceInboxEntryIfAbsentOrMatch(this.sql, {
            entry,
            systemDate: toSystemDate(entry),
            createdTimestamp: toPgTimestamp(entry.audit.createdTs),
            expiryTimestamp: toPgTimestamp(entry.audit.expiryTs),
            startTimestamp: entry.dequeueAudit.startTs
                ? toPgTimestamp(entry.dequeueAudit.startTs)
                : null,
            endTimestamp: entry.dequeueAudit.endTs
                ? toPgTimestamp(entry.dequeueAudit.endTs)
                : null,
            nextTimestamp: entry.dequeueAudit.nextTs
                ? toPgTimestamp(entry.dequeueAudit.nextTs)
                : null,
            attempts: entry.dequeueAudit.attempts ?? 0
        });
        if (result.outcome === 'corruption') {
            throw new ResourceInboxInvariantCorruptionError(
                entry.key,
                result.message
            );
        }
        return result.outcome;
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

    async replaceIfObserved(
        expected: ResourceEntry,
        replacement: ResourceEntry
    ): Promise<ResourceEntry | null> {
        const expectedRowId = toExpectedRowId(expected);
        if (
            expected.key.topicId !== replacement.key.topicId ||
            expected.key.resourceId !== replacement.key.resourceId ||
            expected.key.contextId !== replacement.key.contextId
        ) {
            throw new ResourceInboxInvariantCorruptionError(
                replacement.key,
                'Resource inbox replacement key differs from its observation'
            );
        }

        const rows = await replaceObservedResourceInboxEntry({
            sql: this.sql,
            expected,
            replacement,
            expectedRowId
        });

        if (rows.length === 0) {
            return null;
        }
        if (rows.length !== 1) {
            throw new ResourceInboxInvariantCorruptionError(
                replacement.key,
                'Resource inbox compare-and-replace returned an unexpected row count'
            );
        }

        const updated = toDomain(rows[0]);
        if (!hasSameResourceEntryValue(updated, { ...replacement, db: updated.db })) {
            throw new ResourceInboxInvariantCorruptionError(
                replacement.key,
                'Resource inbox compare-and-replace returned different content'
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
        return await this.reader.findByKey(key);
    }

    async findAnyByKey(key: Key): Promise<ResourceEntry | null> {
        return await this.reader.findAnyByKey(key);
    }

    async findAllByTopicAndResourceId(
        topicId: string,
        resourceId: string
    ): Promise<readonly ResourceEntry[]> {
        return await this.reader.findAllByTopicAndResourceId(topicId, resourceId);
    }

    async findAllKeys(): Promise<Key[]> {
        return await this.reader.findAllKeys();
    }

    async findByTopicId(topicId: string): Promise<Map<string, ResourceEntry>> {
        return await this.reader.findByTopicId(topicId);
    }

    async findByTypeId(typeId: string): Promise<Map<string, ResourceEntry>> {
        return await this.reader.findByTypeId(typeId);
    }

    // ---------------------------------
    // SKIP LOCKED selectors (must be in tx)
    // ---------------------------------

    async isAnyWithStatuses(statuses: ReadonlySet<EntityStatus>): Promise<boolean> {
        return await this.reader.isAnyWithStatuses(statuses);
    }

    async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
        return await this.reader.isEntryWithStatus(key, statuses);
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

function toExpectedRowId(expected: ResourceEntry): bigint {
    const rowId = expected.db?.id;
    if (rowId === undefined || !/^[1-9]\d*$/u.test(rowId)) {
        throw new ResourceInboxInvariantCorruptionError(
            expected.key,
            'Resource inbox observation has no valid database row identity'
        );
    }
    return BigInt(rowId);
}
