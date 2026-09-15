import type {
    ControlRunSnapshotBounds
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    isDistributedRunTerminalState
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { ControlDistributedRunState, ControlRunState } from './control-service-state.ts';

export function trimControlRunEvidence(
    run: ControlRunState,
    distributedRuns: Iterable<ControlDistributedRunState>,
    bounds: ControlRunSnapshotBounds
): void {
    const protectedCommandIds = toProtectedRuntimeCommandIds(run.runId, distributedRuns);
    for (const command of run.commands.values()) {
        if (command.completedAtEpochMs === undefined) {
            protectedCommandIds.add(command.envelope.commandId);
        }
    }
    trimMapByInsertion(
        run.commands,
        bounds.commands,
        protectedCommandIds
    );
    trimMapByInsertion(run.results, bounds.results, protectedCommandIds);
    run.events = toRetainedTail(run.events, bounds.events);
    run.stats = toRetainedTail(run.stats, bounds.stats);
    run.reports = toRetainedTail(run.reports, bounds.reports);
    run.heartbeats = toRetainedTail(run.heartbeats, bounds.heartbeats);
}
export function trimControlReportDedupeKeys(run: ControlRunState): void {
    for (const key of run.reportKeys) {
        if (run.reportKeys.size <= REPORT_DEDUPE_KEY_LIMIT) {
            return;
        }
        run.reportKeys.delete(key);
    }
}
export function toProtectedRuntimeCommandIds(
    runId: string,
    distributedRuns: Iterable<ControlDistributedRunState>
): Set<string> {
    const commandIds = new Set<string>();
    for (const distributedRun of distributedRuns) {
        if (
            distributedRun.controlRunId !== runId || isDistributedRunTerminalState(distributedRun.state)
        ) {
            continue;
        }
        distributedRun.commandLinks.forEach((link) => commandIds.add(link.commandId));
    }
    return commandIds;
}
export function trimMapByInsertion<T>(
    values: Map<string, T>,
    limit: number | undefined,
    protectedKeys: ReadonlySet<string>
): void {
    if (limit === undefined || !Number.isFinite(limit) || limit < 0 || values.size <= limit) {
        return;
    }

    for (const key of values.keys()) {
        if (values.size <= limit) {
            return;
        }
        if (protectedKeys.has(key)) {
            continue;
        }
        values.delete(key);
    }
}
export function toRetainedTail<T>(values: readonly T[], limit: number | undefined): T[] {
    if (limit === undefined || !Number.isFinite(limit) || limit < 0) {
        return [...values];
    }
    return values.slice(Math.max(0, values.length - Math.floor(limit)));
}
const REPORT_DEDUPE_KEY_LIMIT = 1_000;
