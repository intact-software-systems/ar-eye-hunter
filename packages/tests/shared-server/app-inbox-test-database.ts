import { Temporal } from '@js-temporal/polyfill';
import type { EntityStatus, Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';

export type AppInboxTestDatabase = PSqlSql &
    Readonly<{
        clientEventStore: InMemoryClientStateEventStore;
        outboxEntries: ReadonlyMap<string, ResourceEntry>;
    }>;

type AppInboxTestDatabaseOptions = Readonly<{
    runtimeRepository?: RuntimeStateOptimisticTransactionalRepositoryLike;
    clientEventStore?: InMemoryClientStateEventStore;
    withTransaction?: <T>(write: () => Promise<T>) => Promise<T>;
    shouldFailOutboxWrite?: () => boolean;
    onTransactionRollback?: () => void | Promise<void>;
}>;

export function createAppInboxTestDatabase(
    inbox: Readonly<{
        getItem(key: Key): Promise<ResourceEntry | undefined>;
        enqueue(entry: ResourceEntry): Promise<unknown>;
    }>,
    results: Readonly<{
        replace(entry: ResourceEntry): Promise<ResourceEntry>;
    }>,
    options: AppInboxTestDatabaseOptions = {},
): AppInboxTestDatabase {
    const outboxEntries = new Map<string, ResourceEntry>();
    const clientEventStore = options.clientEventStore ?? new InMemoryClientStateEventStore();
    const database = (async () => {
        throw new Error('App inbox SQL must use the supplied transaction');
    }) as unknown as AppInboxTestDatabase;
    database.begin = async <T>(
        write: (transaction: PSqlTransactionSql) => Promise<T>) => {
        const run = async (
            runtime: RuntimeStateOptimisticTransactionalRepositoryLike | undefined,
        ): Promise<T> => {
            const pendingResults: ResourceEntry[] = [];
            const pendingInbox: ResourceEntry[] = [];
            const pendingOutbox = new Map(outboxEntries);
            const pendingClientEvents: ClientEvent[] = [];
            const transaction = (async (
            strings: TemplateStringsArray,
            ...values: unknown[]
        ) => {
            const query = strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
            if (
                query.includes('insert into runtime_state_store') &&
                query.includes('do nothing') &&
                query.includes('returning revision')
            ) {
                if (!runtime) {
                    throw new Error('Runtime-state SQL requires a transaction runtime');
                }
                const [namespace, key, value, expireAt] = values as [
                    string,
                    string,
                    string,
                    Date,
                ];
                const result = await runtime.insertIfAbsent(
                    namespace,
                    key,
                    value,
                    expireAt.getTime(),
                );
                return result.status === 'applied' ? [{ revision: result.revision }] : [];
            }
            if (
                query.includes('update runtime_state_store') &&
                query.includes('returning revision')
            ) {
                if (!runtime) {
                    throw new Error('Runtime-state SQL requires a transaction runtime');
                }
                const [value, expireAt, namespace, key, expectedRevision] = values as [
                    string,
                    Date,
                    string,
                    string,
                    number,
                ];
                const result = await runtime.upsertIfRevision(
                    namespace,
                    key,
                    value,
                    expireAt.getTime(),
                    expectedRevision,
                );
                return result.status === 'applied' ? [{ revision: result.revision }] : [];
            }
            if (query.includes('insert into client_state_events')) {
                const eventJson = values.at(-1);
                if (typeof eventJson !== 'string') {
                    throw new Error('Client state event JSON is required');
                }
                pendingClientEvents.push(JSON.parse(eventJson) as ClientEvent);
                return [];
            }
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
                if (
                    query.includes('insert into resource_inbox') &&
                    query.includes('on conflict') &&
                    query.includes('do nothing')
                ) {
                    const entry = toInboxEntry(values);
                    if (options.shouldFailOutboxWrite?.()) {
                        throw new ResourceInboxInvariantCorruptionError(
                            entry.key,
                            'Injected AppInbox outbox collision',
                        );
                    }
                    const key = toResourceKey(entry);
                    if (pendingOutbox.has(key)) return [];
                    pendingOutbox.set(key, entry);
                    return [toInboxRow(entry)];
                }
                if (query.includes('from resource_inbox') && query.includes('where ri_topic_id')) {
                    const [topicId, resourceId, contextId] = values as string[];
                    const entry = pendingOutbox.get(`${contextId}:${topicId}:${resourceId}`);
                    return entry ? [toInboxRow(entry)] : [];
                }
                throw new Error(`Unexpected app inbox transaction SQL: ${query}`);
        }) as unknown as PSqlTransactionSql;
        transaction.begin = async () => {
            throw new Error('Nested app inbox transaction');
            };
            const output = await write(transaction);
        for (const entry of pendingResults) await results.replace(entry);
        for (const entry of pendingInbox) await inbox.enqueue(entry);
            outboxEntries.clear();
            for (const [key, entry] of pendingOutbox) outboxEntries.set(key, entry);
            for (const event of pendingClientEvents) {
                await clientEventStore.appendClientEvent(event);
            }
            return output;
        };

        try {
            const execute = async (
                runtime: RuntimeStateOptimisticTransactionalRepositoryLike | undefined,
            ) =>
                options.withTransaction
                    ? await options.withTransaction(async () => await run(runtime))
                    : await run(runtime);
            return options.runtimeRepository
                ? await options.runtimeRepository.begin(execute)
                : await execute(undefined);
        } catch (error) {
            await options.onTransactionRollback?.();
            throw error;
        }
    };
    Object.defineProperties(database, {
        clientEventStore: { value: clientEventStore },
        outboxEntries: { value: outboxEntries },
    });
    return database;
}
function toInboxEntry(values: readonly unknown[]): ResourceEntry {
    const [
        resourceId,
        topicId,
        resource,
        typeId,
        status,
        contextId,
        systemDate,
        createdBy,
        createdTs,
        expiryTs,
        startTs,
        endTs,
        nextTs,
        attempts,
    ] = values;
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
            date: Temporal.PlainDate.from(systemDate as string)
                .toPlainDateTime()
                .toPlainTime(),
            createdBy: createdBy as string,
            createdTs: toPlainDateTime(createdTs),
            expiryTs: toInstant(expiryTs),
        },
        dequeueAudit: {
            startTs: startTs === null ? undefined : toInstant(startTs),
            endTs: endTs === null ? undefined : toInstant(endTs),
            nextTs: nextTs === null ? undefined : toInstant(nextTs),
            attempts: Number(attempts),
        },
    };
}

function toPlainDateTime(value: unknown): Temporal.PlainDateTime {
    return Temporal.PlainDateTime.from(String(value).replace(/Z$/u, ''));
}

function toInstant(value: unknown): Temporal.Instant {
    const text = String(value);
    return Temporal.Instant.from(text.endsWith('Z') ? text : `${text}Z`);
}

function toResourceKey(entry: ResourceEntry): string {
    return `${entry.key.contextId}:${entry.key.topicId}:${entry.key.resourceId}`;
}

function toResultEntry(values: readonly unknown[]): ResourceEntry {
    const [resourceId, topicId, resource, typeId, status, contextId, systemDate,
        createdBy,
        createdTs,
        expiryTs,
    ] = values;
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
