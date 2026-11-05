import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALOutboundCommitBundle, ALOutboundSentPositions } from '../admission/al-outbound-admission-store.ts';

/** What chaining reads of a group member's read: its positions, and whether its admission stamped its copy. */
export interface ALOutboundGroupMemberRead {
    readonly storedMessage: object | undefined;
    readonly originalMsg: ALMessage;
    readonly msg: ALMessage;
    readonly sentPositions: ALOutboundSentPositions | undefined;
}

/**
 * The members' reads of one commit group, each recorded position taken past what a member at an earlier sequence of the
 * same track sends that recipient, as one-by-one commits in sequence order would have read it: a group never skips a
 * recipient for a row it holds itself, whatever order its rows were claimed in, and positions move forward only.
 * Undefined when a member whose read stamped its copy would read differently: its stamped (and possibly signed) record
 * cannot change, so the group commits its members one by one.
 */
export function computeALOutboundGroupChainedReads<TRead extends ALOutboundGroupMemberRead>(
    reads: readonly TRead[]
): readonly TRead[] | undefined {
    const reached = new Map<string, number>();
    const chained = [...reads];
    for (const index of toSequenceOrder(reads)) {
        const read = reads[index]!;
        const positions = read.sentPositions!;
        const priorSeqByRecipient = computeChainedPriorSeqs(positions, reached);
        if (isALOutboundStampedRead(read) && !samePositions(priorSeqByRecipient, positions.priorSeqByRecipient)) {
            return undefined;
        }
        chained[index] = { ...read, sentPositions: { ...positions, priorSeqByRecipient } };
    }
    return chained;
}

/** The indexes of the members that record positions, by ascending sequence. */
function toSequenceOrder(reads: readonly ALOutboundGroupMemberRead[]): readonly number[] {
    return reads.flatMap((read, index) => read.sentPositions === undefined ? [] : [index])
        .sort((left, right) => reads[left]!.sentPositions!.seq - reads[right]!.sentPositions!.seq);
}

/** The group's bundles with each `(track, recipient)` position row written once: at the highest sequence it reaches. */
export function toALOutboundGroupPositionWrites<TPrepared>(
    bundles: readonly ALOutboundCommitBundle<TPrepared>[]
): readonly ALOutboundCommitBundle<TPrepared>[] {
    const highest = new Map<string, number>();
    for (const mutation of bundles.flatMap((bundle) => bundle.mutations)) {
        if (mutation.kind === 'set-sent-position') {
            const rowKey = JSON.stringify([mutation.trackKey, mutation.recipientPeerId]);
            highest.set(rowKey, Math.max(highest.get(rowKey) ?? 0, mutation.seq));
        }
    }
    return bundles.map((bundle) => ({
        ...bundle,
        mutations: bundle.mutations.filter((mutation) =>
            mutation.kind !== 'set-sent-position' ||
            highest.get(JSON.stringify([mutation.trackKey, mutation.recipientPeerId])) === mutation.seq
        )
    }));
}

/** Each recipient's prior: its read position, or the sequence an earlier member sends it when that is further. */
function computeChainedPriorSeqs(
    positions: ALOutboundSentPositions,
    reached: Map<string, number>
): Readonly<Record<string, number>> {
    return Object.fromEntries(
        Object.entries(positions.priorSeqByRecipient).map(([recipientPeerId, readSeq]) => {
            const rowKey = JSON.stringify([positions.trackKey, recipientPeerId]);
            const priorSeq = Math.max(readSeq, reached.get(rowKey) ?? 0);
            if (priorSeq < positions.seq) {
                reached.set(rowKey, positions.seq);
            }
            return [recipientPeerId, priorSeq];
        })
    );
}

/** A first admission that stamped its record on its copy. */
function isALOutboundStampedRead(read: ALOutboundGroupMemberRead): boolean {
    return read.storedMessage === undefined && read.originalMsg.ordering?.priorSeqByRecipient === undefined &&
        read.msg.ordering?.priorSeqByRecipient !== undefined;
}

function samePositions(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
    return Object.entries(left).every(([recipientPeerId, seq]) => right[recipientPeerId] === seq);
}
