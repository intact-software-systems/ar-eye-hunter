import type { GroupPresenceSummary } from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';

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
): void {
    const expectedKeys = candidate.operation === 'update'
        ? ['expectedRevision', 'operation', 'value']
        : ['operation', 'value'];
    if (
        typeof candidate !== 'object' ||
        candidate === null ||
        JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(expectedKeys)
    ) {
        throw new TypeError('Initial group presence summary fields are invalid');
    }
    if (candidate.operation === 'insert') {
        if (predecessor !== null) {
            throw new TypeError('Initial group presence summary insert has a predecessor');
        }
        return;
    }
    if (
        predecessor === null ||
        !Number.isSafeInteger(candidate.expectedRevision) ||
        candidate.expectedRevision < 0 ||
        candidate.expectedRevision !== predecessor.entry.revision
    ) {
        throw new TypeError('Initial group presence summary update revision differs');
    }
}

export function nextInitialGroupSnapshotVersion(
    expiredGroupEntry: RuntimeStateEntry | null,
    predecessor: RuntimeStateEntryValue<GroupPresenceSummary> | null
): number {
    const previous = Math.max(
        expiredGroupEntry ? expiredGroupEntry.revision + 1 : 0,
        predecessor?.value.causalRevision.groupRevision ?? 0
    );
    if (!Number.isSafeInteger(previous) || previous >= Number.MAX_SAFE_INTEGER) {
        throw new TypeError('Initial group snapshot predecessor revision is invalid');
    }
    return previous + 1;
}
