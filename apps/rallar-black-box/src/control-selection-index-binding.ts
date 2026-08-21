import type { ControlSnapshotSelectionIndex } from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import type { ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';

const boundIndexesBySnapshot = new WeakMap<ControlServerSnapshot, WeakSet<ControlSnapshotSelectionIndex>>();

/** Associates an immutable poll snapshot with topology proven for its exact bytes. */
export function bindControlSelectionIndexToSnapshot(
    snapshot: ControlServerSnapshot,
    index: ControlSnapshotSelectionIndex
): ControlSnapshotSelectionIndex {
    let boundIndexes = boundIndexesBySnapshot.get(snapshot);
    if (!boundIndexes) {
        boundIndexes = new WeakSet<ControlSnapshotSelectionIndex>();
        boundIndexesBySnapshot.set(snapshot, boundIndexes);
    }
    boundIndexes.add(index);
    return index;
}

export function isControlSelectionIndexBoundToSnapshot(
    snapshot: ControlServerSnapshot,
    index: ControlSnapshotSelectionIndex
): boolean {
    return boundIndexesBySnapshot.get(snapshot)?.has(index) === true;
}
