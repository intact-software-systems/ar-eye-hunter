import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import { decodeActivationStatusClockWork } from '@shared-server/rallar-system/group-state/activation-status-clock-outbox-entry.ts';
import type { GroupTopologyPlanningService } from '../../planning/group-topology-planning-service.ts';
import {
    petitionGroupActivationStatus,
    type GroupActivationStatusPort
} from './group-activation-status-observer.ts';

export interface ActivationStatusClockWorkHandlerOptions {
    readonly activationStatus: GroupActivationStatusPort;
    readonly topologyPlanning: Pick<GroupTopologyPlanningService, 'readTopologyPlanningAuthority'>;
    readonly findGroupSnapshotByRef: (ref: GroupRef) => Promise<GroupSnapshot | null>;
    readonly readPlannedTopology: (ref: GroupRef) => Promise<RallarOverlayTopologySnapshot | null>;
}

/**
 * The dwell clock coming due. It re-reads rather than replaying what the arming
 * observed, because the dwell asks whether the band *still* holds -- a group
 * that recovered inside the window must publish nothing.
 *
 * Staleness needs no check of its own (product decision 19: "a stale entry is
 * a drop"). The petition resolves the basis from current state, so a series the
 * group has left resolves a different basis and the action comes back `none`;
 * and even a command that escapes that is fenced at compute on epoch and basis.
 */
export function createActivationStatusClockWorkHandler(
    options: ActivationStatusClockWorkHandlerOptions
): OnMessageCallback {
    return {
        onMessage: async (_message: ALMessage, entry: ResourceEntry) => {
            const work = decodeActivationStatusClockWork(entry.resource);
            const snapshot = await options.findGroupSnapshotByRef(work.groupRef);
            if (snapshot === null) {
                return;
            }
            const [authority, planned] = await Promise.all([
                options.topologyPlanning.readTopologyPlanningAuthority({
                    groupRef: work.groupRef,
                    knownGroup: snapshot,
                    snapshotSelection: 'prefer-current'
                }),
                options.readPlannedTopology(work.groupRef)
            ]);
            await petitionGroupActivationStatus(
                { activationStatus: options.activationStatus },
                authority,
                planned,
                // Only the dwell leg confirms a band. The expiry heartbeat just
                // asks the group to look again, so it reads as an ordinary
                // evidence petition -- which is what lets a decayed group arm
                // its dwell instead of publishing an unconfirmed band.
                work.kind === 'dwell' ? { satisfied: true, dueAtEpochMs: work.dueAtEpochMs } : null
            );
        }
    };
}
