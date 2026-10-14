import type { ControlRunSnapshotBounds } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { isDistributedRunTerminalState } from '@shared-test/rallar-bb-test/distributed/distributed-run-rollup.ts';

import type { ControlDistributedRunState, ControlRunState } from './control-service-state.ts';
import { toPendingReloadEvidenceIds } from './recipe-reload/control-recipe-reload-evidence.ts';

const REPORT_DEDUPE_KEY_LIMIT = 1_000;

export function trimControlRunEvidence(
    run: ControlRunState,
    distributedRuns: Iterable<ControlDistributedRunState>,
    bounds: ControlRunSnapshotBounds
): void {
    const protectedCommandIds = toProtectedRuntimeCommandIds(run.runId, distributedRuns);
    for (const commandId of toPendingReloadEvidenceIds(run.commands.values())) {
        protectedCommandIds.add(commandId);
    }
    for (const command of run.commands.values()) {
        if (command.completedAtEpochMs === undefined) {
            protectedCommandIds.add(command.envelope.commandId);
        }
    }
    trimMapByInsertion(run.commands, bounds.commands, protectedCommandIds);
    trimMapByInsertion(run.results, bounds.results, protectedCommandIds);
    trimArrayToTail(run.events, bounds.events);
    trimArrayToTail(run.stats, bounds.stats);
    trimArrayToTail(run.reports, bounds.reports);
    trimArrayToTail(run.heartbeats, bounds.heartbeats);
}

export function trimControlReportDedupeKeys(run: ControlRunState): void {
    for (const key of run.reportKeys) {
        if (run.reportKeys.size <= REPORT_DEDUPE_KEY_LIMIT) {
            return;
        }
        run.reportKeys.delete(key);
    }
}

/** A bounded tail is always a copy, so trimming the retained array in place never reaches a handed-out snapshot. */
export function toBoundedTail<T>(values: readonly T[], limit: number | undefined): readonly T[] {
    const trimCount = computeTailTrimCount(values.length, limit);
    return trimCount === undefined ? values : values.slice(trimCount);
}

export function toProtectedRuntimeCommandIds(
    runId: string,
    distributedRuns: Iterable<ControlDistributedRunState>
): Set<string> {
    const commandIds = new Set<string>();
    for (const distributedRun of distributedRuns) {
        if (distributedRun.controlRunId !== runId || isDistributedRunTerminalState(distributedRun.state)) {
            continue;
        }
        distributedRun.commandLinks.forEach((link) => commandIds.add(link.commandId));
    }
    return commandIds;
}

function trimArrayToTail<T>(values: T[], limit: number | undefined): void {
    const trimCount = computeTailTrimCount(values.length, limit);
    if (trimCount !== undefined && trimCount > 0) {
        values.splice(0, trimCount);
    }
}

function trimMapByInsertion<T>(
    values: Map<string, T>,
    limit: number | undefined,
    protectedKeys: ReadonlySet<string>
): void {
    const trimCount = computeTailTrimCount(values.size, limit);
    if (trimCount === undefined || trimCount === 0) {
        return;
    }

    const retainedSize = values.size - trimCount;
    for (const key of values.keys()) {
        if (values.size <= retainedSize) {
            return;
        }
        if (!protectedKeys.has(key)) {
            values.delete(key);
        }
    }
}

/** Undefined when the limit leaves the collection unbounded. */
function computeTailTrimCount(size: number, limit: number | undefined): number | undefined {
    if (limit === undefined || !Number.isFinite(limit) || limit < 0) {
        return undefined;
    }
    return Math.max(0, size - Math.floor(limit));
}
