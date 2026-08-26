import type { GroupRef } from '@shared/api/group-types.ts';

import { decodeGroupStateGroupStorageKey } from '../../../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { toGroupTopologyConfigRepositoryCorruption } from './group-topology-config-repository-contracts.ts';

export interface GroupTopologyRefExpectation {
    readonly actual: GroupRef;
    readonly expected: GroupRef;
    readonly storageKey: string;
    readonly slot: string;
}

export function decodeGroupTopologyStorageKey(storageKey: string): GroupRef {
    try {
        return decodeGroupStateGroupStorageKey(storageKey);
    }
    catch (error) {
        throw toGroupTopologyConfigRepositoryCorruption(
            storageKey,
            error instanceof Error ? error.message : 'Stored topology config group key is invalid'
        );
    }
}

export function assertGroupTopologyRef(input: GroupTopologyRefExpectation): void {
    if (!isSameGroupTopologyRef(input.actual, input.expected)) {
        throw toGroupTopologyConfigRepositoryCorruption(
            input.storageKey,
            `Stored topology config identity differs from the ${input.slot}`
        );
    }
}

function isSameGroupTopologyRef(left: GroupRef, right: GroupRef): boolean {
    return (
        left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId
    );
}
