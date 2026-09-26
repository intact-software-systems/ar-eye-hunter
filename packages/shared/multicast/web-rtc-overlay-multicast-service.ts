import type { ALMessage } from '../al-contracts/al-contract.ts';
import { planALMessageHandling, type ALQosNormalizationInput } from '../al-contracts/al-policy.ts';
import type { PeerId } from '../api/api-config.ts';
import type { WebRtcConnectionService } from '../services/web-rtc-connection-service.ts';
import type {
    OverlayMulticastDispatchPlan,
    OverlayMulticasterContext,
    OverlayMulticastForwarding,
    WebRtcOverlayMulticaster
} from './overlay-multicast-contracts.ts';
import { computeRtcRoomSnapshotAdmission, toRtcRoomSnapshotHandlingPlan } from './rtc-room-snapshot-admission.ts';
import { toRtcTransportVisitedPeerIds } from './to-rtc-transport-visited-peer-ids.ts';

export class WebRtcOverlayMulticastService implements WebRtcOverlayMulticaster {
    public readonly overlayId: string;
    public readonly connectionService: WebRtcConnectionService;

    constructor(overlayId: string, connectionService: WebRtcConnectionService) {
        this.overlayId = overlayId;
        this.connectionService = connectionService;
    }

    createOriginatingPlan(
        msg: ALMessage,
        context: OverlayMulticasterContext,
        qos?: ALQosNormalizationInput
    ): OverlayMulticastDispatchPlan {
        return this.createDispatchPlan(msg, context, { fromPeerId: undefined, qos });
    }

    createForwardingPlan(
        msg: ALMessage,
        context: OverlayMulticasterContext,
        forwarding: OverlayMulticastForwarding
    ): OverlayMulticastDispatchPlan {
        return this.createDispatchPlan(msg, context, forwarding);
    }

    private createDispatchPlan(
        msg: ALMessage,
        context: OverlayMulticasterContext,
        forwarding: OverlayMulticastForwarding
    ): OverlayMulticastDispatchPlan {
        const selfPeerId = this.connectionService.input.sessionId;
        const admission = computeRtcRoomSnapshotAdmission({
            message: msg,
            snapshot: context.room,
            overlay: context.overlay,
            selfPeerId,
            fromPeerId: forwarding.fromPeerId,
            recipientPeerId: undefined,
            nowMs: context.nowMs
        });
        const policyMessage = forwarding.fromPeerId === undefined ? msg : {
            ...msg,
            forwarding: { ...msg.forwarding, nextHopPeerIds: undefined }
        };
        const plan = planALMessageHandling(policyMessage, {
            nowMs: context.nowMs,
            selfPeerId,
            fromPeerId: forwarding.fromPeerId,
            connectedPeerIds: this.connectionService.readyPeerIdsForLane(),
            groupMemberPeerIds: admission.kind === 'authorized' ? admission.memberPeerIds : [],
            overlayNeighborPeerIds: admission.kind === 'authorized' ? admission.forwardingPeerIds : []
        }, forwarding.qos);
        const handlingPlan = toRtcRoomSnapshotHandlingPlan(plan, admission, forwarding.fromPeerId);
        return {
            handlingPlan,
            transportMessages: handlingPlan.dropReason
                ? []
                : this.toTransportCopies(
                    msg,
                    handlingPlan.forwarding.nextHopPeerIds,
                    forwarding.fromPeerId !== undefined
                )
        };
    }

    private toTransportCopies(
        msg: ALMessage,
        nextHopPeerIds: readonly PeerId[],
        isForward: boolean
    ): readonly ALMessage[] {
        const visitedPeerIds = toRtcTransportVisitedPeerIds({
            visitedPeerIds: msg.diagnostics?.visitedPeerIds,
            selfPeerId: this.connectionService.input.sessionId,
            nextHopPeerIds
        });
        const ttlHops = isForward && msg.constraints?.ttlHops !== undefined
            ? msg.constraints.ttlHops - 1
            : msg.constraints?.ttlHops;
        return nextHopPeerIds.map((peerId) => ({
            ...msg,
            forwarding: { ...msg.forwarding, overlayId: this.overlayId, nextHopPeerIds: [peerId] },
            constraints: msg.constraints ? { ...msg.constraints, ttlHops } : msg.constraints,
            diagnostics: { ...msg.diagnostics, visitedPeerIds }
        }));
    }
}
