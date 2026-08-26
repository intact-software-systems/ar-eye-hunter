import type { GroupRef } from '@shared/api/group-types.ts';

import {
    decodeGroupStateIdempotencyStorageKey,
    groupStateIdempotencyStorageKey
} from '../../../group-state/persistence/idempotency/group-idempotency-storage-key.ts';
import { toGroupTopologyConfigRepositoryCorruption } from './group-topology-config-repository-contracts.ts';
import { assertGroupTopologyRef } from './group-topology-storage-slot.ts';

export function groupTopologyMutationStorageKey(ref: GroupRef, requestId: string): string {
    return groupStateIdempotencyStorageKey(ref, requestId);
}

export function assertGroupTopologyMutationStorageSlot(
    storageKey: string,
    trustedRef: GroupRef,
    trustedRequestId: string
): GroupRef & Readonly<{ requestId: string; }> {
    const decoded = decodeGroupTopologyMutationStorageKey(storageKey);
    assertGroupTopologyRef({
        actual: decoded,
        expected: trustedRef,
        storageKey,
        slot: 'requested mutation slot'
    });
    if (decoded.requestId !== trustedRequestId) {
        throw toGroupTopologyConfigRepositoryCorruption(
            storageKey,
            'Stored topology config request differs from the requested slot'
        );
    }
    return decoded;
}

function decodeGroupTopologyMutationStorageKey(
    storageKey: string
): GroupRef & Readonly<{ requestId: string; }> {
    try {
        return decodeGroupStateIdempotencyStorageKey(storageKey);
    }
    catch (error) {
        throw toGroupTopologyConfigRepositoryCorruption(
            storageKey,
            error instanceof Error ? error.message : 'Stored topology config mutation key is invalid'
        );
    }
}
