import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    resolveALFrozenMulticastAudience,
    toALFrozenMulticastMessage,
    type ALFrozenMulticastAudience
} from '../al-contracts/al-frozen-multicast-audience.ts';
import type { ALOutboundDispatchPlan } from '../alm/outbound/al-outbound-message-runtime.ts';
import { readGroupMemberSessionIds } from '../api/group-client-views.ts';
import type { GroupSnapshot } from '../api/group-types.ts';

export interface ComputeFrozenAudienceInput {
    readonly room: GroupSnapshot;
    readonly selfPeerId: string;
}

/** Every session of the identified room snapshot except the origin, pinned on that snapshot's version (D26). */
export function computeFrozenAudience(input: ComputeFrozenAudienceInput): ALFrozenMulticastAudience {
    return {
        recipientPeerIds: readGroupMemberSessionIds(input.room).filter((peerId) => peerId !== input.selfPeerId),
        snapshotVersion: input.room.group.snapshotVersion
    };
}

/**
 * The origin freezes its own room multicast once, at the first plan that has the room snapshot: a message
 * that already carries its audience keeps it on every later attempt, whatever the room has become since.
 */
export function toRtcOriginFrozenMessage(
    message: ALMessage,
    room: GroupSnapshot | undefined,
    selfPeerId: string
): ALMessage {
    if (
        room === undefined || message.id.senderId !== selfPeerId || message.targets?.mode !== 'multicast' ||
        resolveALFrozenMulticastAudience(message.targets) !== undefined
    ) {
        return message;
    }
    return toALFrozenMulticastMessage(message, computeFrozenAudience({ room, selfPeerId }));
}

/**
 * Under `receiver` the origin's receipt counts the frozen logical recipients, not the next hops a plan
 * reaches, so every plan of its own frozen multicast expects exactly that audience. `hop` and `subtree`
 * keep the next hops, and a relay's row stays on its hops.
 */
export function toRtcFrozenAudienceDispatchPlan<TPrepared>(
    plan: ALOutboundDispatchPlan<TPrepared>,
    selfPeerId: string
): ALOutboundDispatchPlan<TPrepared> {
    const frozen = resolveALFrozenMulticastAudience(plan.msg.targets);
    if (plan.ackTracking?.mode !== 'receiver' || frozen === undefined || plan.msg.id.senderId !== selfPeerId) {
        return plan;
    }
    return { ...plan, ackTracking: { ...plan.ackTracking, expectedPeerIds: frozen.recipientPeerIds } };
}
