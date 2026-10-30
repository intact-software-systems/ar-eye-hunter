import type { GroupRef } from '@shared/api/group-types.ts';

import {
    decodeGroupStateChildStorageKey,
    groupStateChildStorageKey
} from '../aggregate/group-aggregate-storage-keys.ts';

export function groupStatePublicationGrantStorageKey(ref: GroupRef, principalId: string): string {
    return groupStateChildStorageKey(ref, 'grant', principalId);
}

export function decodeGroupStatePublicationGrantStorageKey(
    storageKey: string
): GroupRef & Readonly<{ principalId: string; }> {
    return decodeGroupStateChildStorageKey(storageKey, 'grant', 'principalId');
}
