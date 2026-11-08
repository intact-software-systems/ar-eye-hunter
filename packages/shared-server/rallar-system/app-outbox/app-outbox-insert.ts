import { EnqueuedType } from '@shared/api/api-config.ts';
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
import { validateComputedProjection, type ComputedDataValidationIssue } from '../computed-data-validation.ts';
import {
    computeWsOutboxProvenanceRecord,
    type WsOutboxProvenanceFacts
} from '../websocket/outbox/ws-outbox-provenance.ts';
import { toAppOutboxSidecarInsert, type AppOutboxSidecarRow } from './app-outbox-sidecar.ts';
import { computeAppOutboxTrackIndexRow, isOrderedWsOutboxEntry } from './app-outbox-track-index.ts';

export interface AppOutboxInsert {
    readonly entry: Readonly<ResourceEntry>;
    readonly systemDate: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly nextAt: string | null;
    readonly attempts: number;
    readonly trackIndex: AppOutboxSidecarRow | null;
    readonly provenance: AppOutboxSidecarRow | null;
}

export interface ComputeWsOutboxInsertInput {
    readonly entry: ResourceEntry;
    /** `null` when the producer admits no ordered row. */
    readonly admissionNamespace: string | null;
    readonly provenance: WsOutboxProvenanceFacts | null;
}

/**
 * A WS outbox row as its producer computes it: an ordered row with its track index row, any other row without, and
 * the producer's proof row when it names one.
 */
export function computeWsOutboxInsert(input: ComputeWsOutboxInsertInput): AppOutboxInsert {
    const { entry, admissionNamespace, provenance } = input;
    if (provenance !== null && entry.typeId !== EnqueuedType.WS_OUTBOX) {
        throw new TypeError('A producer proof belongs to a WS outbox row only');
    }
    const row = isOrderedWsOutboxEntry(entry)
        ? computeOrderedWsOutboxRow(entry, admissionNamespace)
        : computeAppOutboxInsert(entry);
    return {
        ...row,
        provenance: provenance === null ? null : toWsOutboxProvenanceSidecarRow(entry, provenance, row.expiresAt)
    };
}

export function computeAppOutboxInsert(entry: ResourceEntry): AppOutboxInsert {
    if (isOrderedWsOutboxEntry(entry)) {
        throw new TypeError('An ordered WS outbox row is computed by computeWsOutboxInsert');
    }
    return { ...computeAppOutboxRow(entry), trackIndex: null, provenance: null };
}

function computeOrderedWsOutboxRow(entry: ResourceEntry, admissionNamespace: string | null): AppOutboxInsert {
    if (admissionNamespace === null) {
        throw new TypeError('An ordered WS outbox row needs its admission namespace');
    }
    const row = computeAppOutboxRow(entry);
    return {
        ...row,
        trackIndex: computeAppOutboxTrackIndexRow({ entry, admissionNamespace, expiresAt: row.expiresAt }),
        provenance: null
    };
}

function toWsOutboxProvenanceSidecarRow(
    entry: ResourceEntry,
    facts: WsOutboxProvenanceFacts,
    expiresAt: string
): AppOutboxSidecarRow {
    if (facts.expiresAtMs !== entry.audit.expiryTs.epochMilliseconds) {
        throw new TypeError('A WS outbox proof expires with its row');
    }
    const record = computeWsOutboxProvenanceRecord({ entry, ...facts });
    return { namespace: record.namespace, key: record.key, value: record.value, expiresAt };
}

