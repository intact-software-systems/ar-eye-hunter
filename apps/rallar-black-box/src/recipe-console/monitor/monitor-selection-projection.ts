import type {
    ControlDistributedRunSnapshot,
    ControlServerSnapshot,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    rebindDistributedRunFromSelectionIndex,
    rebindDistributedRunsFromSelectionIndex,
    type ControlSnapshotSelectionIndex,
} from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import { isControlSelectionIndexBoundToSnapshot } from
    '../../control-selection-index-binding.ts';
import type {
    MonitorDistributedRunSelection,
    MonitorSelectionIndexWork,
} from './monitor-selection.ts';
import {
    compareMonitorUpdatedRuns,
    deriveLegacyMonitorDistributedRunSelection,
    deriveLegacyMonitorRunOptions,
    unavailableMonitorSelection,
} from './monitor-selection-legacy.ts';

export type MonitorDistributedRunSelectionInput = Readonly<{
    controlRunId?: string;
    requestedDistributedRunId?: string;
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    distributedRunsAuthoritative: boolean;
    snapshot?: ControlServerSnapshot;
    selectionIndex?: ControlSnapshotSelectionIndex;
}>;

export type MonitorRunOptionsInput = Readonly<{
    controlRunId?: string;
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    lastKnown?: ControlDistributedRunSnapshot;
    snapshot?: ControlServerSnapshot;
    selectionIndex?: ControlSnapshotSelectionIndex;
}>;

const workByDistributedSelection =
    new WeakMap<object, MonitorSelectionIndexWork>();
const workByRunOptions = new WeakMap<object, MonitorSelectionIndexWork>();

export function deriveMonitorDistributedRunSelectionProjection(
    input: MonitorDistributedRunSelectionInput,
): MonitorDistributedRunSelection {
    const prepared = prepareIndex(input);
    if (prepared.kind === 'legacy') {
        return publishDistributedSelection(
            deriveLegacyMonitorDistributedRunSelection(input),
            false,
            prepared.fallback,
        );
    }
    const { index, snapshot } = prepared;
    const fallback = () => publishDistributedSelection(
        deriveLegacyMonitorDistributedRunSelection(input),
        false,
        true,
    );

    if (input.requestedDistributedRunId) {
        const hasCandidate = index.firstDistributedRunOrdinalById.has(
            input.requestedDistributedRunId,
        );
        const candidate = hasCandidate
            ? rebindDistributedRunFromSelectionIndex(
                index,
                snapshot,
                input.requestedDistributedRunId,
            )
            : undefined;
        if (hasCandidate && !candidate) return fallback();
        const run = candidate?.controlRunId === input.controlRunId
            ? candidate
            : undefined;
        return publishDistributedSelection(run
            ? {
                distributedRunId: input.requestedDistributedRunId,
                run,
                source: 'explicit',
            }
            : unavailableMonitorSelection(input, candidate), true, false);
    }

    const ordinals = input.controlRunId
        ? index.distributedRunOrdinalsByControlRunId.get(input.controlRunId) ?? []
        : [];
    if (input.distributedRunsAuthoritative && ordinals.length === 1) {
        const compatible = rebindDistributedRunsFromSelectionIndex(
            index,
            snapshot,
            ordinals,
        );
        if (compatible.length !== 1) return fallback();
        const run = compatible[0]!;
        return publishDistributedSelection({
            distributedRunId: run.distributedRunId,
            run,
            source: 'sole-compatible',
            urlReplacePatch: { distributedRunId: run.distributedRunId },
        }, true, false);
    }
    if (ordinals.length > 1) {
        return publishDistributedSelection({
            distributedRunId: undefined,
            run: undefined,
            source: 'none',
            issue: {
                code: 'ambiguous',
                message: 'Multiple compatible distributed runs are available; select one explicitly.',
            },
        }, true, false);
    }
    return publishDistributedSelection({
        distributedRunId: undefined,
        run: undefined,
        source: 'none',
    }, true, false);
}

