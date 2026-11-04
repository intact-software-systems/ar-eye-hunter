import type { ALAckAlgo } from '../../al-contracts/al-policy.ts';
import { isALLogicalReceiptMode } from '../../al-contracts/validate-al-ack-support.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import { Either } from '../../resilience/Either.ts';
import { resolveRoomObservationDenial } from '../rtc-room-snapshot-admission.ts';
import { computeGrantedSubscribeHolders } from './compute-granted-subscribe-holders.ts';

export interface RtcRepairTargetAdmissionInput {
    /** The responder's cached snapshot of the message's room; `null` when it holds none. */
    readonly snapshot: GroupSnapshot | null;
    /** The audience the origin froze and signed. */
    readonly frozenRecipientPeerIds: readonly string[];
    readonly targetPeerId: string;
    readonly topicId: string;
    /** The receipt the repair tracks; `none` when it tracks none. */
    readonly receiptMode: ALAckAlgo;
    readonly nowEpochMs: number;
}

/** Why a responder serves a granted publication's repair to no copy for a target. */
export interface RtcRepairTargetRefusal {
    readonly kind: 'no-authority' | 'outside-frozen-audience' | 'no-subscribe-grant';
}

/**
 * A responder repairs a granted publication toward a recipient only if its origin froze it and its live session's
 * principal still holds `subscribe` in the responder's own snapshot (S3-R8): a repair never widens the signed audience,
 * and a revoked subscriber gets no copy. Only a logical receipt (`receiver`, `leader`) targets recipients; under `hop`
 * or `subtree` a target is a hop, which may be a pure relay asking a copy for its subtree (R-S2c-ii-9). The receiver's
 * own admission stays the backstop for a stale responder.
 */
export function computeRtcRepairTargetAdmission(
    input: RtcRepairTargetAdmissionInput
): Either<RtcRepairTargetRefusal, 'admitted'> {
    const { snapshot, targetPeerId } = input;
    if (snapshot === null || resolveRoomObservationDenial(snapshot.group, snapshot, input.nowEpochMs) !== undefined) {
        return Either.ofLeft({ kind: 'no-authority' });
    }
    if (!isALLogicalReceiptMode(input.receiptMode)) {
        return Either.ofRight('admitted');
    }
    if (!input.frozenRecipientPeerIds.includes(targetPeerId)) {
        return Either.ofLeft({ kind: 'outside-frozen-audience' });
    }
    return computeGrantedSubscribeHolders(snapshot, input.topicId, input.nowEpochMs).has(targetPeerId)
        ? Either.ofRight('admitted')
        : Either.ofLeft({ kind: 'no-subscribe-grant' });
}
