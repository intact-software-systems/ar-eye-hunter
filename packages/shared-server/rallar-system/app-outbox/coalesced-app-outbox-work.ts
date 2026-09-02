import {
    isMutableCoalescedStatus,
    isTerminalCoalescedStatus
} from '@shared/queuebox/coalesced-app-outbox-work-envelope.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { toDomain, type ResourceInboxRow } from '../../queuebox/postgres/resource-inbox-row-codec.ts';
import { validateAppInboxComputedProjection } from '../app-inbox/handler/app-inbox-computed-validation.ts';
import { writeAppOutboxInsertOrMatch, type AppOutboxInsertOrMatch } from './app-outbox-insert.ts';

export interface ComputedCoalescedAppOutboxWork {
    readonly entryWrite: AppOutboxInsertOrMatch;
    readonly successorWrite: AppOutboxInsertOrMatch;
    readonly operation: CoalescedAppOutboxWriteOperation;
}

export type CoalescedAppOutboxWriteOperation =
    | Readonly<{ kind: 'insert'; }>
    | CoalescedAppOutboxReplacement
    | CoalescedAppOutboxSuccessor;

export interface CoalescedAppOutboxSuccessor {
    readonly kind: 'successor';
    readonly expectedEntry: ResourceEntry;
}

export interface CoalescedAppOutboxReplacement {
    readonly kind: 'replace-finished-or-successor' | 'replace-pending-or-successor';
    readonly expectedEntry: ResourceEntry;
    readonly expectedGeneration: number;
    readonly rowCountError: ResourceInboxInvariantCorruptionError;
    readonly contentError: ResourceInboxInvariantCorruptionError;
}

export interface CoalescedAppOutboxValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: Error;
}

export async function writeCoalescedAppOutboxWork(
    transaction: PSqlSql,
    computed: ComputedCoalescedAppOutboxWork
): Promise<void> {
    const operation = computed.operation;
    if (operation.kind === 'insert') {
        await writeAppOutboxInsertOrMatch(transaction, computed.entryWrite);
        return;
    }
    if (operation.kind === 'successor') {
        await writeAppOutboxInsertOrMatch(transaction, computed.successorWrite);
        return;
    }
    const rows = operation.kind === 'replace-finished-or-successor'
        ? await writeFinishedCoalescedAppOutbox(transaction, computed.entryWrite, operation)
        : await writePendingCoalescedAppOutbox(transaction, computed.entryWrite, operation);
    const updated = toCoalescedReplacementResult(rows, computed.entryWrite, operation);
    if (updated !== null) {
        return;
    }
    await writeAppOutboxInsertOrMatch(transaction, computed.successorWrite);
}

export function computeCoalescedAppOutboxWriteOperation(
    previousEntry: ResourceEntry,
    expectedGeneration: number
): CoalescedAppOutboxReplacement | CoalescedAppOutboxSuccessor {
    const expectedEntry: ResourceEntry = {
        ...previousEntry,
        key: { ...previousEntry.key },
        audit: { ...previousEntry.audit },
        dequeueAudit: { ...previousEntry.dequeueAudit },
        ...(previousEntry.db === undefined ? {} : { db: { ...previousEntry.db } })
    };
    if (!isTerminalCoalescedStatus(previousEntry.status) && !isMutableCoalescedStatus(previousEntry.status)) {
        return { kind: 'successor', expectedEntry };
    }
    const lifecycle = isTerminalCoalescedStatus(previousEntry.status) ? 'finished' : 'pending';
    return {
        kind: lifecycle === 'finished' ? 'replace-finished-or-successor' : 'replace-pending-or-successor',
        expectedEntry,
        expectedGeneration,
        rowCountError: new ResourceInboxInvariantCorruptionError(
            expectedEntry.key,
            `Resource inbox ${lifecycle} replacement returned an unexpected row count`
        ),
        contentError: new ResourceInboxInvariantCorruptionError(
            expectedEntry.key,
            `Resource inbox ${lifecycle} replacement returned different content`
        )
    };
}

/** The domain validator checks its exact computation first; these are its bounded persistence invariants. */
export function validateCoalescedAppOutboxWrite(
    previousEntry: ResourceEntry | null,
    computed: ComputedCoalescedAppOutboxWork
): readonly CoalescedAppOutboxValidationIssue[] {
    const operation = computed.operation;
    if (previousEntry === null) {
        return operation.kind === 'insert'
            ? []
            : [createCoalescedPredecessorIssue('replacement requires a predecessor')];
    }
    if (operation.kind === 'insert') {
        return [createCoalescedPredecessorIssue('insert cannot have a predecessor')];
    }
    const issues: CoalescedAppOutboxValidationIssue[] = [
        ...validateAppInboxComputedProjection(
            previousEntry,
            operation.expectedEntry,
            'coalesced.operation.expectedEntry'
        )
    ];
    if (issues.length > 0) {
        return issues;
    }
    if (hasSameCoalescedEntryKey(computed.entryWrite.entry, computed.successorWrite.entry)) {
        issues.push(createCoalescedPredecessorIssue('successor must have a distinct queue identity'));
    }
    if (operation.kind !== 'successor') {
        issues.push(...validateCoalescedReplacement(previousEntry, computed.entryWrite.entry, operation));
    }
    return issues;
}

