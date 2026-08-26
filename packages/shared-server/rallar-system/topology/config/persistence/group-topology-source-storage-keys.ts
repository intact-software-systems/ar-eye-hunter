import type { GroupRef } from '@shared/api/group-types.ts';

import { groupStateGroupStorageKey } from '../../../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import type { GroupTopologyConfigGenerationTarget } from '../mutation/group-topology-config-mutation-contracts.ts';

export function groupTopologyConfigStorageKey(ref: GroupRef): string {
    return groupStateGroupStorageKey(ref);
}

export function groupTopologyOverrideStorageKey(ref: GroupRef): string {
    return groupStateGroupStorageKey(ref);
}

export function groupTopologyGenerationSourceStorageKey(
    ref: GroupRef,
    target: GroupTopologyConfigGenerationTarget
): string {
    return target === 'config'
        ? groupTopologyConfigStorageKey(ref)
        : groupTopologyOverrideStorageKey(ref);
}
