import type {
    AppDataConditionalDeleteResult,
    AppDataConditionalInsertResult,
    AppDataConditionalRepositoryLike,
    AppDataConditionalWriteResult,
    AppDataEntry,
    AppDataEntryPageOptions,
    AppDataUpsertIfRevisionInput,
    AppDataUpsertInput
} from '../../app-data/AppDataRepository.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';

type AppDataRow = Readonly<{
    app_namespace: string;
    store_name: string;
    data_key: string;
    data_value: string;
    schema_version: number | string;
    expire_at_ts: string;
    updated_ts: string;
    revision: number | string;
}>;

export class PSqlAppDataRepository implements AppDataConditionalRepositoryLike {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async findEntry(
        namespace: string,
        storeName: string,
        key: string
    ): Promise<AppDataEntry | undefined> {
        const rows = await this.sql<AppDataRow[]>`
            select app_namespace,
                   store_name,
                   data_key,
                   data_value,
                   schema_version,
                   expire_at_ts,
                   updated_ts,
                   revision
            from app_data_store
            where app_namespace = ${namespace}
              and store_name = ${storeName}
              and data_key = ${key}
            limit 1
        `;

        return rows[0] ? toEntry(rows[0]) : undefined;
    }

    async findEntries(
        namespace: string,
        storeName: string,
        keyPrefix?: string
    ): Promise<readonly AppDataEntry[]> {
        const rows = keyPrefix
            ? await this.sql<AppDataRow[]>`
                select app_namespace,
                       store_name,
                       data_key,
                       data_value,
                       schema_version,
                       expire_at_ts,
                       updated_ts,
                       revision
                from app_data_store
                where app_namespace = ${namespace}
                  and store_name = ${storeName}
                  and data_key like ${`${keyPrefix}%`}
                order by data_key
            `
            : await this.sql<AppDataRow[]>`
                select app_namespace,
                       store_name,
                       data_key,
                       data_value,
                       schema_version,
                       expire_at_ts,
                       updated_ts,
                       revision
                from app_data_store
                where app_namespace = ${namespace}
                  and store_name = ${storeName}
                order by data_key
            `;

        return rows.map(toEntry);
    }

    async findEntriesPage(
        namespace: string,
        storeName: string,
        options: AppDataEntryPageOptions
    ): Promise<readonly AppDataEntry[]> {
        const limit = Math.max(1, Math.floor(options.limit));
        const rows = await this.findEntryPageRows(namespace, storeName, options, limit);
        return rows.map(toEntry);
    }

    private async findEntryPageRows(
        namespace: string,
        storeName: string,
        options: AppDataEntryPageOptions,
        limit: number
    ): Promise<AppDataRow[]> {
        if (options.keyPrefix && options.afterKey !== undefined) {
            return await this.sql<AppDataRow[]>`
                select app_namespace,
                       store_name,
                       data_key,
                       data_value,
                       schema_version,
                       expire_at_ts,
                       updated_ts,
                       revision
                from app_data_store
                where app_namespace = ${namespace}
                  and store_name = ${storeName}
                  and data_key like ${`${options.keyPrefix}%`}
                  and data_key > ${options.afterKey}
                order by data_key
                limit ${limit}
            `;
        }

        if (options.keyPrefix) {
            return await this.sql<AppDataRow[]>`
                select app_namespace,
                       store_name,
                       data_key,
                       data_value,
                       schema_version,
                       expire_at_ts,
                       updated_ts,
                       revision
                from app_data_store
                where app_namespace = ${namespace}
                  and store_name = ${storeName}
                  and data_key like ${`${options.keyPrefix}%`}
                order by data_key
                limit ${limit}
            `;
        }

        if (options.afterKey !== undefined) {
            return await this.sql<AppDataRow[]>`
                select app_namespace,
                       store_name,
                       data_key,
                       data_value,
                       schema_version,
                       expire_at_ts,
                       updated_ts,
                       revision
                from app_data_store
                where app_namespace = ${namespace}
                  and store_name = ${storeName}
                  and data_key > ${options.afterKey}
                order by data_key
                limit ${limit}
            `;
        }

        return await this.sql<AppDataRow[]>`
            select app_namespace,
                   store_name,
                   data_key,
                   data_value,
                   schema_version,
                   expire_at_ts,
                   updated_ts,
                   revision
            from app_data_store
            where app_namespace = ${namespace}
              and store_name = ${storeName}
            order by data_key
            limit ${limit}
        `;
    }

    async upsert(input: AppDataUpsertInput): Promise<void> {
        await this.sql`
            insert into app_data_store (app_namespace,
                                        store_name,
                                        data_key,
                                        data_value,
                                        schema_version,
                                        expire_at_ts,
                                        updated_ts,
                                        revision)
            values (${input.namespace},
                    ${input.storeName},
                    ${input.key},
                    ${serializeAppDataValue(input.value)},
                    ${input.schemaVersion},
                    ${toPgDate(input.expireAtTimestamp)},
                    now(),
                    0)
            on conflict (app_namespace, store_name, data_key)
                do update set data_value     = excluded.data_value,
                              schema_version = excluded.schema_version,
                              expire_at_ts   = excluded.expire_at_ts,
                              updated_ts     = now(),
                              revision       = app_data_store.revision + 1
        `;
    }

