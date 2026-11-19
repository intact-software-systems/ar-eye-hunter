import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';
import type {
    ALOutboundCommitBundle,
    ALOutboundRepairReadDto
} from '../admission/al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from '../admission/al-outbound-admission-validation.ts';
import { toALOutboundEndReceiptBundle } from '../control/to-al-outbound-end-receipt-bundle.ts';
import type { ALOutboundFirstHopWaitSnapshot } from '../first-hop/compute-al-outbound-first-hop-wait.ts';
import {
    toALOutboundAckTimeoutEffectId,
    toALOutboundFirstHopTimeoutEffectId
} from '../to-al-outbound-effect-id.ts';

export interface ALOutboundMessageEndInput {
    readonly senderId: string;
    readonly msgId: string;
    /**
     * The row the end marks; undefined for a message this sender dequeues without having admitted it, which holds no
     * row: every later path works from that row, so there is nothing to mark.
     */
    readonly stored: ALStoredOutboundMessage | undefined;
    readonly expectedVersion: number | undefined;
    /** The open receipt the end deletes with its timer; undefined when none is open. */
    readonly openReceipt: ALOutboundPendingAckSnapshot | undefined;
    readonly firstHopWait: ALOutboundFirstHopWaitSnapshot | undefined;
}

/**
 * The commit that states a terminal settlement ends everything the sender holds for the message: its receipt and
 * repair count, its first-hop wait, their timers, and the stored row is marked ended under the sender's fence.
 */
export function toALOutboundMessageEndBundle<TPrepared>(
    input: ALOutboundMessageEndInput
): ALOutboundCommitBundle<TPrepared> {
    const { msgId, stored, openReceipt, firstHopWait } = input;
    const receiptEnd = toALOutboundEndReceiptBundle<TPrepared>(input.senderId, msgId, input.expectedVersion);
    return {
        ...receiptEnd,
        mutations: [
            ...receiptEnd.mutations,
            ...(stored === undefined ? [] : [{ kind: 'end-sent-message', stored } as const]),
            ...(firstHopWait === undefined ? [] : [{ kind: 'delete-first-hop-wait', msgId } as const])
        ],
        endedTimeoutEffectIds: [
            ...(openReceipt === undefined ? [] : [toALOutboundAckTimeoutEffectId(openReceipt)]),
            ...(firstHopWait === undefined ? [] : [toALOutboundFirstHopTimeoutEffectId(firstHopWait)])
        ]
    };
}

/** What a dispatch or repair read holds of the message its commit ends: both reads name these alike. */
export type ALOutboundMessageEndRead = Pick<
    ALOutboundRepairReadDto<never>,
    'storedMessage' | 'clientRecord' | 'pendingAck' | 'firstHopWait'
>;

/** The end of `msg` as a read holds it, fenced on the sender version that read saw. */
export function toALOutboundReadMessageEndBundle<TPrepared>(
    msg: ALMessage,
    read: ALOutboundMessageEndRead
): ALOutboundCommitBundle<TPrepared> {
    return toALOutboundMessageEndBundle({
        senderId: msg.id.senderId,
        msgId: msg.id.msgId,
        stored: read.storedMessage,
        expectedVersion: read.clientRecord?.version,
        openReceipt: read.pendingAck,
        firstHopWait: read.firstHopWait
    });
}
