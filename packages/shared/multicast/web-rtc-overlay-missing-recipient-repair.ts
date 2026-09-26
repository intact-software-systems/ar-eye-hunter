import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    resolveALFrozenMulticastAudience,
    type ALFrozenMulticastAudience
} from '../al-contracts/al-frozen-multicast-audience.ts';
import type { ALAckAlgo } from '../al-contracts/al-policy.ts';
import type { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest
} from '../alm/outbound/al-outbound-message-runtime.ts';
import {
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '../alm/outbound/al-outbound-transport-message.ts';
import type { OverlayTree } from '../alm/outbound/transition-al-outbound-pending-ack.ts';
import { toRtcTransportVisitedPeerIds } from './to-rtc-transport-visited-peer-ids.ts';

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
    readonly planOutgoingMessage: (msg: ALMessage) => ALOutboundDispatchPlan<ALOutboundTransportMessage>;
}

export interface ToRtcTargetedRepairCopyInput {
    readonly dispatch: ALOutboundDispatchPlan<ALOutboundTransportMessage>;
    readonly msg: ALMessage;
    readonly peerId: string;
    readonly selfPeerId: string;
}

interface RtcMissingRecipientRepairInput {
    readonly outgoing: ALOutboundDispatchPlan<ALOutboundTransportMessage>;
    readonly ackTracking: ALOutboundAckTrackingPlan;
    readonly request: ALOutboundRepairRequest;
    readonly frozen: ALFrozenMulticastAudience;
}

/**
 * The next hops a retry still owes (D25): a missing recipient that is a direct hop, and every hop whose
 * subtree has not completed, since a missing recipient may sit behind it. A completed hop never gets a copy.
 * A hop outside the frozen audience never reads complete: its terminal ACK confirms no expected recipient,
 * so the origin refuses it and it never enters the ACK history. Every retry therefore resends to such a
 * hop, and the receipt retry budget alone bounds how often.
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
export function planRtcFailedPeerRepair(
    input: PlanRtcFailedPeerRepairInput
): ALOutboundDispatchPlan<ALOutboundTransportMessage> | undefined {
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
    forwarding: ALOutboundDispatchPlan<ALOutboundTransportMessage> | undefined
): ALOutboundMessageRuntime.Retransmission<ALOutboundTransportMessage> {
    const owed = new Set(copy.toPeerIds);
    const plan: ALOutboundDispatchPlan<ALOutboundTransportMessage> = forwarding === undefined
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
 * The copy a targeted repair resends to one peer: the copy the repaired dispatch addresses to it, so the
 * siblings of that peer stay visited and it never owns them. A peer the dispatch no longer addresses gets a
 * copy that names only the sender and itself.
 */
export function toRtcTargetedRepairCopy(input: ToRtcTargetedRepairCopyInput): ALOutboundTransportMessage {
    const { msg, peerId } = input;
    const planned = input.dispatch.preparedMessages.find((prepared) => isAddressedToAny(prepared, new Set([peerId])));
    return planned ?? toALOutboundTransportMessage({
        ...msg,
        forwarding: { ...msg.forwarding, nextHopPeerIds: [peerId] },
        diagnostics: {
            ...msg.diagnostics,
            visitedPeerIds: toRtcTransportVisitedPeerIds({
                visitedPeerIds: msg.diagnostics?.visitedPeerIds,
                selfPeerId: input.selfPeerId,
                nextHopPeerIds: [peerId]
            })
        }
    });
}

function toMissingRecipientRepairPlan(
    input: RtcMissingRecipientRepairInput
): ALOutboundDispatchPlan<ALOutboundTransportMessage> | undefined {
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

function planRtcAlternateParentRepair(
    input: PlanRtcFailedPeerRepairInput
): ALOutboundDispatchPlan<ALOutboundTransportMessage> | undefined {
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
            : {
                ...dispatchPlan.ackTracking,
                expectedPeerIdsUpdate: toRtcRetryExpectedPeerIdsUpdate(dispatchPlan.ackTracking.mode)
            },
        repairTracking: request.repair
    };
}

/**
 * A `subtree` retry, re-routed or targeted, adds its new hops and never drops an unfinished one: a new hop
 * answers only for its own part, so its completion cannot stand in for the subtree of a hop it routed
 * around (R-S2c-ii-14). Every other mode replaces the hops it expects.
 */
export function toRtcRetryExpectedPeerIdsUpdate(mode: ALAckAlgo): 'merge' | 'replace' {
    return mode === 'subtree' ? 'merge' : 'replace';
}

/** A transport copy addresses exactly one next hop. */
function isAddressedToAny(prepared: ALOutboundTransportMessage, peerIds: ReadonlySet<string>): boolean {
    const nextHopPeerId = prepared.forwarding?.nextHopPeerIds?.[0];
    return nextHopPeerId !== undefined && peerIds.has(nextHopPeerId);
}
