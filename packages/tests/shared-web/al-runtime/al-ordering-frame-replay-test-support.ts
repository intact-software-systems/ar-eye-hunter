import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type {
    ALOrderingObservationStatus,
    ALOrderingTrackSnapshot,
    ALSeqRange
} from '@shared/al-contracts/al-runtime.ts';
import { computeALOrderingObservation } from '@shared/alm/compute-al-ordering-observation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

/** One keyed room send that states no `seq`, so its sender's outbound mints the track's next one. */
export interface KeyedRoomSendInput {
    readonly orderingKey: string;
    readonly resourceId: string;
}

export interface ALOrderingFrameReplay {
    readonly statuses: readonly ALOrderingObservationStatus[];
    readonly missingRanges: readonly ALSeqRange[];
}

export function createKeyedRoomSend(senderId: string, roomRef: GroupRef, input: KeyedRoomSendInput): ALMessage {
    return newALMulticastMessage(
        senderId,
        { topicId: 'room.reload', contextId: roomRef.groupId, resourceId: input.resourceId },
        roomRef,
        'reload.keyed',
        { resourceId: input.resourceId },
        { ttlMs: 30_000, reliability: 'at-least-once', ack: 'none', orderingKey: input.orderingKey }
    );
}

export function decodeSentOrderingSeqs(frames: readonly unknown[]): readonly number[] {
    return decodeSentFrames(frames).map((message) => {
        const seq = message.ordering?.seq;
        if (seq === undefined) {
            throw new Error(`The sent frame ${message.id.msgId} must carry its ordering seq`);
        }
        return seq;
    });
}

/** The frames as one recipient observes them in send order, each observation applied before the next. */
export function replayALOrderingObservation(frames: readonly unknown[], recipientPeerId: string): ALOrderingFrameReplay {
    let snapshot: ALOrderingTrackSnapshot | undefined;
    const statuses: ALOrderingObservationStatus[] = [];
    const missingRanges: ALSeqRange[] = [];
    for (const msg of decodeSentFrames(frames)) {
        const acceptance = computeALOrderingObservation({
            snapshot,
            msg,
            nowMs: 0,
            trackTtlMs: 60_000,
            apply: true,
            role: 'recipient',
            selfPeerId: recipientPeerId,
            bufferedPriorSeqs: {}
        });
        statuses.push(acceptance.observation.status);
        missingRanges.push(...acceptance.observation.missingRanges);
        snapshot = acceptance.nextSnapshot;
    }
    return { statuses, missingRanges };
}

function decodeSentFrames(frames: readonly unknown[]): readonly ALMessage[] {
    return frames.map((frame) => decodePersistedALMessage(String(frame)));
}
