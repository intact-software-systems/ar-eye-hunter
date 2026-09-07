import type { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan, ALQosNormalizationInput } from '../al-contracts/al-policy.ts';
import type { OverlayId, OverlayInfo, PeerId } from '../api/api-config.ts';
import type { GroupSnapshot } from '../api/group-types.ts';

export interface OverlayMulticasterContext {
    readonly overlayId: OverlayId;
    readonly room: GroupSnapshot;
    readonly overlay: OverlayInfo;
    readonly nowMs: number;
}

export interface OverlayMulticastDispatchPlan {
    readonly handlingPlan: ALMessageHandlingPlan;
    readonly transportMessages: readonly ALMessage[];
}

export interface OverlayMulticastForwarding {
    readonly fromPeerId: PeerId | undefined;
    readonly qos: ALQosNormalizationInput | undefined;
}

export interface WebRtcOverlayMulticaster {
    readonly overlayId: OverlayId;

    createOriginatingPlan(
        msg: ALMessage,
        context: OverlayMulticasterContext,
        input?: ALQosNormalizationInput
    ): OverlayMulticastDispatchPlan;

    createForwardingPlan(
        msg: ALMessage,
        context: OverlayMulticasterContext,
        forwarding: OverlayMulticastForwarding
    ): OverlayMulticastDispatchPlan;
}

export type WebRtcOverlayMulticasterFactory = (
    overlayId: OverlayId
) => WebRtcOverlayMulticaster;
