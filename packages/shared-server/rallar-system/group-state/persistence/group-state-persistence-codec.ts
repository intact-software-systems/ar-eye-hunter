import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef
} from '@shared/api/group-types.ts';

import {
    validatePresenceAdmission,
    validatePresenceSession,
    validatePresenceSummaryValue
} from './validate-persisted-group-presence.ts';
import { validateStoredGroup, validateStoredMember } from './validate-persisted-group.ts';

export function decodePersistedGroup(value: unknown, ref: GroupRef): Group {
    const persistedGroupIssues = validateStoredGroup(value, ref);
    if (persistedGroupIssues.length > 0) {
        throw persistedGroupIssues[0].cause;
    }
    return structuredClone(value as Group);
}

export function decodePersistedGroupMember(value: unknown, ref: GroupRef): GroupMember {
    const persistedGroupMemberIssues = validateStoredMember(value, ref, 'Stored group member');
    if (persistedGroupMemberIssues.length > 0) {
        throw persistedGroupMemberIssues[0].cause;
    }
    return structuredClone(value as GroupMember);
}

export function decodePersistedGroupPresenceSession(
    value: unknown,
    ref: GroupRef
): GroupPresenceSession {
    const persistedGroupPresenceSessionIssues = validatePresenceSession(value, ref, 'Stored group presence session');
    if (persistedGroupPresenceSessionIssues.length > 0) {
        throw persistedGroupPresenceSessionIssues[0].cause;
    }
    return structuredClone(value as GroupPresenceSession);
}

export function decodePersistedGroupPresenceSummary(
    value: unknown,
    ref: GroupRef
): GroupPresenceSummary {
    const persistedGroupPresenceSummaryIssues = validatePresenceSummaryValue(value, ref);
    if (persistedGroupPresenceSummaryIssues.length > 0) {
        throw persistedGroupPresenceSummaryIssues[0].cause;
    }
    return structuredClone(value as GroupPresenceSummary);
}

export function decodePersistedGroupPresenceAdmission(
    value: unknown,
    ref: GroupRef
): GroupPresenceAdmission {
    const persistedGroupPresenceAdmissionIssues = validatePresenceAdmission(value, ref);
    if (persistedGroupPresenceAdmissionIssues.length > 0) {
        throw persistedGroupPresenceAdmissionIssues[0].cause;
    }
    return structuredClone(value as GroupPresenceAdmission);
}
