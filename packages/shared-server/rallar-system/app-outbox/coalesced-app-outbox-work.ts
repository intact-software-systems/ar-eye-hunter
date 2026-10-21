import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    isMutableCoalescedStatus,
    isTerminalCoalescedStatus,
    tryReadCoalescedAppOutboxWorkEnvelope,
    type CoalescedAppOutboxWorkData,
    type CoalescedAppOutboxWorkEnvelope,
    type CoalescedAppOutboxWorkMetadata
} from '@shared/queuebox/coalesced-app-outbox-work-envelope.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import {
    computeResourceInboxCoalescedReplacement,
    writeResourceInboxCoalescedReplacement,
    type ResourceInboxCoalescedReplacement
} from '../../queuebox/postgres/resource-inbox-coalesced-replacement.ts';
import {
    computeAppOutboxInsert,
    writeAppOutboxInsertIfAbsent,
    type AppOutboxInsert
} from './app-outbox-insert.ts';

export {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    type CoalescedAppOutboxWorkData,
    type CoalescedAppOutboxWorkEnvelope,
    type CoalescedAppOutboxWorkMetadata,
    isMutableCoalescedStatus,
    isTerminalCoalescedStatus,
    tryReadCoalescedAppOutboxWorkEnvelope
};

export type ComputedCoalescedAppOutboxWork =
    | Readonly<{
        operation: 'insert';
        expectedEntry: null;
        expectedGeneration: null;
        entryWrite: AppOutboxInsert;
        successorWrite: AppOutboxInsert;
    }>
    | Readonly<{
        operation: 'write-successor';
        expectedEntry: ResourceEntry;
        expectedGeneration: number;
        entryWrite: AppOutboxInsert;
        successorWrite: AppOutboxInsert;
    }>
    | Readonly<{
        operation: 'replace-finished' | 'replace-pending';
        expectedEntry: ResourceEntry;
        expectedGeneration: number;
        replacement: ResourceInboxCoalescedReplacement;
        entryWrite: AppOutboxInsert;
        successorWrite: AppOutboxInsert;
    }>;

export function computeCoalescedAppOutboxWork(
    expectedEntry: ResourceEntry | null,
    entry: ResourceEntry,
    successorEntry: ResourceEntry
): ComputedCoalescedAppOutboxWork {
    const previousGeneration = expectedEntry === null ? 0 : toCoalescedGeneration(expectedEntry);
    const nextGeneration = toCoalescedGeneration(entry);
    if (nextGeneration !== previousGeneration + 1) {
        throw new TypeError('Coalesced APP_OUTBOX write must advance exactly one generation');
    }
    if (isSameKey(successorEntry.key, entry.key)) {
        throw new TypeError('Coalesced APP_OUTBOX successor must have a distinct queue identity');
    }
    const writes = {
        entryWrite: computeAppOutboxInsert(entry),
        successorWrite: computeAppOutboxInsert(successorEntry)
    };
    if (expectedEntry === null) {
        return { operation: 'insert', expectedEntry: null, expectedGeneration: null, ...writes };
    }
    const observation = {
        ...expectedEntry,
        key: { ...expectedEntry.key },
        audit: { ...expectedEntry.audit },
        dequeueAudit: { ...expectedEntry.dequeueAudit }
    };
    const operation = toCoalescedWriteOperation(observation);
    if (operation === 'write-successor') {
        return { operation, expectedEntry: observation, expectedGeneration: previousGeneration, ...writes };
    }
    return {
        operation,
        expectedEntry: observation,
        expectedGeneration: previousGeneration,
        replacement: computeResourceInboxCoalescedReplacement(observation, writes.entryWrite, previousGeneration),
        ...writes
    };
}

/**
 * What the coalesced write found. A head inserted by another writer since this one read none is a lost race, and so
 * is a successor already stored under its causal identity when this writer observed none: nothing is written, and a
 * fresh attempt reads and decides again.
 */
export type CoalescedAppOutboxWorkWrite = 'written' | 'head-present' | 'successor-present';

export async function writeCoalescedAppOutboxWork(
    transaction: PSqlSql,
    computed: ComputedCoalescedAppOutboxWork
): Promise<CoalescedAppOutboxWorkWrite> {
    if (computed.operation === 'insert') {
        return await writeAppOutboxInsertIfAbsent(transaction, computed.entryWrite) ? 'written' : 'head-present';
    }
    if (
        computed.operation !== 'write-successor' &&
        await writeResourceInboxCoalescedReplacement(transaction, computed.replacement) !== null
    ) {
        return 'written';
    }
    return await writeAppOutboxInsertIfAbsent(transaction, computed.successorWrite) ? 'written' : 'successor-present';
}

/**
 * The guard of a write that lets an observed successor stand for its request: the row is still stored as observed,
 * with the same status, attempts and resource, and stays so until the transaction ends.
 */
export async function readIsObservedCoalescedSuccessorStored(
    transaction: PSqlSql,
    observed: ResourceEntry
): Promise<boolean> {
    const { key } = observed;
    const rows = await transaction<{ readonly ri_row_id: string; }[]>`
        select ri_row_id from resource_inbox
        where ri_topic_id = ${key.topicId} and ri_resource_id = ${key.resourceId} and fk_ext_bank_id = ${key.contextId}
          and ri_status = ${observed.status} and ri_attempts = ${observed.dequeueAudit.attempts}
          and ri_resource = ${observed.resource}
        for share
    `;
    return rows.length === 1;
}

function toCoalescedWriteOperation(
    expectedEntry: ResourceEntry
): Exclude<ComputedCoalescedAppOutboxWork['operation'], 'insert'> {
    if (isTerminalCoalescedStatus(expectedEntry.status)) {
        return 'replace-finished';
    }
    return isMutableCoalescedStatus(expectedEntry.status)
        ? 'replace-pending'
        : 'write-successor';
}

function toCoalescedGeneration(entry: ResourceEntry): number {
    const envelope = tryReadCoalescedAppOutboxWorkEnvelope(entry);
    if (envelope === undefined) {
        throw new TypeError('Resource entry is not canonical coalesced APP_OUTBOX work');
    }
    return envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD].generation;
}

function isSameKey(left: Key, right: Key): boolean {
    return left.topicId === right.topicId &&
        left.resourceId === right.resourceId &&
        left.contextId === right.contextId;
}
