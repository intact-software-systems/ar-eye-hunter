import { readALTargetGroupRef, type ALMessage } from '../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../al-contracts/al-policy.ts';
import { isSameGroupRef } from '../api/api-type-utils.ts';
import type { GroupSnapshot } from '../api/group-types.ts';

export interface RtcRoomSnapshotAdmissionInput {
    readonly message: ALMessage;
    readonly plan: ALMessageHandlingPlan;
    readonly snapshot: GroupSnapshot | undefined;
    readonly fromPeerId: string | undefined;
    readonly nowMs: number;
}

export function planRtcRoomSnapshotAdmission(input: RtcRoomSnapshotAdmissionInput): ALMessageHandlingPlan {
    if (
        input.plan.dropReason !== undefined || input.fromPeerId === undefined ||
        isRtcRoomSnapshotCurrent(input.message, input.snapshot, input.nowMs)
    ) {
        return input.plan;
    }

    return {
        ...input.plan,
        dropReason: 'not-yet-in-sync',
        localDelivery: { enabled: false, persist: false, deferred: false },
        forwarding: { enabled: false, persist: false, nextHopPeerIds: [] },
        ack: { enabled: false, algo: 'none', deferred: false },
        nack: {
            enabled: true,
            toPeerId: input.fromPeerId,
            reason: 'not-yet-in-sync',
            missingSeqs: []
        },
        repair: { enabled: false, algo: 'none' }
    };
}

export function isRtcRoomSnapshotCurrent(
    message: ALMessage,
    snapshot: GroupSnapshot | undefined,
    nowMs: number
): boolean {
    const targets = message.targets;
    if (
        !targets || targets.mode === 'unicast' ||
        (targets.mode === 'broadcast' && targets.scope !== 'room') || targets.minSnapshotVersion === undefined
    ) {
        return true;
    }
    const groupRef = readALTargetGroupRef(message);
    const group = snapshot?.group;
    return groupRef !== undefined && group !== undefined &&
        isSameGroupRef(group, groupRef) && group.status === 'active' &&
        (group.expiresAtEpochMs === null || group.expiresAtEpochMs > nowMs) &&
        group.snapshotVersion >= targets.minSnapshotVersion;
}
