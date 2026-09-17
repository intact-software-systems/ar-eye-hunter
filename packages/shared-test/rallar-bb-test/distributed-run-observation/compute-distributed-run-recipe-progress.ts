import type { ControlDistributedRunCommandLink } from '../control-snapshots.ts';
import {
    resolveDistributedRunMonitorRecipeLinks,
    type DistributedRunMonitorIndex
} from '../distributed-run-monitor-index.ts';
import {
    distributedRunMonitorExpectedTargetMultiplicity,
    distributedRunMonitorRecipeTargetCount
} from '../distributed-run-monitor-membership-index.ts';
import type { RallarBlackBoxDistributedRunRecipeSelection } from '../distributed-run.ts';
import { computeAverage, isFiniteDurationMs } from './distributed-run-latency-summary.ts';
import type { DistributedRunRecipeProgressRow } from './distributed-run-row-contracts.ts';

type RecipeLinkTotals = Readonly<{
    targetAgentsWithLinks: ReadonlySet<string>;
    latencies: readonly number[];
    queuedCount: number;
    runningCount: number;
    passedCount: number;
    failedCount: number;
}>;

export function computeDistributedRunRecipeProgress(
    index: DistributedRunMonitorIndex
): readonly DistributedRunRecipeProgressRow[] {
    return index.membership.recipeSelections.map((selection, recipeIndex) =>
        toRecipeProgressRow(index, selection, recipeIndex)
    );
}

function toRecipeProgressRow(
    index: DistributedRunMonitorIndex,
    selection: RallarBlackBoxDistributedRunRecipeSelection,
    recipeIndex: number
): DistributedRunRecipeProgressRow {
    const recipeId = index.membership.recipeIds[recipeIndex]!;
    const targetCount = distributedRunMonitorRecipeTargetCount(index.membership, recipeIndex);
    const totals = toRecipeLinkTotals(index, resolveDistributedRunMonitorRecipeLinks(index, recipeId));

    let missingCount = targetCount;
    for (const agentId of totals.targetAgentsWithLinks) {
        missingCount -= distributedRunMonitorExpectedTargetMultiplicity(index.membership, recipeIndex, agentId);
    }

    return {
        recipeId,
        profile: selection.profile,
        role: selection.role,
        targetCount,
        queuedCount: totals.queuedCount,
        runningCount: totals.runningCount,
        passedCount: totals.passedCount,
        failedCount: totals.failedCount,
        missingCount,
        averageLatencyMs: computeAverage(totals.latencies)
    };
}

function toRecipeLinkTotals(
    index: DistributedRunMonitorIndex,
    progressLinks: readonly ControlDistributedRunCommandLink[]
): RecipeLinkTotals {
    const targetAgentsWithLinks = new Set<string>();
    const latencies: number[] = [];
    let queuedCount = 0;
    let runningCount = 0;
    let passedCount = 0;
    let failedCount = 0;
    for (const link of progressLinks) {
        targetAgentsWithLinks.add(link.agentId);
        const command = index.commandsById.get(link.commandId);
        const result = index.resultsByCommandId.get(link.commandId);
        if (result === undefined) {
            if (command?.dispatchedAtEpochMs === undefined) {
                queuedCount += 1;
            }
            else {
                runningCount += 1;
            }
            continue;
        }
        if (result.ok) {
            passedCount += 1;
        }
        else {
            failedCount += 1;
        }
        const durationMs = result.result?.durationMs;
        if (isFiniteDurationMs(durationMs)) {
            latencies.push(durationMs);
        }
    }
    return { targetAgentsWithLinks, latencies, queuedCount, runningCount, passedCount, failedCount };
}
