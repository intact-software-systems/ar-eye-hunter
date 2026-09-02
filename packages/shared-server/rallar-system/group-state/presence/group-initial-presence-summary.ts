import type { GroupPresenceSummary } from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';
import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    type GroupStateValidationIssue
} from '../group-state-validation-issues.ts';

export type InitialGroupPresenceSummaryCandidate =
    | Readonly<{ operation: 'insert'; value: GroupPresenceSummary; }>
    | Readonly<{
        operation: 'update';
        value: GroupPresenceSummary;
        expectedRevision: number;
    }>;

export function toInitialGroupPresenceSummaryCandidate(
    value: GroupPresenceSummary,
    predecessor: RuntimeStateEntryValue<GroupPresenceSummary> | null
): InitialGroupPresenceSummaryCandidate {
    return predecessor
        ? { operation: 'update', value, expectedRevision: predecessor.entry.revision }
        : { operation: 'insert', value };
}

export function validateInitialGroupPresenceSummaryCandidate(
    candidate: InitialGroupPresenceSummaryCandidate,
    predecessor: RuntimeStateEntryValue<GroupPresenceSummary> | null
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (!isGroupStateRecord(candidate)) {
        return [
            toGroupStateValidationIssue('initialPresenceSummary', 'Initial group presence summary fields are invalid')
        ];
    }
    const expectedKeys = candidate.operation === 'update'
        ? ['expectedRevision', 'operation', 'value']
        : ['operation', 'value'];
    if (
        typeof candidate !== 'object' ||
        candidate === null ||
        Object.keys(candidate).length !== expectedKeys.length ||
        expectedKeys.some((key) => !Object.hasOwn(candidate, key))
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.initialPresenceSummary',
                'Initial group presence summary fields are invalid'
            )
        );
    }
    if (candidate.operation === 'insert') {
        if (predecessor !== null) {
            issues.push(
                toGroupStateValidationIssue(
                    'computed.initialPresenceSummary',
                    'Initial group presence summary insert has a predecessor'
                )
            );
        }
        return issues;
    }
    if (
        predecessor === null ||
        !Number.isSafeInteger(candidate.expectedRevision) ||
        candidate.expectedRevision < 0 ||
        candidate.expectedRevision !== predecessor.entry.revision
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.initialPresenceSummary',
                'Initial group presence summary update revision differs'
            )
        );
    }
    return issues;
}

export function nextInitialGroupSnapshotVersion(
    expiredGroupEntry: RuntimeStateEntry | null,
    predecessor: RuntimeStateEntryValue<GroupPresenceSummary> | null
): number {
    const issues = validateInitialGroupSnapshotPredecessor(expiredGroupEntry, predecessor);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    return Math.max(
        expiredGroupEntry ? expiredGroupEntry.revision + 1 : 0,
        predecessor?.value.causalRevision.groupRevision ?? 0
    ) + 1;
}

export function validateInitialGroupSnapshotPredecessor(
    expiredGroupEntry: RuntimeStateEntry | null,
    predecessor: RuntimeStateEntryValue<GroupPresenceSummary> | null
): readonly GroupStateValidationIssue[] {
    const previous = Math.max(
        expiredGroupEntry ? expiredGroupEntry.revision + 1 : 0,
        predecessor?.value.causalRevision.groupRevision ?? 0
    );
    if (!Number.isSafeInteger(previous) || previous >= Number.MAX_SAFE_INTEGER) {
        return [toGroupStateValidationIssue(
            'read.presenceSummary',
            'Initial group snapshot predecessor revision is invalid'
        )];
    }
    return [];
}
