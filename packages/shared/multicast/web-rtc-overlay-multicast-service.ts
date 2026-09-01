import { ALMessage } from '../al-contracts/al-contract.ts';
import { ALQosNormalizationInput, planALMessageHandling } from '../al-contracts/al-policy.ts';
import { PeerId } from '../api/api-config.ts';
import { readGroupMemberSessionIds } from '../api/group-client-views.ts';
import { WebRtcConnectionService } from '../services/web-rtc-connection-service.ts';
import {
    OverlayMulticastDispatchPlan,
    OverlayMulticasterContext,
    WebRtcOverlayMulticaster
} from './OverlayMulticastContracts.ts';

export class WebRtcOverlayMulticastService implements WebRtcOverlayMulticaster {
    public readonly overlayId: string;
    public readonly connectionService: WebRtcConnectionService;

    constructor(
        overlayId: string,
        connectionService: WebRtcConnectionService
    ) {
        this.overlayId = overlayId;
        this.connectionService = connectionService;
    }

    createOriginatingPlan(
        msg: ALMessage,
        context: OverlayMulticasterContext,
        input?: Omit<ALQosNormalizationInput, 'nowMs' | 'live'>
    ): OverlayMulticastDispatchPlan {
        const handlingPlan = this.buildHandlingPlan(msg, context, undefined, input);

        return {
            handlingPlan,
            transportMessages: this.prepareTransportReadyCopies(
                msg,
                handlingPlan.forwarding.nextHopPeerIds,
                false
            )
        };
    }

    createForwardingPlan(
        msg: ALMessage,
        context: OverlayMulticasterContext,
        fromPeerId?: PeerId,
        input?: Omit<ALQosNormalizationInput, 'nowMs' | 'live'>
    ): OverlayMulticastDispatchPlan {
        const handlingPlan = this.buildHandlingPlan(msg, context, fromPeerId, input);

        return {
            handlingPlan,
            transportMessages: this.prepareTransportReadyCopies(
                msg,
                handlingPlan.forwarding.nextHopPeerIds,
                true
            )
        };
    }

    private buildHandlingPlan(
        msg: ALMessage,
        context: OverlayMulticasterContext,
        fromPeerId?: PeerId,
        input?: Omit<ALQosNormalizationInput, 'nowMs' | 'live'>
    ) {
        return planALMessageHandling(
            msg,
            {
                selfPeerId: this.connectionService.input.sessionId,
                fromPeerId,
                connectedPeerIds: this.connectionService.readyPeerIdsForLane(),
                groupMemberPeerIds: readGroupMemberSessionIds(context.room),
                overlayNeighborPeerIds: context.overlay.nextHopSessionIds
            },
            input
        );
    }

    private prepareTransportReadyCopies(
        msg: ALMessage,
        nextHopPeerIds: readonly PeerId[],
        isForward: boolean
    ): readonly ALMessage[] {
        const nextVisitedPeerIds = isForward
            ? this.appendVisitedPeerId(
                msg.diagnostics?.visitedPeerIds ?? [],
                this.connectionService.input.sessionId
            )
            : (msg.diagnostics?.visitedPeerIds ?? []);

        const nextTtlHops = isForward && msg.constraints?.ttlHops !== undefined
            ? msg.constraints.ttlHops - 1
            : msg.constraints?.ttlHops;

        return nextHopPeerIds.map((peerId) => ({
            ...msg,
            forwarding: {
                ...msg.forwarding,
                overlayId: msg.forwarding?.overlayId ?? this.overlayId,
                nextHopPeerIds: [peerId]
            },
            constraints: msg.constraints
                ? {
                    ...msg.constraints,
                    ttlHops: nextTtlHops
                }
                : msg.constraints,
            diagnostics: {
                ...msg.diagnostics,
                visitedPeerIds: nextVisitedPeerIds
            }
        }));
    }

    private appendVisitedPeerId(
        visitedPeerIds: readonly PeerId[],
        selfPeerId: PeerId
    ): readonly PeerId[] {
        if (visitedPeerIds.includes(selfPeerId)) {
            return visitedPeerIds;
        }

        return [...visitedPeerIds, selfPeerId];
    }
}