function validateCoalescedReplacement(
    previous: ResourceEntry,
    next: ResourceEntry,
    operation: CoalescedAppOutboxReplacement
): readonly CoalescedAppOutboxValidationIssue[] {
    const finished = operation.kind === 'replace-finished-or-successor';
    const validPrevious = finished
        ? isTerminalCoalescedStatus(previous.status)
        : isMutableCoalescedStatus(previous.status);
    const invalidPaths: string[] = [];
    if (!hasSameCoalescedEntryKey(previous, next)) {
        invalidPaths.push('coalesced.entryWrite.entry.key');
    }
    if (previous.typeId !== next.typeId) {
        invalidPaths.push('coalesced.entryWrite.entry.typeId');
    }
    if (!validPrevious) {
        invalidPaths.push('coalesced.operation.expectedEntry.status');
    }
    if (!isMutableCoalescedStatus(next.status)) {
        invalidPaths.push('coalesced.entryWrite.entry.status');
    }
    if (next.dequeueAudit.attempts !== (finished ? 0 : previous.dequeueAudit.attempts)) {
        invalidPaths.push('coalesced.entryWrite.entry.dequeueAudit.attempts');
    }
    if (
        !Number.isSafeInteger(operation.expectedGeneration) || operation.expectedGeneration < 1 ||
        operation.expectedGeneration >= Number.MAX_SAFE_INTEGER
    ) {
        invalidPaths.push('coalesced.operation.expectedGeneration');
    }
    const reason = `Resource inbox ${finished ? 'finished' : 'pending'} replacement identity or lifecycle differs`;
    return invalidPaths.map((path) => ({
        path,
        message: `${path}: ${reason}`,
        cause: new ResourceInboxInvariantCorruptionError(next.key, reason)
    }));
}

function createCoalescedPredecessorIssue(reason: string): CoalescedAppOutboxValidationIssue {
    const message = `Coalesced APP_OUTBOX ${reason}`;
    return { path: 'coalesced.operation', message, cause: new TypeError(message) };
}

function hasSameCoalescedEntryKey(left: ResourceEntry, right: ResourceEntry): boolean {
    return left.key.topicId === right.key.topicId && left.key.resourceId === right.key.resourceId &&
        left.key.contextId === right.key.contextId;
}

async function writePendingCoalescedAppOutbox(
    transaction: PSqlSql,
    computed: AppOutboxInsertOrMatch,
    operation: CoalescedAppOutboxReplacement
): Promise<readonly ResourceInboxRow[]> {
    const expected = operation.expectedEntry;
    return await transaction<readonly ResourceInboxRow[]>`
        update resource_inbox
        set ri_resource = ${computed.entry.resource},
            ri_status = ${computed.entry.status},
            next_ts = ${computed.nextAt}::text::timestamp(6)
        where ri_topic_id = ${expected.key.topicId}
          and ri_resource_id = ${expected.key.resourceId}
          and fk_ext_bank_id = ${expected.key.contextId}
          and ri_type_id = ${expected.typeId}
          and ri_status = ${expected.status}
          and ri_resource = ${expected.resource}
          and (((ri_resource::jsonb #>> '{payload,resource}')::jsonb
                #>> '{data,__rallarCoalescedWork,generation}')::bigint) = ${operation.expectedGeneration}
          and ri_attempts = ${expected.dequeueAudit.attempts}
        returning *
    `;
}

async function writeFinishedCoalescedAppOutbox(
    transaction: PSqlSql,
    computed: AppOutboxInsertOrMatch,
    operation: CoalescedAppOutboxReplacement
): Promise<readonly ResourceInboxRow[]> {
    const expected = operation.expectedEntry;
    return await transaction<readonly ResourceInboxRow[]>`
        update resource_inbox
        set ri_resource = ${computed.entry.resource},
            ri_status = ${computed.entry.status},
            next_ts = ${computed.nextAt}::text::timestamp(6),
            ri_attempts = 0,
            start_ts = null,
            end_ts = null,
            expire_ts = ${computed.expiresAt}::text::timestamp(6)
        where ri_topic_id = ${expected.key.topicId}
          and ri_resource_id = ${expected.key.resourceId}
          and fk_ext_bank_id = ${expected.key.contextId}
          and ri_type_id = ${expected.typeId}
          and ri_status = ${expected.status}
          and ri_resource = ${expected.resource}
          and (((ri_resource::jsonb #>> '{payload,resource}')::jsonb
                #>> '{data,__rallarCoalescedWork,generation}')::bigint) = ${operation.expectedGeneration}
        returning *
    `;
}

function toCoalescedReplacementResult(
    rows: readonly ResourceInboxRow[],
    computed: AppOutboxInsertOrMatch,
    operation: CoalescedAppOutboxReplacement
): ResourceEntry | null {
    if (rows.length === 0) {
        return null;
    }
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) {
        throw operation.rowCountError;
    }
    const updated = toDomain(row);
    if (
        updated.resource !== computed.entry.resource || updated.status !== computed.entry.status ||
        updated.typeId !== computed.entry.typeId
    ) {
        throw operation.contentError;
    }
    return updated;
}

