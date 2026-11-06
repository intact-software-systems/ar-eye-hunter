import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import type { ALOutboundCommitBundle, ALOutboundSentPositions } from '../admission/al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from '../admission/al-outbound-admission-validation.ts';

/** The sequences one dequeued batch claimed, by track key. */
export type ALOrderingBatchSequences = ReadonlyMap<string, ReadonlySet<number>>;

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

/**
 * Whether a durable row admitted to an audience still has to record its recipients' positions: unexpired and not yet
 * recorded. Its successor on the track waits for it unless the same batch claimed both, so positions are written in
 * sequence order and "last sent" keeps its meaning.
 */
export function isALOutboundRowUnrecorded(stored: ALStoredOutboundMessage, nowMs: number): boolean {
    return stored.sentPositions === null && stored.policy.persist && stored.policy.admittedAudience !== undefined &&
        stored.reference.expiresAtMs > nowMs;
}

/**
 * Whether a tracked row's predecessor (`seq - 1` of its track) is claimed in the same batch: the batch admits the two
 * in sequence order and chains their positions, so the row follows it there and is never held for it.
 */
export function isALOrderingPredecessorInBatch(message: ALMessage, batch: ALOrderingBatchSequences): boolean {
    const trackKey = toALOrderingTrackKey(message);
    const seq = message.ordering?.seq;
    return trackKey !== undefined && seq !== undefined && batch.get(trackKey)?.has(seq - 1) === true;
}

/** The sequences the messages claim, by track key; an absent or untracked message claims none. */
export function toALOrderingBatchSequences(messages: readonly (ALMessage | undefined)[]): ALOrderingBatchSequences {
    const batch = new Map<string, Set<number>>();
    for (const message of messages) {
        const trackKey = message === undefined ? undefined : toALOrderingTrackKey(message);
        const seq = message?.ordering?.seq;
        if (trackKey !== undefined && seq !== undefined) {
            batch.set(trackKey, new Set([...(batch.get(trackKey) ?? []), seq]));
        }
    }
    return batch;
}

/** A dispatch of a dequeued batch, and whether its carrier admits it only behind its batch predecessor. */
export interface ALOutboundBatchFollowerCandidate {
    readonly msg: ALMessage;
    readonly followsBatchPredecessor: boolean;
}

/**
 * Whether a dispatch that follows its batch predecessor is left to the next pass: its predecessor is not among the
 * messages admitted ahead of it, so committing it now would record positions out of sequence order.
 */
export function isALOutboundLeftBehindPredecessor(
    dispatch: ALOutboundBatchFollowerCandidate,
    admittedAhead: readonly ALMessage[]
): boolean {
    return dispatch.followsBatchPredecessor &&
        !isALOrderingPredecessorInBatch(dispatch.msg, toALOrderingBatchSequences(admittedAhead));
}

/** The dispatches left to the next pass: each that follows a batch predecessor not admitted ahead of it. */
export function toALOutboundLeftBehindPredecessors<T extends ALOutboundBatchFollowerCandidate>(
    dispatches: readonly T[]
): ReadonlySet<T> {
    const admittedAhead: ALMessage[] = [];
    const left = new Set<T>();
    for (const dispatch of toALOutboundFollowerOrder(dispatches, (candidate) => candidate)) {
        if (isALOutboundLeftBehindPredecessor(dispatch, admittedAhead)) {
            left.add(dispatch);
        }
        else {
            admittedAhead.push(dispatch.msg);
        }
    }
    return left;
}

/**
 * The items with the members of each track that holds a follower by ascending sequence, in the places that track's
 * members hold, so a follower comes after its predecessor; every other item, and one without a candidate (no message),
 * keeps its place.
 */
export function toALOutboundFollowerOrder<T>(
    items: readonly T[],
    toCandidate: (item: T) => ALOutboundBatchFollowerCandidate | undefined
): readonly T[] {
    const toTrackKey = (item: T) => {
        const candidate = toCandidate(item);
        return candidate === undefined ? undefined : toALOrderingTrackKey(candidate.msg);
    };
    const followedTracks = new Set(
        items.flatMap((item) => toCandidate(item)?.followsBatchPredecessor === true ? toTrackKey(item) ?? [] : [])
    );
    const toSeq = (item: T) => toCandidate(item)?.msg.ordering?.seq ?? 0;
    const ascendingByTrack = new Map<string | undefined, T[]>([...followedTracks].map((trackKey) => [
        trackKey,
        items.filter((item) => toTrackKey(item) === trackKey).toSorted((left, right) => toSeq(left) - toSeq(right))
    ]));
    return items.map((item) => ascendingByTrack.get(toTrackKey(item))?.shift() ?? item);
}

/** The indexes of the members that record positions, by ascending sequence. */
function toSequenceOrder(reads: readonly ALOutboundGroupMemberRead[]): readonly number[] {
    return reads.flatMap((read, index) => read.sentPositions === undefined ? [] : [index])
        .sort((left, right) => reads[left]!.sentPositions!.seq - reads[right]!.sentPositions!.seq);
}

/**
 * The group's bundles with each `(namespace, track, recipient)` position row written once: at the highest sequence it
 * reaches.
 */
export function toALOutboundGroupPositionWrites<TPrepared>(
    bundles: readonly ALOutboundCommitBundle<TPrepared>[]
): readonly ALOutboundCommitBundle<TPrepared>[] {
    const highest = new Map<string, number>();
    for (const mutation of bundles.flatMap((bundle) => bundle.mutations)) {
        if (mutation.kind === 'set-sent-position') {
            const rowKey = JSON.stringify([mutation.namespace, mutation.trackKey, mutation.recipientPeerId]);
            highest.set(rowKey, Math.max(highest.get(rowKey) ?? 0, mutation.seq));
        }
    }
    return bundles.map((bundle) => ({
        ...bundle,
        mutations: bundle.mutations.filter((mutation) =>
            mutation.kind !== 'set-sent-position' ||
            highest.get(JSON.stringify([mutation.namespace, mutation.trackKey, mutation.recipientPeerId])) ===
                mutation.seq
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
