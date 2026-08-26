import type {
    GroupTopologyConfigMutationReceipt,
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';

import type * as mutationContracts from './group-topology-config-mutation-contracts.ts';

export interface GroupTopologyConfigMutationExecution {
    readonly receipt: GroupTopologyConfigMutationReceipt;
    readonly config?: StoredGroupTopologyConfig;
    readonly override?: StoredGroupTopologyOverride;
}

export function toTopologyConfigMutationResult(
    computed: Exclude<mutationContracts.GroupTopologyConfigMutationComputed, { outcome: 'idempotency-conflict'; }>
): GroupTopologyConfigMutationExecution {
    if (computed.result.kind === 'config') {
        return { receipt: computed.receipt, config: computed.result.config };
    }
    if (computed.result.kind === 'override') {
        return { receipt: computed.receipt, override: computed.result.override };
    }
    return { receipt: computed.receipt };
}
