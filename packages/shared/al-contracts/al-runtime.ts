import type { ALMessage } from './al-contract.ts';

export interface ALReadyable {
    ready(): Promise<void>;
}

export type ALOrderingObservationStatus =
    | 'untracked'
    | 'in-order'
    | 'gap'
    | 'resync-required'
    | 'duplicate'
    | 'stale';

/** An inclusive run of ordering sequences, `from <= to`; the unit a receiver asks a sender to repair. */
export interface ALSeqRange {
    readonly from: number;
    readonly to: number;
}

export interface ALOrderingObservation {
    readonly status: ALOrderingObservationStatus;
    readonly trackKey?: string;
    readonly seq?: number;
    readonly expectedSeq?: number;
    readonly lastContiguousSeq?: number;
    /** Sorted, disjoint; the sequences between `expectedSeq` and `seq` that neither arrived nor are buffered. */
    readonly missingRanges: readonly ALSeqRange[];
    readonly releasableSeqs: readonly number[];
}

export interface ALSupersedenceInput {
    readonly key?: string;
    readonly msgId: string;
    readonly replacesMsgId?: string;
    readonly seq?: number;
    readonly ts: number;
}

export type ALSupersedenceObservationStatus =
    | 'untracked'
    | 'current'
    | 'superseded'
    | 'replaces-current';

export interface ALSupersedenceObservation {
    readonly status: ALSupersedenceObservationStatus;
    readonly key?: string;
    readonly latestMsgId?: string;
    readonly replacesMsgId?: string;
}

export interface ALOrderingTrackSnapshot {
    readonly lastContiguousSeq: number;
    readonly bufferedSeqs: readonly number[];
    readonly updatedAtMs: number;
}

export type ALSupersedencePersistenceValue =
    | Readonly<{
        kind: 'latest';
        latestMsgId: string;
        latestSeq?: number;
        latestTs: number;
        updatedAtMs: number;
    }>
    | Readonly<{
        kind: 'replacement';
        byMsgId: string;
        updatedAtMs: number;
    }>;

export function toALOrderingTrackKey(msg: ALMessage): string | undefined {
    const orderingKey = msg.ordering?.orderingKey;
    const seq = msg.ordering?.seq;

    if (orderingKey === undefined || seq === undefined) {
        return undefined;
    }

    return toTrackKey(orderingKey, msg);
}

/** The track a message names a key on but no sequence for: the WS server's outbound mints the next one there. */
export function toALSequenceMintTrackKey(msg: ALMessage): string | undefined {
    const orderingKey = msg.ordering?.orderingKey;

    if (orderingKey === undefined || msg.ordering?.seq !== undefined) {
        return undefined;
    }

    return toTrackKey(orderingKey, msg);
}

/**
 * The candidate as the original would compare to it: a sequence minted on the track its original named
 * without one is removed, so a minted copy matches its request while a copy that changes the key, the epoch
 * or a stated sequence still differs.
 */
export function toALSequenceMintComparableMessage(original: ALMessage, candidate: ALMessage): ALMessage {
    if (
        toALSequenceMintTrackKey(original) === undefined || candidate.ordering?.seq === undefined ||
        toALOrderingTrackKey(candidate) !== toALSequenceMintTrackKey(original)
    ) {
        return candidate;
    }
    const { seq: _seq, ...ordering } = candidate.ordering;
    return { ...candidate, ordering };
}

function toTrackKey(orderingKey: string, msg: ALMessage): string {
    return `${orderingKey}:${msg.id.senderId}:${msg.ordering?.epoch ?? 0}`;
}
