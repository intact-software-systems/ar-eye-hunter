import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import {
    PSqlResourceInboxEntryRepository,
    ResourceInboxInvariantCorruptionError
} from '../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import {
    hasSameResourceEntryContent,
    toPgTimestamp,
    toSystemDate
} from '../../queuebox/postgres/resource-inbox-row-codec.ts';

export interface AppOutboxInsert {
    readonly entry: Readonly<ResourceEntry>;
    readonly systemDate: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly nextAt: string | null;
    readonly attempts: number;
}

export function computeAppOutboxInsert(entry: ResourceEntry): AppOutboxInsert {
    const snapshot: Readonly<ResourceEntry> = {
        ...entry,
        key: { ...entry.key },
        audit: { ...entry.audit },
        dequeueAudit: { ...entry.dequeueAudit },
        ...(entry.db === undefined ? {} : { db: { ...entry.db } })
    };
    return {
        entry: snapshot,
        systemDate: toSystemDate(snapshot),
        createdAt: toPgTimestamp(snapshot.audit.createdTs),
        expiresAt: toPgTimestamp(snapshot.audit.expiryTs),
        startedAt: snapshot.dequeueAudit.startTs ? toPgTimestamp(snapshot.dequeueAudit.startTs) : null,
        finishedAt: snapshot.dequeueAudit.endTs ? toPgTimestamp(snapshot.dequeueAudit.endTs) : null,
        nextAt: snapshot.dequeueAudit.nextTs ? toPgTimestamp(snapshot.dequeueAudit.nextTs) : null,
        attempts: snapshot.dequeueAudit.attempts
    };
}

export function isExactAppOutboxInsert(
    entry: ResourceEntry,
    computed: AppOutboxInsert
): boolean {
    const expected = computeAppOutboxInsert(entry);
    return computed.entry.key.topicId === expected.entry.key.topicId &&
        computed.entry.key.resourceId === expected.entry.key.resourceId &&
        computed.entry.key.contextId === expected.entry.key.contextId &&
        computed.entry.resource === expected.entry.resource &&
        computed.entry.typeId === expected.entry.typeId &&
        computed.entry.status === expected.entry.status &&
        computed.entry.audit.createdBy === expected.entry.audit.createdBy &&
        computed.systemDate === expected.systemDate &&
        computed.createdAt === expected.createdAt &&
        computed.expiresAt === expected.expiresAt &&
        computed.startedAt === expected.startedAt &&
        computed.finishedAt === expected.finishedAt &&
        computed.nextAt === expected.nextAt &&
        computed.attempts === expected.attempts;
}

export async function writeAppOutboxInsert(transaction: PSqlSql, computed: AppOutboxInsert): Promise<void> {
    if (!await insertAppOutboxRow(transaction, computed)) {
        throwAppOutboxInsertConflict(computed);
    }
}

/** Inserts an idempotent coalesced write, accepting only an exact persisted winner. */
export async function writeAppOutboxInsertOrMatch(
    transaction: PSqlSql,
    computed: AppOutboxInsert
): Promise<'inserted' | 'matched'> {
    if (await insertAppOutboxRow(transaction, computed)) {
        return 'inserted';
    }
    const existing = await new PSqlResourceInboxEntryRepository(transaction)
        .findAnyByKey(computed.entry.key);
    if (existing && hasSameResourceEntryContent(existing, computed.entry)) {
        return 'matched';
    }
    throwAppOutboxInsertConflict(computed);
}

async function insertAppOutboxRow(transaction: PSqlSql, computed: AppOutboxInsert): Promise<boolean> {
    const entry = computed.entry;
    const inserted = await transaction<readonly { ri_row_id: bigint; }[]>`
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
                ${computed.systemDate},
                ${entry.audit.createdBy},
                ${computed.createdAt},
                ${computed.expiresAt},
                ${computed.startedAt},
                ${computed.finishedAt},
                ${computed.nextAt},
                ${computed.attempts})
        on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id) do nothing
        returning ri_row_id
    `;
    if (inserted.length > 1) {
        throwAppOutboxInsertConflict(computed);
    }
    return inserted.length === 1;
}

function throwAppOutboxInsertConflict(computed: AppOutboxInsert): never {
    throw new ResourceInboxInvariantCorruptionError(
        computed.entry.key,
        'App outbox insert did not create exactly one row'
    );
}
