import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';

const MAX_STATE_SNAPSHOT_READ_ATTEMPTS = 3;

export class StateSnapshotReadConflictError extends Error {
    readonly status = 503;
    readonly code = 'state-snapshot-read-conflict';

    readonly snapshotKey: string;

    constructor(snapshotKey: string) {
        super(`State snapshot changed during ${MAX_STATE_SNAPSHOT_READ_ATTEMPTS} read attempts: ${snapshotKey}`);
        this.snapshotKey = snapshotKey;
        this.name = 'StateSnapshotReadConflictError';
    }
}

export async function readStableStateSnapshot<Aggregate, ChildA, ChildB, Snapshot>(
    options: Readonly<{
        snapshotKey: string;
        readAggregate(): Promise<RuntimeStateEntryValue<Aggregate> | undefined>;
        readChildren(): Promise<readonly [readonly ChildA[], ChildB]>;
        assemble(
            aggregate: RuntimeStateEntryValue<Aggregate>,
            childA: readonly ChildA[],
            childB: ChildB
        ): Snapshot;
    }>
): Promise<Snapshot | undefined> {
    for (let attempt = 0; attempt < MAX_STATE_SNAPSHOT_READ_ATTEMPTS; attempt += 1) {
        const before = await options.readAggregate();
        if (!before) {
            return undefined;
        }

        const [childA, childB] = await options.readChildren();
        const after = await options.readAggregate();
        if (!after) {
            return undefined;
        }
        if (after.entry.revision === before.entry.revision) {
            return options.assemble(after, childA, childB);
        }
    }

    throw new StateSnapshotReadConflictError(options.snapshotKey);
}
