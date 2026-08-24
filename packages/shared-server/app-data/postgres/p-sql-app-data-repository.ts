import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { serializeCanonicalMutationCommand } from '../../rallar-system/protocol/json-wire-identity.ts';
import type {
    AppDataConditionalDeleteResult,
    AppDataConditionalInsertResult,
    AppDataConditionalWriteResult,
    AppDataDeleteExpiredInput,
    AppDataDeleteIfRevisionInput,
    AppDataEntry,
    AppDataEntryPageInput,
    AppDataKey,
    AppDataRepository,
    AppDataUpsertIfRevisionInput,
    AppDataUpsertInput
} from '../app-data-repository.ts';
import { decodePSqlAppDataRow } from './decode-p-sql-app-data-row.ts';
import type { PSqlAppDataRow } from './p-sql-app-data-row.ts';

export class PSqlAppDataRepository implements AppDataRepository {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async findEntry(input: AppDataKey): Promise<AppDataEntry | undefined> {
        const rows = await this.sql<PSqlAppDataRow[]>`
            select app_namespace,
                   store_name,
                   data_key,
                   data_value,
                   schema_version,
                   expire_at_ts,
                   updated_ts,
                   revision
            from app_data_store
            where app_namespace = ${input.namespace}
              and store_name = ${input.storeName}
              and data_key = ${input.key}
            limit 1
        `;

        return rows[0] ? decodePSqlAppDataRow(rows[0]) : undefined;
    }

    async findEntriesPage(input: AppDataEntryPageInput): Promise<readonly AppDataEntry[]> {
        const limit = Math.max(1, Math.floor(input.limit));
        const rows = await this.findEntryPageRows(input, limit);
        return rows.map(decodePSqlAppDataRow);
    }

    private async findEntryPageRows(
        input: AppDataEntryPageInput,
        limit: number
    ): Promise<PSqlAppDataRow[]> {
        if (input.keyPrefix && input.afterKey !== undefined) {
            return await this.sql<PSqlAppDataRow[]>`
                select app_namespace,
                       store_name,
                       data_key,
                       data_value,
                       schema_version,
                       expire_at_ts,
                       updated_ts,
                       revision
                from app_data_store
                where app_namespace = ${input.namespace}
                  and store_name = ${input.storeName}
                  and data_key like ${`${input.keyPrefix}%`}
                  and data_key > ${input.afterKey}
                order by data_key
                limit ${limit}
            `;
        }

        if (input.keyPrefix) {
            return await this.sql<PSqlAppDataRow[]>`
                select app_namespace,
                       store_name,
                       data_key,
                       data_value,
                       schema_version,
                       expire_at_ts,
                       updated_ts,
                       revision
                from app_data_store
                where app_namespace = ${input.namespace}
                  and store_name = ${input.storeName}
                  and data_key like ${`${input.keyPrefix}%`}
                order by data_key
                limit ${limit}
            `;
        }

        if (input.afterKey !== undefined) {
            return await this.sql<PSqlAppDataRow[]>`
                select app_namespace,
                       store_name,
                       data_key,
                       data_value,
                       schema_version,
                       expire_at_ts,
                       updated_ts,
                       revision
                from app_data_store
                where app_namespace = ${input.namespace}
                  and store_name = ${input.storeName}
                  and data_key > ${input.afterKey}
                order by data_key
                limit ${limit}
            `;
        }

        return await this.sql<PSqlAppDataRow[]>`
            select app_namespace,
                   store_name,
                   data_key,
                   data_value,
                   schema_version,
                   expire_at_ts,
                   updated_ts,
                   revision
            from app_data_store
            where app_namespace = ${input.namespace}
              and store_name = ${input.storeName}
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

    async insertIfAbsent(
        input: AppDataUpsertInput
    ): Promise<AppDataConditionalInsertResult> {
        const rows = await this.sql<PSqlAppDataRow[]>`
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
                entry: decodePSqlAppDataRow(rows[0])
            };
        }

        return {
            status: 'exists',
            current: await this.findEntry(input)
        };
    }

    async upsertIfRevision(
        input: AppDataUpsertIfRevisionInput
    ): Promise<AppDataConditionalWriteResult> {
        const rows = await this.sql<PSqlAppDataRow[]>`
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
                entry: decodePSqlAppDataRow(rows[0])
            };
        }

        return {
            status: 'conflict',
            current: await this.findEntry(input)
        };
    }

    async deleteByKey(input: AppDataKey): Promise<boolean> {
        const rows = await this.sql<{ data_key: string; }[]>`
            delete
            from app_data_store
            where app_namespace = ${input.namespace}
              and store_name = ${input.storeName}
              and data_key = ${input.key}
            returning data_key
        `;

        return rows.length > 0;
    }

    async deleteIfRevision(input: AppDataDeleteIfRevisionInput): Promise<AppDataConditionalDeleteResult> {
        const rows = await this.sql<PSqlAppDataRow[]>`
            delete
            from app_data_store
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
                status: 'deleted',
                entry: decodePSqlAppDataRow(rows[0])
            };
        }

        return {
            status: 'conflict',
            current: await this.findEntry(input)
        };
    }

    async deleteExpired(input: AppDataDeleteExpiredInput): Promise<number> {
        const expireAtOrBefore = toPgDate(input.expireAtOrBeforeTimestamp);
        const rows = input.storeName
            ? await this.sql<{ data_key: string; }[]>`
                delete
                from app_data_store
                where app_namespace = ${input.namespace}
                  and store_name = ${input.storeName}
                  and expire_at_ts <= ${expireAtOrBefore}
                returning data_key
            `
            : await this.sql<{ data_key: string; }[]>`
                delete
                from app_data_store
                where app_namespace = ${input.namespace}
                  and expire_at_ts <= ${expireAtOrBefore}
                returning data_key
            `;

        return rows.length;
    }
}

function toPgDate(timestamp: number): Date {
    if (!Number.isFinite(timestamp)) {
        throw new Error('expireAtTimestamp must be a finite number');
    }

    return new Date(timestamp);
}

function serializeAppDataValue(value: AppDataUpsertInput['value']): string {
    return serializeCanonicalMutationCommand(value);
}
