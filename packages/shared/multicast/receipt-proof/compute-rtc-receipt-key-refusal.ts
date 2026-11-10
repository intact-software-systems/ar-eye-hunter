import { readALTargetGroupRef, type ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALFrozenMulticastAudience } from '../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALQosEffectivePolicy } from '../../al-contracts/al-policy.ts';
import { resolveALCountedRecipientPeerIds } from '../../alm/delivery/resolve-al-counted-recipient-peer-ids.ts';
import type { ALOutboundDispatchPlan } from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../../alm/outbound/al-outbound-transport-message.ts';
import { resolveLiveRoomSession } from '../../api/group-presence/resolve-live-room-session.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import { Either } from '../../resilience/Either.ts';
import { toUnfrozenRoomMessage } from '../to-unfrozen-room-message.ts';

export interface ComputeRtcReceiptKeyRefusalInput {
    readonly msg: ALMessage;
    readonly original: ALMessage;
    readonly effective: ALQosEffectivePolicy;
    readonly room: GroupSnapshot | undefined;
    readonly canVerify: boolean;
    readonly storedSend: boolean;
    readonly nowMs: number;
}

/**
 * The origin counts a `receiver` or `leader` recipient only on that session's signature, verified against the key it
 * froze for that recipient when it froze the audience. A leg whose page cannot verify, that counts a live session the
 * room names with no registered key, or that addresses a unicast whose message names no room, could never complete:
 * it is refused as unsupported before admission, the refusal a fallback carrier takes over. A counted session the room does not name live is absent, not
 * keyless: it is left to the planner's verdict. A send whose named room has no cached snapshot yet is not judged, nor
 * one that counts nobody, which is complete at admission.
 *
 * Only a message's first dispatch is judged, as only it states the keys its sent row keeps: a first admission or a
 * hand-over (a non-stored stage) of any target mode, and the stored plan that freezes a multicast's audience, which
 * names its counted recipients for the first time. A stored plan of an audience frozen before, or of a unicast, is
 * left alone.
 */
export function computeRtcReceiptKeyRefusal(
    input: ComputeRtcReceiptKeyRefusalInput
): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
    const { msg, room } = input;
    const counted = isRtcFirstDispatch(input)
        ? resolveALCountedRecipientPeerIds(msg, input.effective.ack.algo)
        : undefined;
    if (
        counted === undefined || counted.length === 0 || (room === undefined && readALTargetGroupRef(msg) !== undefined)
    ) {
        return Either.ofRight(msg);
    }
    const dropReason = resolveRtcReceiptKeyRefusalReason(input, counted);
    return dropReason === undefined ? Either.ofRight(msg) : Either.ofLeft(toRtcReceiptKeyRefusal(input, dropReason));
}

function isRtcFirstDispatch(input: ComputeRtcReceiptKeyRefusalInput): boolean {
    return !input.storedSend || (resolveALFrozenMulticastAudience(input.original.targets) === undefined &&
        resolveALFrozenMulticastAudience(input.msg.targets) !== undefined);
}

function resolveRtcReceiptKeyRefusalReason(
    input: ComputeRtcReceiptKeyRefusalInput,
    counted: readonly string[]
): string | undefined {
    const { room, nowMs } = input;
    if (!input.canVerify) {
        return 'RTC receipt cannot be verified: this page holds no WebCrypto';
    }
    if (room === undefined) {
        return 'RTC receipt cannot be verified: the message names no room to key its addressee';
    }
    const keyless = counted.filter((peerId) => resolveLiveRoomSession(room, peerId, nowMs)?.publicationKey === null);
    return keyless.length === 0
        ? undefined
        : `RTC receipt cannot be verified: ${keyless.length} of ${counted.length} counted recipients registered no publication key`;
}

function toRtcReceiptKeyRefusal(
    input: ComputeRtcReceiptKeyRefusalInput,
    dropReason: string
): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    return {
        msg: toUnfrozenRoomMessage(input.msg, input.original),
        dropReason,
        dropReasonCode: 'unsupported',
        lane: 'volatile',
        preparedMessages: []
    };
}
