import type { GroupStateSnapshotChange } from './group-state-snapshots-repository.ts';

/** Receives each change of what a runtime's group cache holds, after the cache write. */
export type GroupStateSnapshotChangeSink = (change: GroupStateSnapshotChange) => void;

export function createPassThroughGroupStateSnapshotChangeSink(): GroupStateSnapshotChangeSink {
    return () => {};
}
