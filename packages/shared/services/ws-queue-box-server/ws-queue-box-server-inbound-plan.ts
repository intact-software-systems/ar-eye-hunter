import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { isALUnicastAddressedTo } from '../../al-contracts/is-al-unicast-addressed-to.ts';
import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import { AppTopics } from '../../api/api-config.ts';

export interface ToWsQueueBoxServerInboundPlanInput {
    readonly plan: ALMessageHandlingPlan;
    readonly message: ALMessage;
    readonly source: ALInboundMessageRuntime.Source;
    readonly serverPeerId: string;
    /** False when the service relays room-scoped messages itself (`forwardsRoomScopedMessages`). */
    readonly routerOwnsRoomFanout: boolean;
}

/**
 * The WS server's own changes to the plan of a message its router admitted to a room audience. A room unicast to
 * another session is the router's to deliver (Q4): the server receives it locally and plans its own ACK as for any
 * message it receives. A `receiver` message the server aggregates withholds that ACK, because the receipt speaks for
 * the audience; a message addressed to the server itself keeps it and opens no aggregate (D57 as applied).
 */
export function toWsQueueBoxServerInboundPlan(
    input: ToWsQueueBoxServerInboundPlanInput
): ALMessageHandlingPlan {
    const { source } = input;
    if (
        source.kind === 'ws-client' && input.message.route.topicId === AppTopics.rtcSignaling &&
        input.message.payload.typeId === AppTopics.rtcSignaling && input.plan.dropReason === undefined &&
        input.plan.effective.delivery.algo === 'best-effort'
    ) {
        return {
            ...input.plan,
            localDelivery: { ...input.plan.localDelivery, enabled: !input.plan.localDelivery.deferred },
            forwarding: { enabled: false, nextHopPeerIds: [], persist: false }
        };
    }
    if (source.kind !== 'ws-client' || source.groupRecipientPeerIds === undefined) {
        return input.plan;
    }
    const plan = toRouterDeliveredPlan(input);
    const aggregated = plan.ack.algo === 'receiver' &&
        !isALUnicastAddressedTo(input.message, input.serverPeerId);
    return aggregated
        ? { ...plan, ack: { enabled: false, algo: plan.ack.algo, deferred: false } }
        : plan;
}

function toRouterDeliveredPlan(input: ToWsQueueBoxServerInboundPlanInput): ALMessageHandlingPlan {
    const { plan, message } = input;
    const routerDelivers = input.routerOwnsRoomFanout && message.targets?.mode === 'unicast' &&
        !isALUnicastAddressedTo(message, input.serverPeerId) && plan.dropReasonCode === undefined;
    return routerDelivers
        ? {
            ...plan,
            localDelivery: { ...plan.localDelivery, enabled: !plan.localDelivery.deferred },
            ack: {
                ...plan.ack,
                enabled: plan.ack.algo !== 'none' && plan.ack.toPeerId !== undefined
            }
        }
        : plan;
}
