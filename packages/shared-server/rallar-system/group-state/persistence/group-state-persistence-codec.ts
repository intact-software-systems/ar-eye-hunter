import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef
} from '@shared/api/group-types.ts';

import {
    validatePersistedGroupPresenceAdmission,
    validatePersistedGroupPresenceSession,
    validatePersistedGroupPresenceSummary
} from './validate-persisted-group-presence.ts';
import { validatePersistedGroup, validatePersistedGroupMember } from './validate-persisted-group.ts';

export function decodePersistedGroup(value: unknown, ref: GroupRef): Group {
    validatePersistedGroup(value, ref);
    return value;
}

export function decodePersistedGroupMember(value: unknown, ref: GroupRef): GroupMember {
    validatePersistedGroupMember(value, ref);
    return value;
}

export function decodePersistedGroupPresenceSession(
    value: unknown,
    ref: GroupRef
): GroupPresenceSession {
    validatePersistedGroupPresenceSession(value, ref);
    return value;
}

export function decodePersistedGroupPresenceSummary(
    value: unknown,
    ref: GroupRef
): GroupPresenceSummary {
    validatePersistedGroupPresenceSummary(value, ref);
    return value;
}

export function decodePersistedGroupPresenceAdmission(
    value: unknown,
    ref: GroupRef
): GroupPresenceAdmission {
    validatePersistedGroupPresenceAdmission(value, ref);
    return value;
}
