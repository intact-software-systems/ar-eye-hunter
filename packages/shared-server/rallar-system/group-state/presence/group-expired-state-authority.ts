import type { GroupRef } from '@shared/api/group-types.ts';
import { validateRuntimeStateExpiredAuthorityIssues } from '../../../runtime-state/runtime-state-expired-entry.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';
import { toGroupStateValidationIssue, type GroupStateValidationIssue } from '../group-state-validation-issues.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { groupStatePresenceSessionStorageKey } from '../persistence/presence/group-presence-storage-keys.ts';

export function validateGroupExpiredStateAuthority(
    input: Readonly<{
        ref: GroupRef;
        targetSessionId: string | null;
        group: object | null;
        expiredGroupEntry: RuntimeStateEntry | null;
        targetPresence: object | null;
        expiredTargetPresenceEntry: RuntimeStateEntry | null;
    }>
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = validateRuntimeStateExpiredAuthorityIssues({
        live: input.group,
        expiredEntry: input.expiredGroupEntry,
        expectedKey: groupStateGroupStorageKey(input.ref),
        label: 'Group read'
    }).map((issue) => ({ ...issue, path: `read.group.${issue.path}` }));
    if (input.targetSessionId === null) {
        if (input.expiredTargetPresenceEntry) {
            issues.push(
                toGroupStateValidationIssue(
                    'read.expiredTargetPresenceEntry',
                    'Presence read has expired authority without a target session'
                )
            );
        }
        return issues;
    }
    issues.push(
        ...validateRuntimeStateExpiredAuthorityIssues({
            live: input.targetPresence,
            expiredEntry: input.expiredTargetPresenceEntry,
            expectedKey: groupStatePresenceSessionStorageKey({
                ...input.ref,
                sessionId: input.targetSessionId
            }),
            label: 'Presence read'
        }).map((issue) => ({ ...issue, path: `read.targetPresence.${issue.path}` }))
    );
    return issues;
}

export function toExpiredAwareInsertCandidate<T>(
    expiredEntry: RuntimeStateEntry | null,
    value: T
):
    | Readonly<{ operation: 'insert'; value: T; }>
    | Readonly<{ operation: 'update'; value: T; expectedRevision: number; }> {
    return expiredEntry
        ? { operation: 'update', value, expectedRevision: expiredEntry.revision }
        : { operation: 'insert', value };
}
