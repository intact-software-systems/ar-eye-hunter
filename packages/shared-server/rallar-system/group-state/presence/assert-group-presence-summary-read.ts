import type { GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';

import {
    assertExactKeys,
    assertRequiredKeys,
    requireJsonSafe
} from '../group-state-validation-primitives.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { groupStateMemberStorageKey } from '../persistence/membership/group-membership-storage-key.ts';
import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey,
    groupStatePresenceSummaryStorageKey
} from '../persistence/presence/group-presence-storage-keys.ts';
import { validateGroupStateRuntimeEntry } from '../persistence/validate-group-state-runtime-entry.ts';
import {
    validatePresenceAdmission,
    validatePresenceSession,
    validatePresenceSummaryValue
} from '../persistence/validate-persisted-group-presence.ts';
import {
    validateStoredGroup,
    validateStoredMember
} from '../persistence/validate-persisted-group.ts';
import type { GroupPresenceSummaryRead } from './compute-group-presence-summary.ts';

/**
 * A read the summary cannot be computed from, reported as a value so the queue retries it within its attempt budget
 * (D295): rows that changed while they were read, or rows that contradict each other, which within one consistent
 * snapshot is stored state no write leaves behind.
 */
export interface GroupPresenceSummaryReadInconsistency {
    readonly code:
        | 'group-presence-summary-concurrent-change'
        | 'group-presence-summary-roster-inconsistent'
        | 'group-presence-summary-admission-inconsistent';
    readonly message: string;
}

/** The per-record shape of the read; the facts across its rows are `validateGroupPresenceSummaryReadConsistency`'s. */
export function assertGroupPresenceSummaryRead(
    ref: GroupRef,
    read: GroupPresenceSummaryRead
): void {
    requireJsonSafe(read, 'Group presence summary read');
    assertExactKeys(
        read,
        ['group', 'members', 'admissions', 'presenceSessions', 'current'],
        'Group presence summary read'
    );
    assertRequiredKeys(
        read,
        ['group', 'members', 'admissions', 'presenceSessions', 'current'],
        'Group presence summary read'
    );
    validateGroupStateRuntimeEntry(
        read.group,
        'Stored summary group',
        groupStateGroupStorageKey(ref)
    );
    validateStoredGroup(read.group.value, ref);
    assertGroupPresenceSummaryCollections(ref, read);
    if (read.current) {
        validateGroupStateRuntimeEntry(
            read.current,
            'Stored current presence summary',
            groupStatePresenceSummaryStorageKey(ref)
        );
        validatePresenceSummaryValue(read.current.value, ref);
    }
}

/** The facts that span the read's rows: the group's roster counters and each admission's stored session. */
export function validateGroupPresenceSummaryReadConsistency(
    read: GroupPresenceSummaryRead
): readonly GroupPresenceSummaryReadInconsistency[] {
    return [
        ...validateGroupPresenceSummaryRoster(read),
        ...validateGroupPresenceSummaryAdmissionSessions(read)
    ];
}

function assertGroupPresenceSummaryCollections(
    ref: GroupRef,
    read: GroupPresenceSummaryRead
): void {
    for (
        const [label, values] of [
            ['members', read.members],
            ['admissions', read.admissions],
            ['presence sessions', read.presenceSessions]
        ] as const
    ) {
        if (!Array.isArray(values)) {
            throw new TypeError(`Group presence summary ${label} must be an array`);
        }
    }
    assertGroupPresenceSummaryMembers(ref, read);
    assertGroupPresenceSummaryAdmissions(ref, read.admissions);
    assertGroupPresenceSummarySessions(ref, read.presenceSessions);
}

function assertGroupPresenceSummaryMembers(ref: GroupRef, read: GroupPresenceSummaryRead): void {
    const memberIds = new Set<string>();
    for (const stored of read.members) {
        validateGroupStateRuntimeEntry(
            stored,
            'Stored summary member',
            groupStateMemberStorageKey({ ...ref, principalId: stored.value.principalId })
        );
        validateStoredMember(stored.value, ref, 'Stored summary member');
        if (memberIds.has(stored.value.principalId)) {
            throw new TypeError('Group presence summary member principal is duplicated');
        }
        memberIds.add(stored.value.principalId);
    }
}

function validateGroupPresenceSummaryRoster(
    read: GroupPresenceSummaryRead
): readonly GroupPresenceSummaryReadInconsistency[] {
    const activeMembers = read.members
        .map(({ value }) => value)
        .filter((member) => member.status === 'active');
    const activeOwners = activeMembers.filter((member) => member.role === 'owner');
    return read.group.value.activeMemberCount === activeMembers.length &&
            activeOwners.length === 1 &&
            activeOwners[0]?.principalId === read.group.value.ownerPrincipalId
        ? []
        : [{
            code: 'group-presence-summary-roster-inconsistent',
            message: 'Group presence summary roster facts are inconsistent'
        }];
}

function assertGroupPresenceSummaryAdmissions(
    ref: GroupRef,
    admissions: GroupPresenceSummaryRead['admissions']
): void {
    const admissionPrincipals = new Set<string>();
    const admittedSessionOwners = new Map<string, string>();
    for (const stored of admissions) {
        validateGroupStateRuntimeEntry(
            stored,
            'Stored summary admission',
            groupStatePresenceAdmissionStorageKey({ ...ref, principalId: stored.value.principalId })
        );
        validatePresenceAdmission(stored.value, ref);
        if (admissionPrincipals.has(stored.value.principalId)) {
            throw new TypeError('Group presence summary admission principal is duplicated');
        }
        admissionPrincipals.add(stored.value.principalId);
        for (const session of stored.value.admittedSessions) {
            const existing = admittedSessionOwners.get(session.sessionId);
            if (existing !== undefined && existing !== stored.value.principalId) {
                throw new TypeError('Group presence summary session has multiple principals');
            }
            admittedSessionOwners.set(session.sessionId, stored.value.principalId);
        }
    }
}

function assertGroupPresenceSummarySessions(
    ref: GroupRef,
    presenceSessions: GroupPresenceSummaryRead['presenceSessions']
): void {
    const sessionsById = new Map<string, GroupPresenceSession>();
    for (const stored of presenceSessions) {
        validateGroupStateRuntimeEntry(
            stored,
            'Stored summary presence session',
            groupStatePresenceSessionStorageKey({ ...ref, sessionId: stored.value.sessionId })
        );
        validatePresenceSession(stored.value, ref, 'Stored summary presence session');
        if (sessionsById.has(stored.value.sessionId)) {
            throw new TypeError('Group presence summary sessionId is duplicated');
        }
        sessionsById.set(stored.value.sessionId, stored.value);
    }
}

function validateGroupPresenceSummaryAdmissionSessions(
    read: GroupPresenceSummaryRead
): readonly GroupPresenceSummaryReadInconsistency[] {
    const sessionsById = new Map(read.presenceSessions.map(({ value }) => [value.sessionId, value]));
    const differing = read.admissions.some((stored) =>
        stored.value.admittedSessions.some((admitted) => {
            const session = sessionsById.get(admitted.sessionId);
            return session !== undefined && (
                session.principalId !== stored.value.principalId ||
                session.generationId !== admitted.generationId ||
                session.generationVersion !== admitted.generationVersion ||
                session.connectedAtEpochMs !== admitted.connectedAtEpochMs
            );
        })
    );
    return differing
        ? [{
            code: 'group-presence-summary-admission-inconsistent',
            message: 'Group presence summary admission differs from stored generation'
        }]
        : [];
}
