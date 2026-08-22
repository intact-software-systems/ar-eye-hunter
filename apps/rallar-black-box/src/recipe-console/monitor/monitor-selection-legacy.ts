import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { MonitorDistributedRunSelectionInput, MonitorRunOptionsInput } from './monitor-selection-projection.ts';
import type { MonitorDistributedRunSelection } from './monitor-selection.ts';

export function deriveLegacyMonitorDistributedRunSelection(
    input: MonitorDistributedRunSelectionInput
): MonitorDistributedRunSelection {
    if (input.requestedDistributedRunId) {
        const candidate = input.distributedRuns.find((run) => run.distributedRunId === input.requestedDistributedRunId);
        const run = candidate?.controlRunId === input.controlRunId
            ? candidate
            : undefined;
        return run
            ? {
                distributedRunId: input.requestedDistributedRunId,
                run,
                source: 'explicit'
            }
            : unavailableMonitorSelection(input, candidate);
    }
    const compatible = input.controlRunId
        ? input.distributedRuns.filter((run) => run.controlRunId === input.controlRunId)
        : [];
    if (input.distributedRunsAuthoritative && compatible.length === 1) {
        const run = compatible[0]!;
        return {
            distributedRunId: run.distributedRunId,
            run,
            source: 'sole-compatible',
            urlReplacePatch: { distributedRunId: run.distributedRunId }
        };
    }
    return compatible.length > 1
        ? {
            distributedRunId: undefined,
            run: undefined,
            source: 'none',
            issue: {
                code: 'ambiguous',
                message: 'Multiple compatible distributed runs are available; select one explicitly.'
            }
        }
        : { distributedRunId: undefined, run: undefined, source: 'none' };
}

export function unavailableMonitorSelection(
    input: MonitorDistributedRunSelectionInput,
    candidate: ControlDistributedRunSnapshot | undefined
): MonitorDistributedRunSelection {
    return {
        distributedRunId: input.requestedDistributedRunId,
        run: undefined,
        source: 'explicit',
        issue: !input.distributedRunsAuthoritative
            ? undefined
            : candidate
            ? {
                code: 'incompatible',
                message: `Distributed run ${input.requestedDistributedRunId} belongs to another control run.`
            }
            : {
                code: 'unavailable',
                message:
                    `Distributed run ${input.requestedDistributedRunId} is not available in the selected control run.`
            }
    };
}

export function deriveLegacyMonitorRunOptions(
    input: MonitorRunOptionsInput
): readonly ControlDistributedRunSnapshot[] {
    const options = input.distributedRuns
        .filter((run) => run.controlRunId === input.controlRunId)
        .sort(compareMonitorUpdatedRuns);
    const lastKnown = input.lastKnown;
    if (!lastKnown || options.some((run) => run.distributedRunId === lastKnown.distributedRunId)) {
        return options;
    }
    return [...options, lastKnown].sort(compareMonitorUpdatedRuns);
}

export function compareMonitorUpdatedRuns(
    left: ControlDistributedRunSnapshot,
    right: ControlDistributedRunSnapshot
): number {
    return right.updatedAtEpochMs - left.updatedAtEpochMs ||
        left.distributedRunId.localeCompare(right.distributedRunId);
}