    async insertIfAbsent<V = unknown>(
        input: AppDataUpsertInput<V>
    ): Promise<AppDataConditionalInsertResult<V>> {
        const rows = await this.sql<AppDataRow[]>`
            insert into app_data_store (app_namespace,
                                        store_name,
                                        data_key,
                                        data_value,
                                        schema_version,
                                        expire_at_ts,
                                        updated_ts,
                                        revision)
            values (${input.namespace},
                    ${input.storeName},
                    ${input.key},
                    ${serializeAppDataValue(input.value)},
                    ${input.schemaVersion},
                    ${toPgDate(input.expireAtTimestamp)},
                    now(),
                    0)
            on conflict (app_namespace, store_name, data_key)
                do nothing
            returning app_namespace,
                      store_name,
                      data_key,
                      data_value,
                      schema_version,
                      expire_at_ts,
                      updated_ts,
                      revision
        `;

        if (rows[0]) {
            return {
                status: 'inserted',
                entry: toEntry(rows[0]) as AppDataEntry<V>
            };
        }

        return {
            status: 'exists',
            current: await this.findEntry(
                input.namespace,
                input.storeName,
                input.key
            ) as AppDataEntry<V> | undefined
        };
    }

    async upsertIfRevision<V = unknown>(
        input: AppDataUpsertIfRevisionInput<V>
    ): Promise<AppDataConditionalWriteResult<V>> {
        const rows = await this.sql<AppDataRow[]>`
            update app_data_store
            set data_value     = ${serializeAppDataValue(input.value)},
                schema_version = ${input.schemaVersion},
                expire_at_ts   = ${toPgDate(input.expireAtTimestamp)},
                updated_ts     = now(),
                revision       = app_data_store.revision + 1
            where app_namespace = ${input.namespace}
              and store_name = ${input.storeName}
              and data_key = ${input.key}
              and revision = ${input.expectedRevision}
            returning app_namespace,
                      store_name,
                      data_key,
                      data_value,
                      schema_version,
                      expire_at_ts,
                      updated_ts,
                      revision
        `;

        if (rows[0]) {
            return {
                status: 'written',
                entry: toEntry(rows[0]) as AppDataEntry<V>
            };
        }

        return {
            status: 'conflict',
            current: await this.findEntry(
                input.namespace,
                input.storeName,
                input.key
            ) as AppDataEntry<V> | undefined
        };
    }

    async deleteByKey(namespace: string, storeName: string, key: string): Promise<boolean> {
        const rows = await this.sql<{ data_key: string; }[]>`
            delete
            from app_data_store
            where app_namespace = ${namespace}
              and store_name = ${storeName}
              and data_key = ${key}
            returning data_key
        `;

        return rows.length > 0;
    }

    async deleteIfRevision(
        namespace: string,
        storeName: string,
        key: string,
        expectedRevision: number
    ): Promise<AppDataConditionalDeleteResult> {
        const rows = await this.sql<AppDataRow[]>`
            delete
            from app_data_store
            where app_namespace = ${namespace}
              and store_name = ${storeName}
              and data_key = ${key}
              and revision = ${expectedRevision}
            returning app_namespace,
                      store_name,
                      data_key,
                      data_value,
                      schema_version,
                      expire_at_ts,
                      updated_ts,
                      revision
        `;

        if (rows[0]) {
            return {
                status: 'deleted',
                entry: toEntry(rows[0])
            };
        }

        return {
            status: 'conflict',
            current: await this.findEntry(namespace, storeName, key)
        };
    }

    async deleteExpired(namespace: string, storeName?: string): Promise<number> {
        const rows = storeName
            ? await this.sql<{ data_key: string; }[]>`
                delete
                from app_data_store
                where app_namespace = ${namespace}
                  and store_name = ${storeName}
                  and expire_at_ts <= now()
                returning data_key
            `
            : await this.sql<{ data_key: string; }[]>`
                delete
                from app_data_store
                where app_namespace = ${namespace}
                  and expire_at_ts <= now()
                returning data_key
            `;

        return rows.length;
    }
}

function toEntry(row: AppDataRow): AppDataEntry {
    const expireAtTimestamp = Date.parse(row.expire_at_ts);
    if (!Number.isFinite(expireAtTimestamp)) {
        throw new Error(
            `Invalid expire_at_ts for app_data_store row ${row.app_namespace}/${row.store_name}/${row.data_key}`
        );
    }

    return {
        namespace: row.app_namespace,
        storeName: row.store_name,
        key: row.data_key,
        value: JSON.parse(row.data_value) as unknown,
        schemaVersion: Number(row.schema_version),
        expireAtTimestamp,
        updatedTimestamp: row.updated_ts,
        revision: Number(row.revision)
    };
}

function toPgDate(timestamp: number): Date {
    if (!Number.isFinite(timestamp)) {
        throw new Error('expireAtTimestamp must be a finite number');
    }

    return new Date(timestamp);
}

function serializeAppDataValue(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new Error('App data values must be JSON serializable.');
    }

    return serialized;
}
