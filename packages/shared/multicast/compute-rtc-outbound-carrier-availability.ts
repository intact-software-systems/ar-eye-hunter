import { readALTargetGroupRef, type ALMessage } from '../al-contracts/al-contract.ts';
import {
    resolveALFrozenMulticastAudience,
    toALFrozenMulticastMessage
} from '../al-contracts/al-frozen-multicast-audience.ts';
import type { ALMessageHandlingPlan } from '../al-contracts/al-policy.ts';
import type { ALOutboundMessageRuntime } from '../alm/outbound/al-outbound-message-runtime.ts';
import { isOverlayForGroupRef } from '../api/api-type-utils.ts';
import { isAcceptedRoomLayoutOverlay } from '../repository/is-accepted-room-layout-overlay.ts';
import type { OverlayMulticasterContext } from './overlay-multicast-contracts.ts';
import type { RtcOutboundObservation } from './read-rtc-outbound-observation.ts';
import {
    computeRtcRoomSnapshotAdmission,
    type RtcRoomSnapshotAdmission
} from './rtc-room-snapshot-admission.ts';
import { computeFrozenAudience } from './web-rtc-overlay-frozen-audience.ts';

export type RtcCarrierGapAdmission = 'hand-over' | 'hold';

export interface ComputeRtcOutboundCarrierAvailabilityInput {
    readonly message: ALMessage;
    readonly observation: RtcOutboundObservation;
    readonly selfPeerId: string;
}

/**
 * Whether the RTC carrier can take an origin message now. Only an explicitly foreign or removed overlay, or
 * the room authority's own refusal, refuses it; every other missing or stale observation is a carrier gap.
 */
export type RtcOutboundCarrierAvailability =
    | Readonly<{
        kind: 'available';
        admission: Extract<RtcRoomSnapshotAdmission, { kind: 'authorized' | 'not-room'; }>;
        context: OverlayMulticasterContext | undefined;
    }>
    | Readonly<{ kind: 'unavailable'; reason: string; admission: RtcRoomSnapshotAdmission; }>
    | Extract<RtcRoomSnapshotAdmission, { kind: 'pending' | 'unauthorized'; }>;

export function computeRtcOutboundCarrierAvailability(
    input: ComputeRtcOutboundCarrierAvailabilityInput
): RtcOutboundCarrierAvailability {
    const { message, observation } = input;
    const groupRef = readALTargetGroupRef(message);
    const overlay = observation.overlay;
    if (
        groupRef && overlay &&
        (overlay.state !== 'active' || !isOverlayForGroupRef(overlay, groupRef))
    ) {
        return {
            kind: 'unauthorized',
            cause: 'authority-rejected',
            reason: 'RTC selected topology is explicitly inactive or foreign'
        };
    }
    const admission = computeRtcRoomSnapshotAdmission({
        message,
        snapshot: observation.room,
        overlay,
        selfPeerId: input.selfPeerId,
        fromPeerId: undefined,
        recipientPeerId: undefined,
        nowMs: observation.nowMs
    });
    const context = toAcceptedOverlayContext(observation);
    if (admission.kind === 'unauthorized' || admission.kind === 'not-room') {
        return admission.kind === 'unauthorized'
            ? admission
            : { kind: 'available', admission, context };
    }
    const gap = resolveRtcCarrierGap(observation, context);
    if (gap !== undefined) {
        return { kind: 'unavailable', reason: gap, admission };
    }
    return admission.kind === 'pending' ? admission : { kind: 'available', admission, context };
}

export function toAcceptedOverlayContext(
    observation: RtcOutboundObservation
): OverlayMulticasterContext | undefined {
    const { overlayId, room, overlay, nowMs } = observation;
    return overlayId && room && isAcceptedRoomLayoutOverlay(overlay, room.group)
        ? { overlayId, room, overlay, nowMs }
        : undefined;
}

export function toRtcCarrierGapFrozenMessage(
    message: ALMessage,
    availability: RtcOutboundCarrierAvailability,
    selfPeerId: string
): ALMessage | undefined {
    if (
        availability.kind !== 'unavailable' || availability.admission.kind !== 'authorized' ||
        message.id.senderId !== selfPeerId || message.targets?.mode !== 'multicast' ||
        resolveALFrozenMulticastAudience(message.targets) !== undefined
    ) {
        return undefined;
    }
    return toALFrozenMulticastMessage(
        message,
        computeFrozenAudience({ admission: availability.admission, selfPeerId })
    );
}

export interface IsRtcCarrierGapHeldInput {
    readonly message: ALMessage;
    /** The room authority the gap observed; recipients are unknown unless it authorized the room. */
    readonly admission: RtcRoomSnapshotAdmission;
    readonly handling: ALMessageHandlingPlan;
    readonly selfPeerId: string;
}

export function isRtcCarrierGapHeld(input: IsRtcCarrierGapHeldInput): boolean {
    const { message, handling } = input;
    const recipientsKnown = input.admission.kind === 'authorized';
    return message.id.senderId === input.selfPeerId &&
        readALTargetGroupRef(message) !== undefined &&
        !(message.targets?.mode === 'broadcast' &&
            message.targets.recipientPeerIds !== undefined) &&
        !handling.dropReason && handling.forwarding.persist &&
        (!recipientsKnown || handling.forwarding.nextHopPeerIds.length > 0);
}

export function isRtcCarrierGapHandedOver(
    message: ALMessage,
    carrierGap: RtcCarrierGapAdmission
): boolean {
    return carrierGap === 'hand-over' && message.targets !== undefined &&
        message.targets.mode !== 'unicast';
}

export interface ToRtcHeldMessageAuthorityInput {
    readonly message: ALMessage;
    /** A dequeued message the carrier held before it had copies to prepare. */
    readonly heldWithoutCopies: boolean;
    readonly admissions: readonly RtcRoomSnapshotAdmission[];
}

export function toRtcHeldMessageAuthority(
    input: ToRtcHeldMessageAuthorityInput
): ALOutboundMessageRuntime.PendingAdmissionAuthority {
    if (
        input.heldWithoutCopies &&
        resolveALFrozenMulticastAudience(input.message.targets)?.recipientPeerIds.length === 0
    ) {
        return { status: 'authorized' };
    }
    const denial = input.admissions.find((admission) =>
        admission.kind === 'pending' || admission.kind === 'unauthorized'
    );
    if (denial?.kind === 'pending') {
        return { status: 'not-ready', reason: denial.reason, retryAfterMs: 50 };
    }
    return denial?.kind === 'unauthorized'
        ? { status: 'rejected', reason: denial.reason }
        : { status: 'authorized' };
}

function resolveRtcCarrierGap(
    observation: RtcOutboundObservation,
    context: OverlayMulticasterContext | undefined
): string | undefined {
    const room = observation.room;
    if (!room) {
        return 'RTC room authority is not observed yet';
    }
    const identity = room.group.acceptedLayoutIdentity;
    if (room.group.transportState !== 'flowing') {
        return 'RTC room transport is halted';
    }
    if (!identity || identity.state !== 'active') {
        return 'RTC room has no accepted layout';
    }
    return context === undefined
        ? 'RTC room has no cached overlay that is its exact accepted layout'
        : undefined;
}
