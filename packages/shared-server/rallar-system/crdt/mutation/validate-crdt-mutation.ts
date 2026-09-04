import { isExactAppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { computeCrdtMutationWrites } from './compute-crdt-mutation-outcome.ts';
import type {
    CrdtDocumentWrite,
    CrdtMutationCommand,
    CrdtMutationComputed,
    CrdtMutationRead,
    CrdtMutationValidationIssue,
    CrdtSnapshotWrite,
    CrdtUpdateWrite,
    ValidateCrdtMutationInput
} from './crdt-mutation-contracts.ts';
import { decodeCrdtMutationResult } from './decode-crdt-mutation-result.ts';

interface UntrustedCrdtRecord {
    readonly [key: string]: object | string | number | boolean | null | undefined;
}

export function validateCrdtMutation(
    input: ValidateCrdtMutationInput
): readonly CrdtMutationValidationIssue[] {
    const { command, read, computed } = input;
    const issues: CrdtMutationValidationIssue[] = [];
    if (
        computed.command !== command ||
        computed.read !== read ||
        computed.commandId !== command.commandId ||
        computed.commandHash !== command.commandHash ||
        computed.documentKey !== command.documentKey
    ) {
        issues.push({
            code: 'computed-identity-differs',
            message: 'CRDT computed identity differs from command'
        });
    }
    if (
        computed.outcome === 'write' &&
        read.document &&
        computed.expectedDocumentRevision !== read.document.documentRevision
    ) {
        issues.push({
            code: 'computed-predecessor-differs',
            message: 'CRDT computed predecessor differs from read document'
        });
    }
    if (command.operation === 'compact' && computed.outcome === 'write') {
        const result = toRecord(computed.result);
        const resultSnapshot = result?.operation === 'compact' &&
                result.status === 'accepted' &&
                typeof result.snapshot === 'object'
            ? result.snapshot
            : null;
        if (
            readSnapshotReason(computed.snapshot) !== command.reason ||
            result?.operation !== 'compact' ||
            result.status !== 'accepted' ||
            readSnapshotReason(resultSnapshot) !== command.reason
        ) {
            issues.push({
                code: 'compact-reason-differs',
                message: 'CRDT compact reason differs across command and computed result'
            });
        }
    }
    try {
        decodeCrdtMutationResult(computed.result);
    }
    catch (error) {
        issues.push({
            code: 'result-codec-invalid',
            message: error instanceof Error ? error.message : String(error)
        });
    }
    if (!hasConsistentCrdtPersistence(computed)) {
        issues.push({
            code: 'computed-persistence-differs',
            message: 'CRDT computed persistence differs from the computed mutation'
        });
    }
    return issues;
}

function hasConsistentCrdtPersistence(computed: CrdtMutationComputed): boolean {
    const outboxMatches = computed.outboxWrites.length === computed.outboxEntries.length &&
        computed.outboxWrites.every((write, index) => {
            const entry = computed.outboxEntries[index];
            return entry !== undefined && isExactAppOutboxInsert(entry, write);
        });
    if (!outboxMatches || computed.outcome !== 'write') {
        return outboxMatches;
    }
    try {
        const expected = computeCrdtMutationWrites({
            read: computed.read,
            document: computed.document,
            update: computed.update,
            append: computed.append,
            snapshot: computed.snapshot
        });
        return sameDocumentWrite(computed.documentWrite, expected.documentWrite) &&
            sameOptionalUpdateWrite(computed.updateWrite, expected.updateWrite) &&
            sameOptionalSnapshotWrite(computed.snapshotWrite, expected.snapshotWrite);
    }
    catch {
        return false;
    }
}

function sameDocumentWrite(left: CrdtDocumentWrite, right: CrdtDocumentWrite): boolean {
    return left.operation === right.operation &&
        left.documentKey === right.documentKey &&
        left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.scope === right.scope &&
        left.documentType === right.documentType &&
        left.documentId === right.documentId &&
        left.documentRefJson === right.documentRefJson &&
        left.documentRevision === right.documentRevision &&
        left.lifecycle === right.lifecycle &&
        sameDate(left.createdAt, right.createdAt) &&
        sameDate(left.updatedAt, right.updatedAt) &&
        sameOptionalDate(left.archivedAt, right.archivedAt) &&
        sameOptionalDate(left.destroyedAt, right.destroyedAt) &&
        left.lastAppendSequence === right.lastAppendSequence &&
        left.updateCount === right.updateCount &&
        left.snapshotCount === right.snapshotCount &&
        left.storedUpdateBytes === right.storedUpdateBytes &&
        left.retentionJson === right.retentionJson &&
        left.quotaJson === right.quotaJson &&
        left.projectionIdsJson === right.projectionIdsJson &&
        (left.operation === 'insert' || right.operation === 'insert' || (
            left.expectedRevision === right.expectedRevision &&
            left.expectedLifecycle === right.expectedLifecycle &&
            left.expectedAppendSequence === right.expectedAppendSequence
        ));
}

function sameOptionalUpdateWrite(
    left: CrdtUpdateWrite | null,
    right: CrdtUpdateWrite | null
): boolean {
    if (left === null || right === null) {
        return left === right;
    }
    return left.documentKey === right.documentKey &&
        left.appendSequence === right.appendSequence &&
        left.updateId === right.updateId &&
        left.updateEnvelopeJson === right.updateEnvelopeJson &&
        left.acceptedUpdateHash === right.acceptedUpdateHash &&
        left.actorId === right.actorId &&
        left.principalId === right.principalId &&
        left.sessionId === right.sessionId &&
        left.serverId === right.serverId &&
        left.authorizationScope === right.authorizationScope &&
        sameDate(left.acceptedAt, right.acceptedAt);
}

function sameOptionalSnapshotWrite(
    left: CrdtSnapshotWrite | null,
    right: CrdtSnapshotWrite | null
): boolean {
    if (left === null || right === null) {
        return left === right;
    }
    return left.documentKey === right.documentKey &&
        left.snapshotId === right.snapshotId &&
        left.appendSequence === right.appendSequence &&
        left.snapshotEnvelopeJson === right.snapshotEnvelopeJson &&
        sameDate(left.createdAt, right.createdAt) &&
        left.reason === right.reason;
}

function sameDate(left: Date, right: Date): boolean {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
}

function sameOptionalDate(left: Date | null, right: Date | null): boolean {
    return left === null || right === null ? left === right : sameDate(left, right);
}

function readSnapshotReason(snapshot: object | null | undefined): string | null {
    const snapshotRecord = toRecord(snapshot);
    const metadata = snapshotRecord && typeof snapshotRecord.metadata === 'object'
        ? toRecord(snapshotRecord.metadata)
        : null;
    return typeof metadata?.reason === 'string' ? metadata.reason : null;
}

function toRecord(value: object | null | undefined): UntrustedCrdtRecord | null {
    return typeof value === 'object' && value !== null ? (value as UntrustedCrdtRecord) : null;
}
