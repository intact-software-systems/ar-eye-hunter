import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '../control-snapshots.ts';
import { toDistributedRunEventRows } from '../distributed-run-observation/distributed-run-event-rows.ts';
import { hasDistributedRunReference } from '../distributed-run-observation/distributed-run-payload-summary.ts';
import type { RallarBlackBoxDistributedRunRecipeSelection } from '../distributed-run.ts';
import { computeDistributedRunDuration } from './compute-distributed-run-duration.ts';
import { toDistributedRunFailureSignatures } from './filter-distributed-runs.ts';
import { toDistributedRunRecipeSelectionId } from './to-distributed-run-recipe-selection-id.ts';

export type DistributedRunCompareSummary = Readonly<{
    leftId: string;
    rightId: string;
    recipeDelta: Readonly<{
        leftOnly: readonly string[];
        rightOnly: readonly string[];
        changedProfiles: readonly string[];
    }>;
    participantDelta: Readonly<{
        leftOnly: readonly string[];
        rightOnly: readonly string[];
        shared: readonly string[];
    }>;
    failureDelta: Readonly<{
        leftCount: number;
        rightCount: number;
        leftOnly: readonly string[];
        rightOnly: readonly string[];
    }>;
    timingDelta: Readonly<{
        leftDurationMs?: number;
        rightDurationMs?: number;
        durationDeltaMs?: number;
        startedDeltaMs?: number;
        completedDeltaMs?: number;
    }>;
    receivedMessageDelta: Readonly<{
        leftCount: number;
        rightCount: number;
        delta: number;
        leftOnly: readonly string[];
        rightOnly: readonly string[];
    }>;
}>;

export function compareDistributedRuns(
    input: Readonly<{
        left: ControlDistributedRunSnapshot;
        right: ControlDistributedRunSnapshot;
        leftControlRun?: ControlRunSnapshot;
        rightControlRun?: ControlRunSnapshot;
    }>
): DistributedRunCompareSummary {
    const leftRecipes = toRecipeCompareMap(input.left);
    const rightRecipes = toRecipeCompareMap(input.right);
    const leftParticipants = new Set(input.left.targetAgentIds);
    const rightParticipants = new Set(input.right.targetAgentIds);
    const leftFailures = toDistributedRunFailureSignatures(input.left);
    const rightFailures = toDistributedRunFailureSignatures(input.right);
    const leftMessages = toDistributedRunReceivedMessageSignatures(input.left, input.leftControlRun);
    const rightMessages = toDistributedRunReceivedMessageSignatures(input.right, input.rightControlRun);

    return {
        leftId: input.left.distributedRunId,
        rightId: input.right.distributedRunId,
        recipeDelta: {
            leftOnly: setDifference([...leftRecipes.keys()], new Set(rightRecipes.keys())),
            rightOnly: setDifference([...rightRecipes.keys()], new Set(leftRecipes.keys())),
            changedProfiles: [...leftRecipes.entries()]
                .filter(([recipeId, leftProfile]) =>
                    rightRecipes.has(recipeId) && rightRecipes.get(recipeId) !== leftProfile
                )
                .map(([recipeId, leftProfile]) =>
                    `${recipeId}: ${leftProfile || '-'} -> ${rightRecipes.get(recipeId) || '-'}`
                )
        },
        participantDelta: {
            leftOnly: setDifference([...leftParticipants], rightParticipants),
            rightOnly: setDifference([...rightParticipants], leftParticipants),
            shared: [...leftParticipants]
                .filter((agentId) => rightParticipants.has(agentId))
                .sort()
        },
        failureDelta: {
            leftCount: leftFailures.length,
            rightCount: rightFailures.length,
            leftOnly: setDifference(leftFailures, new Set(rightFailures)),
            rightOnly: setDifference(rightFailures, new Set(leftFailures))
        },
        timingDelta: toTimingDelta(input.left, input.right),
        receivedMessageDelta: toReceivedMessageDelta(leftMessages, rightMessages)
    };
}

function toTimingDelta(
    left: ControlDistributedRunSnapshot,
    right: ControlDistributedRunSnapshot
): DistributedRunCompareSummary['timingDelta'] {
    const leftDurationMs = computeDistributedRunDuration(left);
    const rightDurationMs = computeDistributedRunDuration(right);
    return {
        leftDurationMs,
        rightDurationMs,
        durationDeltaMs: leftDurationMs !== undefined && rightDurationMs !== undefined
            ? rightDurationMs - leftDurationMs
            : undefined,
        startedDeltaMs: left.startedAtEpochMs !== undefined && right.startedAtEpochMs !== undefined
            ? right.startedAtEpochMs - left.startedAtEpochMs
            : undefined,
        completedDeltaMs: left.completedAtEpochMs !== undefined && right.completedAtEpochMs !== undefined
            ? right.completedAtEpochMs - left.completedAtEpochMs
            : undefined
    };
}

function toReceivedMessageDelta(
    leftMessages: readonly string[],
    rightMessages: readonly string[]
): DistributedRunCompareSummary['receivedMessageDelta'] {
    return {
        leftCount: leftMessages.length,
        rightCount: rightMessages.length,
        delta: rightMessages.length - leftMessages.length,
        leftOnly: setDifference(leftMessages, new Set(rightMessages)),
        rightOnly: setDifference(rightMessages, new Set(leftMessages))
    };
}

function toRecipeCompareMap(run: ControlDistributedRunSnapshot): ReadonlyMap<string, string> {
    return new Map(run.manifest.recipes.map((selection, index) => [
        toDistributedRunRecipeSelectionId(selection, index),
        selection.profile ?? ''
    ]));
}

function toDistributedRunReceivedMessageSignatures(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot | undefined
): readonly string[] {
    const linkedCommandIds = new Set(
        distributedRun.commandLinks.map((link) => link.commandId)
    );
    const events = (controlRun?.events ?? []).filter((event) =>
        (event.commandId !== undefined && linkedCommandIds.has(event.commandId)) ||
        hasDistributedRunReference(event.payload, distributedRun.distributedRunId)
    );
    return toDistributedRunEventRows(events)
        .filter((event) => {
            const text = `${event.kind} ${event.topic ?? ''} ${event.summary}`.toLowerCase();
            return text.includes('message') || text.includes('received') || text.includes('payload');
        })
        .map((event) => `${event.agentId}:${event.commandId ?? event.eventId}:${event.summary}`)
        .sort();
}

function setDifference(values: readonly string[], right: ReadonlySet<string>): readonly string[] {
    return values.filter((value) => !right.has(value)).sort();
}
