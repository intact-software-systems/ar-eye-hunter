import type { GroupRef } from '@shared/api/group-types.ts';

import {
    decodeGroupStateChildStorageKey,
    groupStateChildStorageKey,
    groupStateChildStorageKeySuffix
} from '../aggregate/group-aggregate-storage-keys.ts';

type GroupMemberStorageRef = GroupRef & Readonly<{ principalId: string; }>;

export function groupStateMemberStorageKey(ref: GroupMemberStorageRef): string {
    return groupStateChildStorageKey(ref, 'member', ref.principalId);
}

export function groupStateMemberStorageKeySuffix(principalId: string): string {
    return groupStateChildStorageKeySuffix('member', principalId);
}

export function decodeGroupStateMemberStorageKey(storageKey: string): GroupMemberStorageRef {
    return decodeGroupStateChildStorageKey(
        storageKey,
        'member',
        'principalId',
        groupStateMemberStorageKey
    );
}
