import { Temporal } from '@js-temporal/polyfill';
import type { EntityStatus, Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type {
    PSqlSql,
    PSqlTransactionSql,
} from '@shared-server/postgres/PostgresSqlClient.ts';

export type AppInboxTestDatabase = PSqlSql;

export function createAppInboxTestDatabase(
    inbox: Readonly<{
        getItem(key: Key): Promise<ResourceEntry | undefined>;
        enqueue(entry: ResourceEntry): Promise<unknown>;
    }>,
    results: Readonly<{
        replace(entry: ResourceEntry): Promise<ResourceEntry>;
    }>,
): AppInboxTestDatabase {
    const database = (async () => {
        throw new Error('App inbox SQL must use the supplied transaction');
    }) as unknown as PSqlSql;
    database.begin = async <T>(
        write: (transaction: PSqlTransactionSql) => Promise<T>,
    ) => {
        const pendingResults: ResourceEntry[] = [];
        const pendingInbox: ResourceEntry[] = [];
        const transaction = (async (
            strings: TemplateStringsArray,
            ...values: unknown[]
        ) => {
            const query = strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
            if (query.includes('insert into resource_inbox_results')) {
                const entry = toResultEntry(values);
                pendingResults.push(entry);
                return [toResultRow(entry)];
            }
            if (
                query.includes('update resource_inbox') &&
                query.includes("ri_status = 'reserved'")
            ) {
                const [status, completedAt, topicId, resourceId, contextId, attempts] =
                    values as [EntityStatus, Date, string, string, string, number];
                const key = { topicId, resourceId, contextId };
                const current = await inbox.getItem(key);
                if (
                    !current ||
                    current.status !== 'RESERVED' ||
                    current.dequeueAudit.attempts !== attempts ||
                    Number(current.audit.expiryTs.epochMilliseconds) <= completedAt.getTime()
                ) return [];
                const entry: ResourceEntry = {
                    ...current,
                    status,
                    dequeueAudit: {
                        ...current.dequeueAudit,
                        endTs: Temporal.Instant.fromEpochMilliseconds(completedAt.getTime()),
                        nextTs: undefined,
                    },
                };
                pendingInbox.push(entry);
                return [toInboxRow(entry)];
            }
            throw new Error(`Unexpected app inbox transaction SQL: ${query}`);
        }) as unknown as PSqlTransactionSql;
        transaction.begin = async () => {
            throw new Error('Nested app inbox transaction');
        };

        const output = await write(transaction);
        for (const entry of pendingResults) await results.replace(entry);
        for (const entry of pendingInbox) await inbox.enqueue(entry);
        return output;
    };
    return database;
}

function toResultEntry(values: readonly unknown[]): ResourceEntry {
    const [resourceId, topicId, resource, typeId, status, contextId, systemDate,
        createdBy, createdTs, expiryTs] = values;
    return {
        key: {
            resourceId: resourceId as string,
            topicId: topicId as string,
            contextId: contextId as string,
        },
        resource: resource as string,
        typeId: typeId as string,
        status: status as EntityStatus,
        audit: {
            date: Temporal.PlainDate.from(systemDate as string).toPlainDateTime()
                .toPlainTime(),
            createdBy: createdBy as string,
            createdTs: Temporal.PlainDateTime.from(createdTs as string),
            expiryTs: String(expiryTs).endsWith('Z')
                ? Temporal.Instant.from(expiryTs as string)
                : Temporal.PlainDateTime.from(expiryTs as string).toZonedDateTime('UTC')
                    .toInstant(),
        },
        dequeueAudit: { attempts: 0 },
    };
}

function toResultRow(entry: ResourceEntry) {
    return {
        ris_row_id: 1n,
        ris_resource_id: entry.key.resourceId,
        ris_topic_id: entry.key.topicId,
        ris_resource: entry.resource,
        ris_type_id: entry.typeId,
        ris_status: entry.status,
        fk_ext_bank_id: entry.key.contextId,
        system_date: entry.audit.createdTs.toPlainDate().toString(),
        created_by: entry.audit.createdBy,
        created_ts: entry.audit.createdTs.toString(),
        expire_ts: entry.audit.expiryTs.toZonedDateTimeISO('UTC').toPlainDateTime().toString(),
    };
}

function toInboxRow(entry: ResourceEntry) {
    return {
        ri_row_id: 1n,
        ri_resource_id: entry.key.resourceId,
        ri_topic_id: entry.key.topicId,
        ri_resource: entry.resource,
        ri_type_id: entry.typeId,
        ri_status: entry.status,
        fk_ext_bank_id: entry.key.contextId,
        system_date: entry.audit.createdTs.toPlainDate().toString(),
        created_by: entry.audit.createdBy,
        created_ts: entry.audit.createdTs.toString(),
        expire_ts: entry.audit.expiryTs.toZonedDateTimeISO('UTC').toPlainDateTime().toString(),
        start_ts: entry.dequeueAudit.startTs?.toString() ?? null,
        end_ts: entry.dequeueAudit.endTs?.toString() ?? null,
        next_ts: entry.dequeueAudit.nextTs?.toString() ?? null,
        ri_attempts: BigInt(entry.dequeueAudit.attempts),
    };
}
