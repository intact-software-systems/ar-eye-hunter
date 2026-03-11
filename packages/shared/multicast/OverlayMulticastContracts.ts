import { ALMessage } from '../al-contracts/al-contract.ts';
import { ALMessageHandlingPlan, ALQosNormalizationInput } from '../al-contracts/al-policy.ts';
import { OverlayId, OverlayInfo, PeerId } from '../api/api-config.ts';
import type { AnyGroupPresence } from '../api/group-client-views.ts';

export type OverlayMulticasterContext = Readonly<{
    overlayId: OverlayId;
    room: AnyGroupPresence;
    overlay: OverlayInfo;
}>;

export type OverlayMulticastDispatchPlan = Readonly<{
    handlingPlan: ALMessageHandlingPlan;
    transportMessages: readonly ALMessage[];
}>;

export interface WebRtcOverlayMulticaster {
    readonly overlayId: OverlayId;

    createOriginatingPlan(
        msg: ALMessage,
        context: OverlayMulticasterContext,
        input?: Omit<ALQosNormalizationInput, 'nowMs' | 'live'>,
    ): OverlayMulticastDispatchPlan;

    createForwardingPlan(
        msg: ALMessage,
        context: OverlayMulticasterContext,
        fromPeerId?: PeerId,
        input?: Omit<ALQosNormalizationInput, 'nowMs' | 'live'>,
    ): OverlayMulticastDispatchPlan;
}

export type WebRtcOverlayMulticasterFactory = (
    overlayId: OverlayId,
) => WebRtcOverlayMulticaster;