export function deriveMonitorRunOptionsProjection(
    input: MonitorRunOptionsInput,
): readonly ControlDistributedRunSnapshot[] {
    const prepared = prepareIndex(input);
    if (input.controlRunId === undefined) {
        return publishRunOptions(
            input.lastKnown ? [input.lastKnown] : [],
            prepared.kind === 'indexed',
            prepared.kind === 'legacy' && prepared.fallback,
        );
    }
    if (prepared.kind === 'legacy') {
        return publishRunOptions(
            deriveLegacyMonitorRunOptions(input),
            false,
            prepared.fallback,
        );
    }
    const { index, snapshot } = prepared;
    const fallback = () => publishRunOptions(
        deriveLegacyMonitorRunOptions(input),
        false,
        true,
    );
    const ordinals = index.distributedRunOrdinalsByControlRunIdUpdatedDesc
        .get(input.controlRunId) ?? [];
    const options = rebindDistributedRunsFromSelectionIndex(
        index,
        snapshot,
        ordinals,
    );
    if (options.length !== ordinals.length || !isUpdatedRunOrder(options)) {
        return fallback();
    }
    const lastKnown = input.lastKnown;
    const exactPairIsCurrent = lastKnown !== undefined &&
        index.firstDistributedRunOrdinalByIdAndControlRunId
            .get(lastKnown.distributedRunId)?.has(input.controlRunId) === true;
    if (!lastKnown || exactPairIsCurrent) {
        return publishRunOptions(options, true, false);
    }
    return publishRunOptions(
        [...options, lastKnown].sort(compareMonitorUpdatedRuns),
        true,
        false,
    );
}

export function monitorDistributedSelectionWork(
    selection: MonitorDistributedRunSelection,
): MonitorSelectionIndexWork | undefined {
    return workByDistributedSelection.get(selection);
}

export function monitorOptionsWork(
    options: readonly ControlDistributedRunSnapshot[],
): MonitorSelectionIndexWork | undefined {
    return workByRunOptions.get(options);
}

type PreparedIndex =
    | Readonly<{ kind: 'legacy'; fallback: boolean }>
    | Readonly<{
        kind: 'indexed';
        index: ControlSnapshotSelectionIndex;
        snapshot: ControlServerSnapshot;
    }>;

function prepareIndex(input: Readonly<{
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    snapshot?: ControlServerSnapshot;
    selectionIndex?: ControlSnapshotSelectionIndex;
}>): PreparedIndex {
    if (!input.snapshot || !input.selectionIndex) {
        return { kind: 'legacy', fallback: false };
    }
    const collectionMatches =
        input.snapshot.distributedRuns === input.distributedRuns ||
        input.snapshot.distributedRuns === undefined && input.distributedRuns.length === 0;
    if (
        !collectionMatches ||
        !isControlSelectionIndexBoundToSnapshot(input.snapshot, input.selectionIndex)
    ) {
        return { kind: 'legacy', fallback: true };
    }
    return {
        kind: 'indexed',
        index: input.selectionIndex,
        snapshot: input.snapshot,
    };
}

function publishDistributedSelection(
    selection: MonitorDistributedRunSelection,
    indexed: boolean,
    fallback: boolean,
): MonitorDistributedRunSelection {
    workByDistributedSelection.set(selection, Object.freeze({ indexed, fallback }));
    return selection;
}

function publishRunOptions(
    options: readonly ControlDistributedRunSnapshot[],
    indexed: boolean,
    fallback: boolean,
): readonly ControlDistributedRunSnapshot[] {
    workByRunOptions.set(options, Object.freeze({ indexed, fallback }));
    return options;
}

function isUpdatedRunOrder(runs: readonly ControlDistributedRunSnapshot[]): boolean {
    for (let ordinal = 1; ordinal < runs.length; ordinal += 1) {
        if (
            compareMonitorUpdatedRuns(runs[ordinal - 1]!, runs[ordinal]!) > 0
        ) return false;
    }
    return true;
}
