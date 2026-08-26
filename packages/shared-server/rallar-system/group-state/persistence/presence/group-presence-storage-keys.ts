import type { GroupRef } from '@shared/api/group-types.ts';

import {
    decodeGroupStateChildStorageKey,
    groupStateChildStorageKey,
    groupStateGroupStorageKey
} from '../aggregate/group-aggregate-storage-keys.ts';

type GroupMemberStorageRef = GroupRef & Readonly<{ principalId: string; }>;
type GroupSessionStorageRef = GroupRef & Readonly<{ sessionId: string; }>;

export function groupStatePresenceSessionStorageKey(ref: GroupSessionStorageRef): string {
    return groupStateChildStorageKey(ref, 'session', ref.sessionId);
}

export function decodeGroupStatePresenceSessionStorageKey(
    storageKey: string
): GroupSessionStorageRef {
    return decodeGroupStateChildStorageKey(
        storageKey,
        'session',
        'sessionId',
        groupStatePresenceSessionStorageKey
    );
}

export function groupStatePresenceAdmissionStorageKey(ref: GroupMemberStorageRef): string {
    return groupStateChildStorageKey(ref, 'principal', ref.principalId);
}

export function decodeGroupStatePresenceAdmissionStorageKey(
    storageKey: string
): GroupMemberStorageRef {
    return decodeGroupStateChildStorageKey(
        storageKey,
        'principal',
        'principalId',
        groupStatePresenceAdmissionStorageKey
    );
}

export function groupStatePresenceSummaryStorageKey(ref: GroupRef): string {
    return groupStateGroupStorageKey(ref);
}
