import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { PSqlFragment } from '../../postgres/p-sql-fragment.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import {
    toResourceInboxEntryInsert,
    type ResourceInboxEntryInsertRow
} from '../../queuebox/postgres/resource-inbox-entry-insert-values.ts';
import { toPgTimestamp, toSystemDate } from '../../queuebox/postgres/resource-inbox-row-codec.ts';
import { REPLACE_EXPIRED_RESOURCE_INBOX_ROW } from '../../queuebox/postgres/write-resource-inbox-entry-if-absent-or-expired.ts';
import {
    computeAppOutboxTrackIndexRow,
    isOrderedWsOutboxEntry,
    toAppOutboxTrackIndexInsert,
    type AppOutboxTrackIndexRow
} from './app-outbox-track-index.ts';

export interface AppOutboxInsert {
    readonly entry: Readonly<ResourceEntry>;
    readonly systemDate: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly nextAt: string | null;
    readonly attempts: number;
    readonly trackIndex: AppOutboxTrackIndexRow | null;
}

export interface ComputeOrderedWsOutboxInsertInput {
    readonly entry: ResourceEntry;
    readonly admissionNamespace: string;
}

interface AppOutboxInsertedRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly fk_ext_bank_id: string;
}

interface AppOutboxTrackIndexedRow {
    readonly ri_resource_id: string | null;
    readonly ri_topic_id: string | null;
    readonly fk_ext_bank_id: string | null;
    readonly store_key: string | null;
}

export function computeAppOutboxInsert(entry: ResourceEntry): AppOutboxInsert {
    return { ...computeAppOutboxRow(entry), trackIndex: null };
}

export function computeOrderedWsOutboxInsert(input: ComputeOrderedWsOutboxInsertInput): AppOutboxInsert {
    const row = computeAppOutboxRow(input.entry);
    return {
        ...row,
        trackIndex: computeAppOutboxTrackIndexRow({
            entry: input.entry,
            admissionNamespace: input.admissionNamespace,
            expiresAt: row.expiresAt
        })
    };
}

function computeAppOutboxRow(entry: ResourceEntry): Omit<AppOutboxInsert, 'trackIndex'> {
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
    if (computed.trackIndex !== null && !isOrderedWsOutboxEntry(entry)) {
        return false;
    }
    const expected = computed.trackIndex === null
        ? computeAppOutboxInsert(entry)
        : computeOrderedWsOutboxInsert({ entry, admissionNamespace: computed.trackIndex.namespace });
    return isSameAppOutboxRow(computed, expected) && isSameTrackIndexRow(computed.trackIndex, expected.trackIndex);
}

