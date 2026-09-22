import type { ControlDistributedRunCommandLink } from '../control-snapshots.ts';
import {
    resolveDistributedRunMonitorRecipeLinks,
    type DistributedRunMonitorIndex
} from '../distributed-run-monitor-index.ts';
import { computeDistributedRunMonitorExpectedTargetMultiplicity } from '../distributed-run-monitor-membership-index.ts';
import type { DistributedRunMonitorRecipeMembership } from './compute-distributed-run-monitor-target-membership.ts';
import { computeAverage, isFiniteDurationMs } from './distributed-run-latency-summary.ts';
import type { DistributedRunRecipeProgressRow } from './distributed-run-row-contracts.ts';

interface RecipeLinkTotals {
    readonly targetAgentsWithLinks: ReadonlySet<string>;
    readonly latencies: readonly number[];
    readonly queuedCount: number;
    readonly runningCount: number;
    readonly passedCount: number;
    readonly failedCount: number;
}

export function computeDistributedRunRecipeProgress(
    index: DistributedRunMonitorIndex
): readonly DistributedRunRecipeProgressRow[] {
    return index.membership.recipes.map((recipe) => toRecipeProgressRow(index, recipe));
}

function toRecipeProgressRow(
    index: DistributedRunMonitorIndex,
    recipe: DistributedRunMonitorRecipeMembership
): DistributedRunRecipeProgressRow {
    const totals = toRecipeLinkTotals(index, resolveDistributedRunMonitorRecipeLinks(index, recipe.recipeId));

    let missingCount = recipe.targetCount;
    for (const agentId of totals.targetAgentsWithLinks) {
        missingCount -= computeDistributedRunMonitorExpectedTargetMultiplicity(index.membership, recipe, agentId);
    }

    return {
        recipeId: recipe.recipeId,
        profile: recipe.selection.profile,
        role: recipe.selection.role,
        targetCount: recipe.targetCount,
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
