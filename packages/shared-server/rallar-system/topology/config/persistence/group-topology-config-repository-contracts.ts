import type {
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { RuntimeStateEntry } from '../../../../runtime-state/runtime-state-repository.ts';
import type { GroupTopologyConfigGenerationTarget } from '../mutation/group-topology-config-mutation-contracts.ts';

export type GroupTopologyConfigCommitResult =
    | Readonly<{ status: 'accepted'; storageRevision: number; }>
    | Readonly<{ status: 'conflict'; }>;

export type GroupTopologyConfigDeleteResult = Readonly<{ status: 'accepted'; }> | Readonly<{ status: 'conflict'; }>;

export interface GroupTopologyConfigGenerationSource {
    readonly groupRef: GroupRef;
    readonly target: GroupTopologyConfigGenerationTarget;
    readonly version: number;
}

export interface GroupTopologyConfigGenerationSourceEntry {
    readonly entry: RuntimeStateEntry;
    readonly source: GroupTopologyConfigGenerationSource;
    readonly value: StoredGroupTopologyConfig | StoredGroupTopologyOverride;
}

export class GroupTopologyConfigRepositoryInvariantCorruptionError extends Error {
    readonly code = 'group-topology-config-repository-invariant-corruption';

    readonly storageKey: string;

    constructor(storageKey: string, message: string) {
        super(`${message}: ${storageKey}`);
        this.storageKey = storageKey;
        this.name = 'GroupTopologyConfigRepositoryInvariantCorruptionError';
    }
}

export function toGroupTopologyConfigRepositoryCorruption(
    storageKey: string,
    message: string
): GroupTopologyConfigRepositoryInvariantCorruptionError {
    return new GroupTopologyConfigRepositoryInvariantCorruptionError(storageKey, message);
}
