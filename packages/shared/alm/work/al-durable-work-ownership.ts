import { ObservableLatestValue } from '../../cache/ObservableLatestValue.ts';
import type { ObservableValue } from '../../cache/RepositoryInterfaces.ts';
import type { ALWorkCommittedRows } from './al-work-readiness-memory.ts';

/** The rows one runtime of a session committed to a durable work type, for the runtime that drains it. */
export interface ALDurableWorkCommit {
    /** One store namespace and carrier name the same work type in every runtime of the session. */
    readonly workType: string;
    readonly rows: ALWorkCommittedRows;
}

/**
 * Which runtime of a session drains the session's durable work. Every runtime admits; only the owner
 * runs work batches, and a runtime that is not the owner announces each commit to the one that is.
 */
export interface ALDurableWorkOwnership {
    /** Turns true at most once and never back: an owner keeps the work until its runtimes are disposed. */
    readonly owned: ObservableValue<boolean>;
    isOwned(): boolean;
    announceCommit(commit: ALDurableWorkCommit): void;
    /**
     * The owner's lane of `workType` hears every commit another runtime announced for it. A runtime
     * hears nothing while it does not own the work, so no commit is announced twice.
     */
    onForeignCommit(workType: string, listener: (rows: ALWorkCommittedRows) => void): () => void;
}

/** One durable lane's place in its session's ownership: the work type its commits are announced under. */
export interface ALDurableWorkLaneOwnership {
    readonly ownership: ALDurableWorkOwnership;
    readonly workType: string;
}

/**
 * The ownership of a runtime whose durable store no other runtime drains: the server's, Node's, and a
 * browser's without the Locks API. It owns its work from construction, so nothing is ever announced.
 */
export const ALWAYS_OWNED_AL_DURABLE_WORK: ALDurableWorkOwnership = {
    owned: new ObservableLatestValue<boolean>().set(true),
    isOwned: () => true,
    announceCommit: () => undefined,
    onForeignCommit: () => () => undefined
};

/** A lane without a session ownership (a memory lane) owns its work from construction. */
export function toALDurableWorkLaneOwnership(
    ownership: ALDurableWorkOwnership | undefined,
    workType: string
): ALDurableWorkLaneOwnership | undefined {
    return ownership === undefined ? undefined : { ownership, workType };
}
