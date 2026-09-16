import type { ControlDistributedRunCommandLink } from '../control-snapshots.ts';
import {
    getDistributedRunMonitorRecipeLinks,
    type DistributedRunMonitorIndex
} from '../distributed-run-monitor-index.ts';
import {
    distributedRunMonitorExpectedTargetMultiplicity,
    distributedRunMonitorRecipeTargetCount
} from '../distributed-run-monitor-membership-index.ts';
import { computeAverage, isFiniteDurationMs } from './distributed-run-latency-summary.ts';
import type { DistributedRunRecipeProgressRow } from './distributed-run-row-contracts.ts';

export function computeDistributedRunRecipeProgress(
    input: Readonly<{
        index: DistributedRunMonitorIndex;
    }>
): readonly DistributedRunRecipeProgressRow[] {
    return input.index.membership.recipeSelections.map((selection, recipeIndex) => {
        const recipeId = input.index.membership.recipeIds[recipeIndex]!;
        const targetCount = distributedRunMonitorRecipeTargetCount(
            input.index.membership,
            recipeIndex,
            input.index.work
        );
        const progressLinks = getDistributedRunMonitorRecipeLinks(input.index, recipeId);
        const totals = toRecipeLinkTotals(input.index, progressLinks);

        let missingCount = targetCount;
        for (const agentId of totals.targetAgentsWithLinks) {
            missingCount -= distributedRunMonitorExpectedTargetMultiplicity(
                input.index.membership,
                recipeIndex,
                agentId,
                input.index.work
            );
        }

        return {
            recipeId,
            profile: selection.profile,
            role: selection.role,
            required: selection.required !== false,
            targetCount,
            queuedCount: totals.queuedCount,
            runningCount: totals.runningCount,
            passedCount: totals.passedCount,
            failedCount: totals.failedCount,
            missingCount,
            averageLatencyMs: computeAverage(totals.latencies)
        };
    });
}

type RecipeLinkTotals = Readonly<{
    targetAgentsWithLinks: ReadonlySet<string>;
    latencies: readonly number[];
    queuedCount: number;
    runningCount: number;
    passedCount: number;
    failedCount: number;
}>;

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
        index.work.recipeLinkProjectionVisitCount += 1;
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
