import type { GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';

import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    type GroupStateValidationIssue
} from '../group-state-validation-issues.ts';
import { groupStateMemberStorageKey } from '../persistence/membership/group-membership-storage-key.ts';
import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey
} from '../persistence/presence/group-presence-storage-keys.ts';
import { validateGroupStateRuntimeEntry } from '../persistence/validate-group-state-runtime-entry.ts';
import {
    validatePresenceAdmission,
    validatePresenceSession
} from '../persistence/validate-persisted-group-presence.ts';
import { validateStoredMember } from '../persistence/validate-persisted-group.ts';
import type { GroupPresenceSummaryRead } from './compute-group-presence-summary.ts';

export function validateGroupPresenceSummaryReadCollections(
    ref: GroupRef,
    read: GroupPresenceSummaryRead
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    for (
        const [label, values] of [
            ['members', read.members],
            ['admissions', read.admissions],
            ['presence sessions', read.presenceSessions]
        ] as const
    ) {
        if (!Array.isArray(values)) {
            issues.push(
                toGroupStateValidationIssue(
                    'read',
                    `Group presence summary ${label} must be an array`
                )
            );
        }
    }
    if (Array.isArray(read.members)) {
        issues.push(...validateGroupPresenceSummaryMembers(ref, read));
    }
    const admissionIssues = Array.isArray(read.admissions)
        ? validateGroupPresenceSummaryAdmissions(ref, read.admissions)
        : [];
    const sessionIssues = Array.isArray(read.presenceSessions)
        ? validateGroupPresenceSummarySessions(ref, read.presenceSessions)
        : [];
    issues.push(...admissionIssues, ...sessionIssues);
    if (
        Array.isArray(read.admissions) && Array.isArray(read.presenceSessions) &&
        admissionIssues.length === 0 && sessionIssues.length === 0
    ) {
        const sessionsById = new Map(read.presenceSessions.map(({ value }) => [value.sessionId, value]));
        issues.push(...validateGroupPresenceSummaryAdmissionSessions(read.admissions, sessionsById));
    }
    return issues;
}

function validateGroupPresenceSummaryMembers(
    ref: GroupRef,
    read: GroupPresenceSummaryRead
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const memberIds = new Set<string>();
    for (const stored of read.members) {
        if (!isGroupStateRecord(stored) || !isGroupStateRecord(stored.value)) {
            issues.push(
                toGroupStateValidationIssue('read.members', 'Stored summary member must contain an object value')
            );
            continue;
        }
        issues.push(...validateGroupStateRuntimeEntry(
            stored,
            'Stored summary member',
            typeof stored.value.principalId === 'string' && stored.value.principalId.length > 0
                ? groupStateMemberStorageKey({ ...ref, principalId: stored.value.principalId })
                : undefined
        ));
        issues.push(...validateStoredMember(stored.value, ref, 'Stored summary member'));
        if (memberIds.has(stored.value.principalId)) {
            issues.push(
                toGroupStateValidationIssue(
                    'read.members',
                    'Group presence summary member principal is duplicated'
                )
            );
        }
        memberIds.add(stored.value.principalId);
    }
    if (issues.length > 0 || !isGroupStateRecord(read.group?.value)) {
        return issues;
    }
    const activeMembers = read.members
        .map(({ value }) => value)
        .filter((member) => member.status === 'active');
    const activeOwners = activeMembers.filter((member) => member.role === 'owner');
    if (
        read.group.value.activeMemberCount !== activeMembers.length ||
        activeOwners.length !== 1 ||
        activeOwners[0]?.principalId !== read.group.value.ownerPrincipalId
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'read.members',
                'Group presence summary roster facts are inconsistent'
            )
        );
    }
    return issues;
}

function validateGroupPresenceSummaryAdmissions(
    ref: GroupRef,
    admissions: GroupPresenceSummaryRead['admissions']
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const admissionPrincipals = new Set<string>();
    const admittedSessionOwners = new Map<string, string>();
    for (const stored of admissions) {
        if (!isGroupStateRecord(stored) || !isGroupStateRecord(stored.value)) {
            issues.push(
                toGroupStateValidationIssue('read.admissions', 'Stored summary admission must contain an object value')
            );
            continue;
        }
        issues.push(...validateGroupStateRuntimeEntry(
            stored,
            'Stored summary admission',
            typeof stored.value.principalId === 'string' && stored.value.principalId.length > 0
                ? groupStatePresenceAdmissionStorageKey({ ...ref, principalId: stored.value.principalId })
                : undefined
        ));
        issues.push(...validatePresenceAdmission(stored.value, ref));
        if (admissionPrincipals.has(stored.value.principalId)) {
            issues.push(
                toGroupStateValidationIssue(
                    'read.admissions',
                    'Group presence summary admission principal is duplicated'
                )
            );
        }
        admissionPrincipals.add(stored.value.principalId);
        if (!Array.isArray(stored.value.admittedSessions)) {
            continue;
        }
        for (const session of stored.value.admittedSessions) {
            if (!isGroupStateRecord(session) || typeof session.sessionId !== 'string') {
                continue;
            }
            const existing = admittedSessionOwners.get(session.sessionId);
            if (existing !== undefined && existing !== stored.value.principalId) {
                issues.push(
                    toGroupStateValidationIssue(
                        'read.admissions',
                        'Group presence summary session has multiple principals'
                    )
                );
            }
            admittedSessionOwners.set(session.sessionId, stored.value.principalId);
        }
    }
    return issues;
}

function validateGroupPresenceSummarySessions(
    ref: GroupRef,
    presenceSessions: GroupPresenceSummaryRead['presenceSessions']
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const sessionsById = new Map<string, GroupPresenceSession>();
    for (const stored of presenceSessions) {
        if (!isGroupStateRecord(stored) || !isGroupStateRecord(stored.value)) {
            issues.push(
                toGroupStateValidationIssue(
                    'read.presenceSessions',
                    'Stored summary presence session must contain an object value'
                )
            );
            continue;
        }
        issues.push(...validateGroupStateRuntimeEntry(
            stored,
            'Stored summary presence session',
            typeof stored.value.sessionId === 'string' && stored.value.sessionId.length > 0
                ? groupStatePresenceSessionStorageKey({ ...ref, sessionId: stored.value.sessionId })
                : undefined
        ));
        issues.push(...validatePresenceSession(stored.value, ref, 'Stored summary presence session'));
        if (sessionsById.has(stored.value.sessionId)) {
            issues.push(
                toGroupStateValidationIssue(
                    'read.presenceSessions',
                    'Group presence summary sessionId is duplicated'
                )
            );
        }
        sessionsById.set(stored.value.sessionId, stored.value);
    }
    return issues;
}

function validateGroupPresenceSummaryAdmissionSessions(
    admissions: GroupPresenceSummaryRead['admissions'],
    sessionsById: ReadonlyMap<string, GroupPresenceSession>
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    for (const stored of admissions) {
        for (const admitted of stored.value.admittedSessions) {
            const session = sessionsById.get(admitted.sessionId);
            if (!session) {
                continue;
            }
            if (
                session.principalId !== stored.value.principalId ||
                session.generationId !== admitted.generationId ||
                session.generationVersion !== admitted.generationVersion ||
                session.connectedAtEpochMs !== admitted.connectedAtEpochMs
            ) {
                issues.push(
                    toGroupStateValidationIssue(
                        'read.admissions',
                        'Group presence summary admission differs from stored generation'
                    )
                );
            }
        }
    }
    return issues;
}
