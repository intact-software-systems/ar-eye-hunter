import type { GroupRef } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';

import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from '../../persistence/presence/group-presence-storage-keys.ts';
import { validateGroupStateRuntimeEntry } from '../../persistence/validate-group-state-runtime-entry.ts';
import {
    validatePresenceAdmission,
    validatePresenceSession
} from '../../persistence/validate-persisted-group-presence.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import type { GroupMutationReadIdentities } from '../read/resolve-group-mutation-read-identities.ts';

interface ValidateGroupMutationAuthorityReadsInput {
    readonly read: GroupMutationRead;
    readonly command: GroupMutationCommand;
    readonly ref: GroupRef;
    readonly identities: GroupMutationReadIdentities;
}

export function validateGroupMutationAuthorityReads({
    read,
    command,
    ref,
    identities
}: ValidateGroupMutationAuthorityReadsInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const authorityAdmissionPrincipalId = command.operation === 'appointDirector'
        ? identities.ownerPrincipalId
        : null;
    const directorAdmissionPrincipalId = command.operation === 'appointDirector'
        ? identities.directorPrincipalId
        : null;
    for (
        const [label, admission, expectedPrincipalId] of [
            ['Target admission', read.targetAdmission, identities.targetPrincipalId],
            ['Authority admission', read.authorityAdmission, authorityAdmissionPrincipalId],
            ['Director admission', read.directorAdmission, directorAdmissionPrincipalId]
        ] as const
    ) {
        if (!admission) {
            continue;
        }
        if (
            expectedPrincipalId === null || !isGroupStateRecord(admission.value) ||
            admission.value.principalId !== expectedPrincipalId
        ) {
            issues.push(
                toGroupStateValidationIssue(
                    'read.admission',
                    `${label} principal differs from command slot identity`
                )
            );
        }
        issues.push(...validateGroupStateRuntimeEntry(
            admission,
            label,
            expectedPrincipalId === null
                ? undefined
                : groupStatePresenceAdmissionStorageKey({ ...ref, principalId: expectedPrincipalId })
        ));
        issues.push(...validatePresenceAdmission(admission.value, ref));
    }
    return issues;
}

export function validateGroupMutationAuthorityPresenceReads(
    read: GroupMutationRead,
    ref: GroupRef
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (
        !Array.isArray(read.authorityPresenceSessions) ||
        !Array.isArray(read.authorityPresenceSessionEntries)
    ) {
        return [
            toGroupStateValidationIssue('read.authorityPresenceSessions', 'Authority presence sessions must be arrays')
        ];
    }
    if (read.authorityPresenceSessions.length !== read.authorityPresenceSessionEntries.length) {
        issues.push(
            toGroupStateValidationIssue(
                'read.authorityPresenceSessions',
                'Authority presence sessions differ from stored entries'
            )
        );
    }
    const referenced = computeReferencedAuthoritySessions(read);
    issues.push(...referenced.issues, ...validateAuthorityPresenceEntries(read, ref, referenced.sessions));
    return issues;
}

interface ReferencedAuthoritySession {
    readonly principalId: string;
    readonly generationId: string;
    readonly generationVersion: number;
    readonly connectedAtEpochMs: number;
}

interface ReferencedAuthoritySessions {
    readonly sessions: ReadonlyMap<string, ReferencedAuthoritySession>;
    readonly issues: readonly GroupStateValidationIssue[];
}

function computeReferencedAuthoritySessions(read: GroupMutationRead): ReferencedAuthoritySessions {
    const issues: GroupStateValidationIssue[] = [];
    const referencedAuthoritySessions = new Map<string, ReferencedAuthoritySession>();
    for (const admission of [read.authorityAdmission, read.directorAdmission]) {
        if (!admission || !isGroupStateRecord(admission.value) || !Array.isArray(admission.value.admittedSessions)) {
            continue;
        }
        for (const session of admission.value.admittedSessions) {
            if (!isGroupStateRecord(session) || typeof session.sessionId !== 'string') {
                continue;
            }
            const existing = referencedAuthoritySessions.get(session.sessionId);
            if (existing && existing.principalId !== admission.value.principalId) {
                issues.push(
                    toGroupStateValidationIssue(
                        'read.authorityAdmission',
                        'Stored authority presence session is referenced by multiple principals'
                    )
                );
            }
            if (
                existing &&
                (existing.generationId !== session.generationId ||
                    existing.generationVersion !== session.generationVersion ||
                    existing.connectedAtEpochMs !== session.connectedAtEpochMs)
            ) {
                issues.push(
                    toGroupStateValidationIssue(
                        'read.authorityAdmission',
                        'Stored authority presence session has conflicting admission generations'
                    )
                );
            }
            if (
                typeof session.generationId !== 'string' || typeof session.generationVersion !== 'number' ||
                typeof session.connectedAtEpochMs !== 'number'
            ) {
                continue;
            }
            referencedAuthoritySessions.set(session.sessionId, {
                principalId: admission.value.principalId,
                generationId: session.generationId,
                generationVersion: session.generationVersion,
                connectedAtEpochMs: session.connectedAtEpochMs
            });
        }
    }
    return { sessions: referencedAuthoritySessions, issues };
}

function validateAuthorityPresenceEntries(
    read: GroupMutationRead,
    ref: GroupRef,
    referencedAuthoritySessions: ReadonlyMap<string, ReferencedAuthoritySession>
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    read.authorityPresenceSessionEntries.forEach((entry, index) => {
        if (!isGroupStateRecord(entry) || !isGroupStateRecord(entry.value)) {
            issues.push(
                toGroupStateValidationIssue(
                    'read.authorityPresenceSessionEntries',
                    'Stored authority presence must contain an object value'
                )
            );
            return;
        }
        const expected = referencedAuthoritySessions.get(entry.value.sessionId);
        if (
            !expected ||
            expected.principalId !== entry.value.principalId ||
            expected.generationId !== entry.value.generationId ||
            expected.generationVersion !== entry.value.generationVersion ||
            expected.connectedAtEpochMs !== entry.value.connectedAtEpochMs
        ) {
            issues.push(
                toGroupStateValidationIssue(
                    'read.authorityPresenceSessionEntries',
                    'Stored authority presence is not referenced by its corresponding admission'
                )
            );
        }
        issues.push(...validateGroupStateRuntimeEntry(
            entry,
            'Stored authority presence',
            typeof entry.value.sessionId === 'string' && entry.value.sessionId.length > 0
                ? groupStatePresenceSessionStorageKey({ ...ref, sessionId: entry.value.sessionId })
                : undefined
        ));
        issues.push(...validatePresenceSession(entry.value, ref, 'Stored authority presence'));
        if (!jsonEquals(entry.value, read.authorityPresenceSessions[index])) {
            issues.push(
                toGroupStateValidationIssue(
                    'read.authorityPresenceSessionEntries',
                    'Authority presence session differs from stored entry'
                )
            );
        }
    });
    return issues;
}

