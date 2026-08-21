import {
    rebindDistributedRunsFromSelectionIndex,
    type ControlSnapshotSelectionIndex
} from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import type { ControlDistributedRunSnapshot, ControlServerSnapshot } from './control-run-manager.ts';

export type IndexedBoardRun = Readonly<{
    run: ControlDistributedRunSnapshot;
    ordinal: number;
    position: number;
}>;

export function projectRelevantControlAgentBoardRuns(
    input: Readonly<{
        index: ControlSnapshotSelectionIndex;
        snapshot: ControlServerSnapshot;
        controlRunId: string;
        selected: ControlDistributedRunSnapshot | undefined;
        selectedOrdinal: number | undefined;
    }>
): readonly IndexedBoardRun[] | undefined {
    const projected: IndexedBoardRun[] = [];
    const activeOrdinals = input.index.activeDistributedRunOrdinalsByControlRunId
        .get(input.controlRunId) ?? [];
    for (const ordinal of activeOrdinals) {
        const distributedRunId = input.index.distributedRunIdsByOrdinal[ordinal];
        if (
            distributedRunId === undefined ||
            input.index.boardSourceWinnerOrdinalByDistributedRunId
                    .get(distributedRunId) !== ordinal
        ) {
            continue;
        }
        const current = rebindDistributedRunsFromSelectionIndex(
            input.index,
            input.snapshot,
            [ordinal]
        )[0];
        if (!current) {
            return undefined;
        }
        projected.push({
            run: current,
            ordinal,
            position: input.index.boardFirstInsertionOrdinalByDistributedRunId
                .get(distributedRunId) ?? ordinal
        });
    }

    if (input.selected) {
        const selectedIndex = projected.findIndex((indexedRun) =>
            indexedRun.run.distributedRunId === input.selected!.distributedRunId
        );
        if (selectedIndex >= 0) {
            projected.splice(selectedIndex, 1);
        }
        if (input.selected.controlRunId === input.controlRunId) {
            if (input.selectedOrdinal === undefined) {
                return undefined;
            }
            projected.push({
                run: input.selected,
                ordinal: input.selectedOrdinal,
                position: input.index.boardFirstInsertionOrdinalByDistributedRunId
                    .get(input.selected.distributedRunId) ??
                    input.index.distributedRunIdsByOrdinal.length
            });
        }
    }
    projected.sort((left, right) => left.position - right.position);
    return projected;
}
