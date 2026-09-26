import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    resolveALFrozenMulticastAudience,
    type ALFrozenMulticastAudience
} from '../al-contracts/al-frozen-multicast-audience.ts';
import type { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest
} from '../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../alm/outbound/al-outbound-transport-message.ts';
import type { OverlayTree } from '../alm/outbound/transition-al-outbound-pending-ack.ts';

export interface OverlayRepairPlan {
    readonly nextHopPeerIds: readonly string[];
}

export interface ComputeMissingRecipientRepairInput {
    readonly frozen: readonly string[];
    readonly confirmed: readonly string[];
    readonly tree: OverlayTree;
}

export interface PlanRtcFailedPeerRepairInput {
    readonly msg: ALMessage;
    readonly request: ALOutboundRepairRequest;
    readonly selfPeerId: string;
    readonly planOutgoingMessage: (msg: ALMessage) => RtcDispatchPlan;
}

type RtcDispatchPlan = ALOutboundDispatchPlan<ALOutboundTransportMessage>;

interface RtcMissingRecipientRepairInput {
    readonly outgoing: RtcDispatchPlan;
    readonly ackTracking: ALOutboundAckTrackingPlan;
    readonly request: ALOutboundRepairRequest;
    readonly frozen: ALFrozenMulticastAudience;
}

/**
 * The next hops a retry still owes (D25): a missing recipient that is a direct hop, and every hop whose
 * subtree has not completed, since a missing recipient may sit behind it. A completed hop never gets a copy.
 */
export function computeMissingRecipientRepair(input: ComputeMissingRecipientRepairInput): OverlayRepairPlan {
    const confirmed = new Set(input.confirmed);
    const missing = new Set(input.frozen.filter((peerId) => !confirmed.has(peerId)));
    if (missing.size === 0) {
        return { nextHopPeerIds: [] };
    }
    const completed = new Set(input.tree.completedHopPeerIds);
    return {
        nextHopPeerIds: input.tree.nextHopPeerIds.filter((peerId) => missing.has(peerId) || !completed.has(peerId))
    };
}

/**
 * The retry for the peers a receipt failed. The origin of a frozen `receiver` multicast retries only the
 * missing recipients, through the tree over the current room; every other retry re-plans around the
 * failed hops through an alternate parent.
 */
export function planRtcFailedPeerRepair(input: PlanRtcFailedPeerRepairInput): RtcDispatchPlan | undefined {
    const frozen = resolveALFrozenMulticastAudience(input.msg.targets);
    const outgoing = input.request.trigger === 'ack-timeout' && frozen !== undefined &&
            input.msg.id.senderId === input.selfPeerId
        ? input.planOutgoingMessage(input.msg)
        : undefined;
    return outgoing?.ackTracking?.mode === 'receiver' && frozen !== undefined
        ? toMissingRecipientRepairPlan({ outgoing, ackTracking: outgoing.ackTracking, request: input.request, frozen })
        : planRtcAlternateParentRepair(input);
}

/** A retried copy a relay still owes: the forwarding plan narrowed to the child hops its row waits on. */
export function toRtcRetriedCopyRetransmission(
    copy: ALInboundMessageRuntime.RetriedCopy,
    forwarding: RtcDispatchPlan | undefined
): ALOutboundMessageRuntime.Retransmission<ALOutboundTransportMessage> {
    const owed = new Set(copy.toPeerIds);
    const plan: RtcDispatchPlan = forwarding === undefined
        ? {
            dropReason: `No RTC forwarding route for the retried copy of ${copy.msg.id.msgId}`,
            dropReasonCode: 'no-route',
            persist: false,
            msg: copy.msg,
            preparedMessages: []
        }
        : {
            ...forwarding,
            preparedMessages: forwarding.preparedMessages.filter((prepared) => isAddressedToAny(prepared, owed))
        };
    return { msg: plan.msg, plan, attemptIdentity: copy.attemptIdentity };
}

/**
 * A hop outside the frozen audience never reads complete here: its terminal ACK confirms no expected
 * recipient, so the origin refuses it and it never enters the ACK history. Every retry therefore resends
 * to such a hop, and the receipt retry budget alone bounds how often.
 */
function toMissingRecipientRepairPlan(input: RtcMissingRecipientRepairInput): RtcDispatchPlan | undefined {
    const { outgoing, request, frozen } = input;
    if (outgoing.dropReason) {
        return outgoing;
    }
    const failed = new Set(request.failedPeerIds);
    const repair = computeMissingRecipientRepair({
        frozen: frozen.recipientPeerIds,
        confirmed: frozen.recipientPeerIds.filter((peerId) => !failed.has(peerId)),
        tree: {
            nextHopPeerIds: outgoing.preparedMessages.flatMap((prepared) => prepared.forwarding?.nextHopPeerIds ?? []),
            completedHopPeerIds: request.completedHopPeerIds
        }
    });
    const targets = new Set(repair.nextHopPeerIds);
    const preparedMessages = outgoing.preparedMessages.filter((prepared) => isAddressedToAny(prepared, targets));
    return preparedMessages.length === 0 ? undefined : {
        ...outgoing,
        preparedMessages,
        ackTracking: { ...input.ackTracking, expectedPeerIdsUpdate: 'replace' },
        repairTracking: request.repair
    };
}

function planRtcAlternateParentRepair(input: PlanRtcFailedPeerRepairInput): RtcDispatchPlan | undefined {
    const { msg, request } = input;
    if (!msg.targets || msg.targets.mode === 'unicast') {
        return undefined;
    }
    const excludedPeerIds = new Set([...(msg.diagnostics?.visitedPeerIds ?? []), ...request.failedPeerIds]);
    const dispatchPlan = input.planOutgoingMessage({
        ...msg,
        diagnostics: { ...msg.diagnostics, visitedPeerIds: [...excludedPeerIds] }
    });
    if (dispatchPlan.preparedMessages.length === 0) {
        return undefined;
    }
    return {
        ...dispatchPlan,
        msg,
        ackTracking: dispatchPlan.ackTracking === undefined
            ? undefined
            : { ...dispatchPlan.ackTracking, expectedPeerIdsUpdate: 'replace' },
        repairTracking: request.repair
    };
}

/** A transport copy addresses exactly one next hop. */
function isAddressedToAny(prepared: ALOutboundTransportMessage, peerIds: ReadonlySet<string>): boolean {
    const nextHopPeerId = prepared.forwarding?.nextHopPeerIds?.[0];
    return nextHopPeerId !== undefined && peerIds.has(nextHopPeerId);
}
