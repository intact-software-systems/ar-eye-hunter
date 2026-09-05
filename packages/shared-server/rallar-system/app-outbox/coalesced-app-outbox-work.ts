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
import { PSqlResourceInboxEntryRepository } from '../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { replaceFinishedResourceEntryIfMatch } from '../../queuebox/postgres/resource-inbox-finished-replacement.ts';
import {
    computeAppOutboxInsert,
    writeAppOutboxInsert,
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
        operation: 'replace-finished' | 'replace-pending' | 'write-successor';
        expectedEntry: ResourceEntry;
        expectedGeneration: number;
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
    return expectedEntry === null
        ? {
            operation: 'insert',
            expectedEntry,
            expectedGeneration: null,
            ...writes
        }
        : {
            operation: toCoalescedWriteOperation(expectedEntry),
            expectedEntry,
            expectedGeneration: previousGeneration,
            ...writes
        };
}

export async function writeCoalescedAppOutboxWork(
    transaction: PSqlSql,
    computed: ComputedCoalescedAppOutboxWork
): Promise<void> {
    if (computed.operation === 'insert') {
        await writeAppOutboxInsert(transaction, computed.entryWrite);
        return;
    }

    const expected = computed.expectedEntry;
    if (computed.operation === 'write-successor') {
        await writeCoalescedSuccessor(transaction, computed);
        return;
    }

    const expectedGeneration = computed.expectedGeneration;
    if (computed.operation === 'replace-finished') {
        const replaced = await replaceFinishedResourceEntryIfMatch(transaction, {
            expected,
            next: computed.entryWrite.entry,
            expectedGeneration
        });
        if (replaced !== null) {
            return;
        }
        await writeCoalescedSuccessor(transaction, computed);
        return;
    }

    const replaced = await new PSqlResourceInboxEntryRepository(transaction).replacePendingIfMatch(
        expected,
        computed.entryWrite.entry,
        expectedGeneration
    );
    if (replaced !== null) {
        return;
    }
    await writeCoalescedSuccessor(transaction, computed);
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

async function writeCoalescedSuccessor(
    transaction: PSqlSql,
    computed: Exclude<ComputedCoalescedAppOutboxWork, { operation: 'insert'; }>
): Promise<void> {
    await writeAppOutboxInsert(transaction, computed.successorWrite);
}

function isSameKey(left: Key, right: Key): boolean {
    return left.topicId === right.topicId &&
        left.resourceId === right.resourceId &&
        left.contextId === right.contextId;
}