function computeAppOutboxRow(entry: ResourceEntry): Omit<AppOutboxInsert, 'trackIndex' | 'provenance'> {
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

/** A proof expiry the row does not carry is the one issue; otherwise the candidate is recomputed from its producer's facts and compared exactly, every difference one issue. */
export function validateWsOutboxInsert(
    expected: ComputeWsOutboxInsertInput,
    candidate: AppOutboxInsert
): readonly ComputedDataValidationIssue[] {
    if (
        expected.provenance !== null &&
        expected.provenance.expiresAtMs !== expected.entry.audit.expiryTs.epochMilliseconds
    ) {
        const message = 'wsOutbox.provenance.expiresAtMs differs from the row expiry';
        return [{ path: 'wsOutbox.provenance.expiresAtMs', message, cause: new TypeError(message) }];
    }
    return validateComputedProjection(computeWsOutboxInsert(expected), candidate, 'wsOutbox');
}

export async function writeAppOutboxInsert(transaction: PSqlSql, computed: AppOutboxInsert): Promise<void> {
    await writeAppOutboxInserts(transaction, [computed]);
}

/**
 * Every row in one statement and in the given order, with the track index rows of ordered WS rows and the proof rows
 * of proved ones in the same statement; each must come back, since a live row already under its key is the corruption
 * the insert reports and the transaction rolls back. An expired row is taken for absent and written over.
 */
export async function writeAppOutboxInserts(
    transaction: PSqlSql,
    computed: readonly AppOutboxInsert[]
): Promise<void> {
    if (computed.length === 0) {
        return;
    }
    const sidecars = computed.flatMap(({ trackIndex, provenance }) =>
        [trackIndex, provenance].filter((row): row is AppOutboxSidecarRow => row !== null)
    );
    if (sidecars.length === 0) {
        requireAppOutboxRowsInserted(computed, await insertAppOutboxRows(transaction, computed));
        return;
    }
    requireDistinctSidecarKeys(computed);
    const written = await insertAppOutboxRowsWithSidecars(transaction, computed, sidecars);
    requireAppOutboxRowsInserted(computed, toAppOutboxInsertedRows(written));
    requireSidecarsInserted(computed, toStoredSidecarIdentities(written));
}

const SIDECAR_REFUSALS = [
    ['trackIndex', 'App outbox track index did not create exactly one row'],
    ['provenance', 'App outbox provenance did not create exactly one row']
] as const;

function requireDistinctSidecarKeys(computed: readonly AppOutboxInsert[]): void {
    const trackIndexKeys = new Set<string>();
    const provenanceKeys = new Set<string>();
    for (const { entry, trackIndex, provenance } of computed) {
        if (trackIndex !== null && trackIndexKeys.has(trackIndex.key)) {
            throw new ResourceInboxInvariantCorruptionError(
                entry.key,
                'App outbox batch names one track index row twice'
            );
        }
        if (provenance !== null && provenanceKeys.has(provenance.key)) {
            throw new ResourceInboxInvariantCorruptionError(
                entry.key,
                'App outbox batch names one provenance row twice'
            );
        }
        if (trackIndex !== null) {
            trackIndexKeys.add(trackIndex.key);
        }
        if (provenance !== null) {
            provenanceKeys.add(provenance.key);
        }
    }
}

function requireSidecarsInserted(computed: readonly AppOutboxInsert[], stored: ReadonlySet<string>): void {
    for (const [field, reason] of SIDECAR_REFUSALS) {
        const missing = computed.find((insert) => {
            const sidecar = insert[field];
            return sidecar !== null && !stored.has(toSidecarIdentity(sidecar.namespace, sidecar.key));
        });
        if (missing !== undefined) {
            throw new ResourceInboxInvariantCorruptionError(missing.entry.key, reason);
        }
    }
}

function toSidecarIdentity(namespace: string, key: string): string {
    return `${namespace}\u0000${key}`;
}

function toStoredSidecarIdentities(written: readonly AppOutboxSidecarWrittenRow[]): ReadonlySet<string> {
    return new Set(
        written.flatMap(({ store_namespace, store_key }) =>
            store_namespace === null || store_key === null ? [] : [toSidecarIdentity(store_namespace, store_key)]
        )
    );
}

function toAppOutboxInsertedRows(written: readonly AppOutboxSidecarWrittenRow[]): readonly AppOutboxInsertedRow[] {
    return written.flatMap(({ ri_resource_id, ri_topic_id, fk_ext_bank_id, store_key }) =>
        store_key === null && ri_resource_id !== null && ri_topic_id !== null && fk_ext_bank_id !== null
            ? [{ ri_resource_id, ri_topic_id, fk_ext_bank_id }]
            : []
    );
}

function requireAppOutboxRowsInserted(
    computed: readonly AppOutboxInsert[],
    inserted: readonly AppOutboxInsertedRow[]
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
    if (computed.trackIndex !== null) {
        throw new TypeError('An ordered WS outbox row is not written if-absent');
    }
    if (computed.provenance !== null) {
        throw new TypeError('A proved WS outbox row is not written if-absent');
    }
    return (await insertAppOutboxRows(transaction, [computed])).length === 1;
}

interface AppOutboxInsertedRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly fk_ext_bank_id: string;
}

interface AppOutboxSidecarWrittenRow {
    readonly ri_resource_id: string | null;
    readonly ri_topic_id: string | null;
    readonly fk_ext_bank_id: string | null;
    readonly store_namespace: string | null;
    readonly store_key: string | null;
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

async function insertAppOutboxRowsWithSidecars(
    transaction: PSqlSql,
    computed: readonly AppOutboxInsert[],
    sidecars: readonly AppOutboxSidecarRow[]
): Promise<readonly AppOutboxSidecarWrittenRow[]> {
    const statement = PSqlFragment.of`with outbox as (
            ${toResourceInboxEntryInsert(computed.map(toAppOutboxInsertRow))}
            ${REPLACE_EXPIRED_RESOURCE_INBOX_ROW}
            returning ri_resource_id, ri_topic_id, fk_ext_bank_id
        ), sidecars as (${toAppOutboxSidecarInsert(sidecars)})
        select ri_resource_id, ri_topic_id, fk_ext_bank_id, null::text as store_namespace, null::text as store_key
        from outbox
        union all
        select null, null, null, store_namespace, store_key from sidecars
    `;
    return await transaction<readonly AppOutboxSidecarWrittenRow[]>(...statement.toStatement());
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
