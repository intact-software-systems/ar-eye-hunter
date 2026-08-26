import type { GroupRef } from '@shared/api/group-types.ts';

import {
    decodeGroupStateChildStorageKey,
    groupStateChildStorageKey
} from '../aggregate/group-aggregate-storage-keys.ts';

export function groupStateIdempotencyStorageKey(ref: GroupRef, requestId: string): string {
    return groupStateChildStorageKey(ref, 'request', requestId);
}

export function decodeGroupStateIdempotencyStorageKey(
    storageKey: string
): GroupRef & Readonly<{ requestId: string; }> {
    return decodeGroupStateChildStorageKey(
        storageKey,
        'request',
        'requestId',
        (ref) => groupStateIdempotencyStorageKey(ref, ref.requestId)
    );
}