function isSameAppOutboxRow(computed: AppOutboxInsert, expected: AppOutboxInsert): boolean {
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

function isSameTrackIndexRow(
    computed: AppOutboxTrackIndexRow | null,
    expected: AppOutboxTrackIndexRow | null
): boolean {
    if (computed === null || expected === null) {
        return computed === expected;
    }
    return computed.namespace === expected.namespace && computed.key === expected.key &&
        computed.msgId === expected.msgId && computed.expiresAt === expected.expiresAt;
}

export async function writeAppOutboxInsert(transaction: PSqlSql, computed: AppOutboxInsert): Promise<void> {
    await writeAppOutboxInserts(transaction, [computed]);
}

/**
 * Every row in one statement and in the given order, with the track index rows of ordered WS rows in the same
 * statement; each must come back, since a live row already under its key is the corruption the insert reports and
 * the transaction rolls back. An expired row is taken for absent and written over.
 */
export async function writeAppOutboxInserts(
    transaction: PSqlSql,
    computed: readonly AppOutboxInsert[]
): Promise<void> {
    if (computed.length === 0) {
        return;
    }
    const trackIndexes = computed.flatMap(({ trackIndex }) => trackIndex === null ? [] : [trackIndex]);
    if (trackIndexes.length === 0) {
        requireAppOutboxRowsInserted(computed, await insertAppOutboxRows(transaction, computed));
        return;
    }
    requireDistinctTrackIndexKeys(computed);
    const written = await insertTrackIndexedAppOutboxRows(transaction, computed, trackIndexes);
    requireAppOutboxRowsInserted(computed, written.filter(({ store_key }) => store_key === null));
    const missing = computed.find(({ trackIndex }) =>
        trackIndex !== null && !written.some(({ store_key }) => store_key === trackIndex.key)
    );
    if (missing !== undefined) {
        throw new ResourceInboxInvariantCorruptionError(
            missing.entry.key,
            'App outbox track index did not create exactly one row'
        );
    }
}

function requireDistinctTrackIndexKeys(computed: readonly AppOutboxInsert[]): void {
    const keys = new Set<string>();
    for (const { entry, trackIndex } of computed) {
        if (trackIndex === null) {
            continue;
        }
        if (keys.has(trackIndex.key)) {
            throw new ResourceInboxInvariantCorruptionError(
                entry.key,
                'App outbox batch names one track index row twice'
            );
        }
        keys.add(trackIndex.key);
    }
}

function requireAppOutboxRowsInserted(
    computed: readonly AppOutboxInsert[],
    inserted: readonly Omit<AppOutboxTrackIndexedRow, 'store_key'>[]
): void {
    if (inserted.length !== computed.length) {
        const missing = computed.find(({ entry: { key } }) =>
            !inserted.some((row) =>
                row.ri_resource_id === key.resourceId && row.ri_topic_id === key.topicId &&
                row.fk_ext_bank_id === key.contextId
            )
        );
        throw new ResourceInboxInvariantCorruptionError(
            (missing ?? computed[0]).entry.key,
            'App outbox insert did not create exactly one row'
        );
    }
}

/** Whether the row was written; a live row already stored under its key is left as it is, an expired one written over. */
export async function writeAppOutboxInsertIfAbsent(transaction: PSqlSql, computed: AppOutboxInsert): Promise<boolean> {
    return (await insertAppOutboxRows(transaction, [computed])).length === 1;
}

async function insertAppOutboxRows(
    transaction: PSqlSql,
    computed: readonly AppOutboxInsert[]
): Promise<readonly AppOutboxInsertedRow[]> {
    const statement = PSqlFragment.of`${toResourceInboxEntryInsert(computed.map(toAppOutboxInsertRow))}
        ${REPLACE_EXPIRED_RESOURCE_INBOX_ROW}
        returning ri_row_id, ri_resource_id, ri_topic_id, fk_ext_bank_id
    `;
    return await transaction<readonly AppOutboxInsertedRow[]>(...statement.toStatement());
}

async function insertTrackIndexedAppOutboxRows(
    transaction: PSqlSql,
    computed: readonly AppOutboxInsert[],
    trackIndexes: readonly AppOutboxTrackIndexRow[]
): Promise<readonly AppOutboxTrackIndexedRow[]> {
    const statement = PSqlFragment.of`with outbox as (
            ${toResourceInboxEntryInsert(computed.map(toAppOutboxInsertRow))}
            ${REPLACE_EXPIRED_RESOURCE_INBOX_ROW}
            returning ri_resource_id, ri_topic_id, fk_ext_bank_id
        ), track_index as (${toAppOutboxTrackIndexInsert(trackIndexes)})
        select ri_resource_id, ri_topic_id, fk_ext_bank_id, null::text as store_key from outbox
        union all
        select null, null, null, store_key from track_index
    `;
    return await transaction<readonly AppOutboxTrackIndexedRow[]>(...statement.toStatement());
}

function toAppOutboxInsertRow(computed: AppOutboxInsert): ResourceInboxEntryInsertRow {
    const { entry } = computed;
    return {
        resourceId: entry.key.resourceId,
        topicId: entry.key.topicId,
        contextId: entry.key.contextId,
        resource: entry.resource,
        typeId: entry.typeId,
        status: entry.status,
        systemDate: computed.systemDate,
        createdBy: entry.audit.createdBy,
        createdAt: computed.createdAt,
        expiresAt: computed.expiresAt,
        startedAt: computed.startedAt,
        finishedAt: computed.finishedAt,
        nextAt: computed.nextAt,
        attempts: computed.attempts
    };
}
