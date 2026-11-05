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
    | 'stale'
    | 'entered'
    | 'omitted'
    | 'witnessed';

/**
 * How one admission observes a track: a `recipient` advances its position and delivers in order, a `witness` (a frozen
 * recipient that delivers nothing) only moves its position, and `none` (a peer outside the frozen audience, or a pure
 * relay) observes nothing.
 */
export type ALOrderingObserverRole = 'recipient' | 'witness' | 'none';

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
    /** The prior sequence this copy's record named for the receiver, or `seq - 1` when it listed none. */
    readonly priorSeq?: number;
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

/**
 * The prior a copy's record names for `recipientPeerId`, `seq - 1` when the record lists it not; `undefined` for a
 * copy no authority recorded.
 */
export function resolveALOrderingPriorSeq(msg: ALMessage, recipientPeerId: string): number | undefined {
    const seq = msg.ordering?.seq;
    const record = msg.ordering?.priorSeqByRecipient;
    return record === undefined || seq === undefined ? undefined : record[recipientPeerId] ?? seq - 1;
}

/** The track a message names a key on but no sequence for: the outbound owning the track mints the next one there. */
export function toALSequenceMintTrackKey(msg: ALMessage): string | undefined {
    const orderingKey = msg.ordering?.orderingKey;

    if (orderingKey === undefined || msg.ordering?.seq !== undefined) {
        return undefined;
    }

    return toTrackKey(orderingKey, msg);
}

function toTrackKey(orderingKey: string, msg: ALMessage): string {
    return `${orderingKey}:${msg.id.senderId}:${msg.ordering?.epoch ?? 0}`;
}
