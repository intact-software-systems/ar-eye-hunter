import { isDistributedRunTerminalState } from
    '@shared-test/rallar-bb-test/distributed-run.ts';
import type { ControlDistributedRunSnapshot } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { MonitorWorkspaceContext } from './monitor-workspace-state.ts';

export function compatibleMonitorMutation(
    run: ControlDistributedRunSnapshot | undefined,
    context: MonitorWorkspaceContext,
): ControlDistributedRunSnapshot | undefined {
    return run?.distributedRunId === context.distributedRunId &&
            run.controlRunId === context.controlRunId
        ? run
        : undefined;
}

export function preferMonitorMutationTruth(
    mutation: ControlDistributedRunSnapshot,
    query: ControlDistributedRunSnapshot,
): ControlDistributedRunSnapshot {
    if (mutation.updatedAtEpochMs !== query.updatedAtEpochMs) {
        return mutation.updatedAtEpochMs > query.updatedAtEpochMs
            ? mutation
            : query;
    }
    const mutationTerminal = isDistributedRunTerminalState(mutation.state);
    const queryTerminal = isDistributedRunTerminalState(query.state);
    if (mutationTerminal !== queryTerminal) {
        return mutationTerminal ? mutation : query;
    }
    if (
        mutationTerminal &&
        queryTerminal &&
        Boolean(mutation.error) !== Boolean(query.error)
    ) {
        return mutation.error ? mutation : query;
    }
    return mutation;
}
