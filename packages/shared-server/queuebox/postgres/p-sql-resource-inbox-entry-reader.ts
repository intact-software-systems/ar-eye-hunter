import {
    toKeyAsString,
    type EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import {
    ResourceInboxRowCorruptionError,
    rowsToMap,
    toDomain,
    toResourceInboxStatusAndAttempts,
    type ResourceInboxRow,
    type ResourceInboxStatusAndAttempts
} from './resource-inbox-row-codec.ts';

const MAX_ROWS_TO_RETURN = 50;

/** One key's live row decoded, or the corruption that row holds. */
export type ResourceInboxStatusRead = Either<ResourceInboxRowCorruptionError, ResourceInboxStatusAndAttempts>;

/** One live row of a status batch, located by the 1-based position of its key in the batch. */
interface ResourceInboxStatusRow extends Pick<ResourceInboxRow, 'ri_status' | 'ri_attempts'> {
    readonly key_ordinal: number;
}

export class PSqlResourceInboxEntryReader {
    private readonly sql: PSqlSql;
    private readonly now: () => Date;

    constructor(sql: PSqlSql, now: () => Date) {
        this.sql = sql;
        this.now = now;
    }

    async findByKey(key: Key): Promise<ResourceEntry | null> {
        const now = this.now();
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

    /** The live row of each key, in key order: one statement however many keys. */
    async findByKeys(keys: readonly Key[]): Promise<readonly (ResourceEntry | undefined)[]> {
        const now = this.now();
        const requested = keys.map((key) => ({
            topicId: key.topicId,
            resourceId: key.resourceId,
            contextId: key.contextId
        }));
        const rows = await this.sql<ResourceInboxRow[]>`
            select resource_inbox.*
            from jsonb_to_recordset(${requested}::jsonb)
                as requested("topicId" text, "resourceId" text, "contextId" text)
            join resource_inbox
              on resource_inbox.ri_topic_id = requested."topicId"
             and resource_inbox.ri_resource_id = requested."resourceId"
             and resource_inbox.fk_ext_bank_id = requested."contextId"
            where resource_inbox.expire_ts > ${now}
        `;
        const found = new Map(rows.map((row) => {
            const entry = toDomain(row);
            return [toKeyAsString(entry.key), entry];
        }));
        return keys.map((key) => found.get(toKeyAsString(key)));
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
        const now = this.now();
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_topic_id = ${topicId}
              and ri_resource_id = ${resourceId}
              and expire_ts > ${now}
            order by ri_row_id
        `;
        return rows.map(toDomain);
    }

    async findAllKeys(): Promise<Key[]> {
        const now = this.now();
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
        const now = this.now();
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_topic_id = ${topicId}
              and expire_ts > ${now}
            order by ri_row_id
            limit ${MAX_ROWS_TO_RETURN}
        `;
        return rowsToMap(rows);
    }

    async findByTypeId(typeId: string): Promise<Map<string, ResourceEntry>> {
        const now = this.now();
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id = ${typeId}
              and expire_ts > ${now}
            order by ri_row_id
            limit ${MAX_ROWS_TO_RETURN}
        `;
        return rowsToMap(rows);
    }

    async isAnyWithStatuses(statuses: ReadonlySet<EntityStatus>): Promise<boolean> {
        if (statuses.size === 0) {
            return false;
        }

        const now = this.now();
        const rows = await this.sql<{ one: number; }[]>`
            select 1 as one
            from resource_inbox
            where ri_status in ${this.sql([...statuses])}
              and expire_ts > ${now}
            limit 1
        `;

        return rows.length > 0;
    }

    /**
     * The live status and attempts of each key, in key order, `undefined` without a live row: one statement on the
     * unique key however many keys, whose rows carry the key's position instead of the key. A corrupt row fails only
     * its own key.
     */
    async readStatusesAndAttempts(keys: readonly Key[]): Promise<readonly (ResourceInboxStatusRead | undefined)[]> {
        if (keys.length === 0) {
            return [];
        }
        const now = this.now();
        const rows = await this.sql<ResourceInboxStatusRow[]>`
            select requested.key_ordinal::int as key_ordinal, resource_inbox.ri_status, resource_inbox.ri_attempts
            from unnest(
                ${keys.map((key) => key.contextId)}::text[],
                ${keys.map((key) => key.resourceId)}::text[],
                ${keys.map((key) => key.topicId)}::text[]
            ) with ordinality as requested (context_id, resource_id, topic_id, key_ordinal)
            join resource_inbox
              on resource_inbox.fk_ext_bank_id = requested.context_id
             and resource_inbox.ri_resource_id = requested.resource_id
             and resource_inbox.ri_topic_id = requested.topic_id
            where resource_inbox.expire_ts > ${now}
        `;
        const reads: (ResourceInboxStatusRead | undefined)[] = keys.map(() => undefined);
        for (const row of rows) {
            reads[Number(row.key_ordinal) - 1] = toResourceInboxStatusRead(row);
        }
        return reads;
    }
}

function toResourceInboxStatusRead(row: ResourceInboxStatusRow): ResourceInboxStatusRead {
    try {
        return Either.ofRight(toResourceInboxStatusAndAttempts(row));
    }
    catch (error) {
        if (error instanceof ResourceInboxRowCorruptionError) {
            return Either.ofLeft(error);
        }
        throw error;
    }
}
