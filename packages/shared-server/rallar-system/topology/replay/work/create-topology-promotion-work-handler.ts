import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';

import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { toApplyPlannedLayoutCommand } from '@shared-server/rallar-system/group-state/to-apply-planned-layout-command.ts';
import { decodeTopologyPromotionWork } from '@shared-server/rallar-system/group-state/topology-promotion-outbox-entry.ts';

export interface TopologyPromotionWorkHandlerOptions {
    readonly submitCommand: (command: GroupMutationCommand, atEpochMs: number) => Promise<void>;
    readonly nowEpochMs: () => number;
}

/**
 * Consumes the durable promotion request the planned-publication transaction
 * committed and enqueues the route-less applyPlannedLayout command. The
 * command id spells the same fence the entry carries, so at-least-once
 * delivery converges on one promotion: replays are inbox replays and a
 * superseded fence is a typed rejection at compute.
 */
export function createTopologyPromotionWorkHandler(
    options: TopologyPromotionWorkHandlerOptions
): OnMessageCallback {
    return {
        onMessage: async (_message: ALMessage, entry: ResourceEntry) => {
            const work = decodeTopologyPromotionWork(entry.resource);
            await options.submitCommand(
                toApplyPlannedLayoutCommand({
                    groupRef: work.groupRef,
                    formationEpoch: work.formationEpoch,
                    expectedLayout: work.expectedLayout
                }),
                options.nowEpochMs()
            );
        }
    };
}
