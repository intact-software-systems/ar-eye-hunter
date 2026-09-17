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
import type { DistributedRunMonitorDerivationWork } from './distributed-run-monitor-derivation-work.ts';
import type { DistributedRunRecipeProgressRow } from './distributed-run-row-contracts.ts';

export interface DistributedRunRecipeProgress {
    readonly rows: readonly DistributedRunRecipeProgressRow[];
    readonly work: Pick<
        DistributedRunMonitorDerivationWork,
        | 'recipeTargetCountLookupCount'
        | 'recipeLinkBucketLookupCount'
        | 'recipeLinkProjectionVisitCount'
        | 'linkedAgentExpectedMembershipProbeCount'
    >;
}

interface RecipeProgressRowProjection {
    readonly row: DistributedRunRecipeProgressRow;
    readonly linkVisitCount: number;
    readonly membershipProbeCount: number;
}

type RecipeLinkTotals = Readonly<{
    targetAgentsWithLinks: ReadonlySet<string>;
    latencies: readonly number[];
    queuedCount: number;
    runningCount: number;
    passedCount: number;
    failedCount: number;
    linkVisitCount: number;
}>;

/** One row per recipe selection, with the lookups, link visits and membership probes the projection made. */
export function computeDistributedRunRecipeProgress(index: DistributedRunMonitorIndex): DistributedRunRecipeProgress {
    const projections = index.membership.recipeSelections.map((selection, recipeIndex) =>
        toRecipeProgressRowProjection(index, selection, recipeIndex)
    );
    return {
        rows: projections.map((projection) => projection.row),
        work: {
            recipeTargetCountLookupCount: projections.length,
            recipeLinkBucketLookupCount: projections.length,
            recipeLinkProjectionVisitCount: projections.reduce(
                (total, projection) => total + projection.linkVisitCount,
                0
            ),
            linkedAgentExpectedMembershipProbeCount: projections.reduce(
                (total, projection) => total + projection.membershipProbeCount,
                0
            )
        }
    };
}

function toRecipeProgressRowProjection(
    index: DistributedRunMonitorIndex,
    selection: RallarBlackBoxDistributedRunRecipeSelection,
    recipeIndex: number
): RecipeProgressRowProjection {
    const recipeId = index.membership.recipeIds[recipeIndex]!;
    const targetCount = distributedRunMonitorRecipeTargetCount(index.membership, recipeIndex);
    const totals = toRecipeLinkTotals(index, resolveDistributedRunMonitorRecipeLinks(index, recipeId));

    let missingCount = targetCount;
    for (const agentId of totals.targetAgentsWithLinks) {
        missingCount -= distributedRunMonitorExpectedTargetMultiplicity(index.membership, recipeIndex, agentId);
    }

    return {
        linkVisitCount: totals.linkVisitCount,
        membershipProbeCount: totals.targetAgentsWithLinks.size,
        row: {
            recipeId,
            profile: selection.profile,
            role: selection.role,
            required: selection.required,
            targetCount,
            queuedCount: totals.queuedCount,
            runningCount: totals.runningCount,
            passedCount: totals.passedCount,
            failedCount: totals.failedCount,
            missingCount,
            averageLatencyMs: computeAverage(totals.latencies)
        }
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
    let linkVisitCount = 0;
    for (const link of progressLinks) {
        linkVisitCount += 1;
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
    return { targetAgentsWithLinks, latencies, queuedCount, runningCount, passedCount, failedCount, linkVisitCount };
}
