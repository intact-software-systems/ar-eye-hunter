import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import type { GroupSystemCommandPort } from '@shared-server/rallar-system/group-state/inbox/group-system-command-submission.ts';
import { toApplyPlannedLayoutCommand } from '@shared-server/rallar-system/group-state/to-apply-planned-layout-command.ts';
import { decodeTopologyPromotionWork } from '@shared-server/rallar-system/group-state/topology-promotion-outbox-entry.ts';

export interface TopologyPromotionWorkHandlerOptions {
    readonly topologyPublication: GroupSystemCommandPort;
    readonly nowEpochMs: () => number;
}

/**
 * Consumes the durable promotion request the planned-publication transaction
 * committed and enqueues the route-less applyPlannedLayout command. The
 * command id spells the same fence the entry carries, so at-least-once
 * delivery converges on one promotion: replays are inbox replays, a fence
 * the slot's newer plan dominates promotes that plan, and any other
 * superseded fence is a typed rejection at compute.
 */
export function createTopologyPromotionWorkHandler(
    options: TopologyPromotionWorkHandlerOptions
): OnMessageCallback {
    return {
        onMessage: async (message, entry) => {
            const work = decodeTopologyPromotionWork(entry.resource);
            await options.topologyPublication.submitCommand({
                command: toApplyPlannedLayoutCommand({
                    groupRef: work.groupRef,
                    formationEpoch: work.formationEpoch,
                    expectedLayout: work.expectedLayout
                }),
                atEpochMs: options.nowEpochMs(),
                traceId: message.id.traceId
            });
        }
    };
}
