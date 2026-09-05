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

export interface ALOrderingObservation {
    readonly status: ALOrderingObservationStatus;
    readonly trackKey?: string;
    readonly seq?: number;
    readonly expectedSeq?: number;
    readonly lastContiguousSeq?: number;
    readonly missingSeqs: readonly number[];
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

    return `${orderingKey}:${msg.id.senderId}:${msg.ordering?.epoch ?? 0}`;
}
