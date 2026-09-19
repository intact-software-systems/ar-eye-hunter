import { toUniqueSortedValues } from '../distributed/to-unique-sorted-values.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommand
} from '../rallar-black-box-test-contracts.ts';
import {
    computeEffectiveFrameCount,
    resolveFirstPositiveInteger
} from './distributed-recipe-command-preview.ts';
import {
    COMPOSITE_CHILD_REQUIREMENTS_LABEL,
    type DistributedRecipeCommandAnalysis,
    type DistributedRecipeCommandBranch,
    type DistributedRecipePreflightTreeRow
} from './distributed-recipe-preflight-contracts.ts';
import { resolveCommandCapability } from './resolve-command-capability.ts';
import {
    toLoopCommandBranch,
    toNestedRecipeCommandBranch,
    toParallelCommandBranch
} from './to-composite-command-branch.ts';
import { toDistributedRecipeCommandSummary } from './to-distributed-recipe-command-summary.ts';
import { toAssertCommandBranch, toWaitCommandBranch } from './to-expectation-command-branch.ts';
import {
    toRtcConnectCommandDetails,
    toRtcStreamCommandDetails
} from './to-transport-command-details.ts';

export function toDistributedRecipeCommandAnalysis(
    command: RallarBlackBoxTestCommand,
    path: string,
    depth: number
): DistributedRecipeCommandAnalysis {
    const branch = toCommandBranch(command, path, depth);
    const { childAnalyses } = branch;
    const row: DistributedRecipePreflightTreeRow = {
        path,
        depth,
        kind: command.kind,
        commandId: command.commandId,
        label: command.label ?? command.commandId ?? command.kind,
        summary: branch.summary ?? toDistributedRecipeCommandSummary(command),
        effectiveCommandCount: branch.effectiveCommandCount,
        details: branch.details,
        warnings: branch.warnings
    };

    return {
        effectiveCommandCount: branch.effectiveCommandCount,
        effectiveFrameCount: computeEffectiveFrameCount(command) ??
            resolveFirstPositiveInteger(childAnalyses, (analysis) => analysis.effectiveFrameCount),
        maxDepth: childAnalyses.reduce(
            (maxDepth, analysis) => Math.max(maxDepth, analysis.maxDepth),
            depth + 1
        ),
        commandKinds: toUniqueSortedValues([
            command.kind,
            ...childAnalyses.flatMap((analysis) => analysis.commandKinds)
        ]),
        liveServiceRequirements: toUniqueSortedValues([
            ...toDirectLiveServiceRequirements(command),
            ...childAnalyses.flatMap((analysis) => analysis.liveServiceRequirements)
        ]),
        loops: [...branch.loops, ...childAnalyses.flatMap((analysis) => analysis.loops)],
        parallelGroups: [
            ...branch.parallelGroups,
            ...childAnalyses.flatMap((analysis) => analysis.parallelGroups)
        ],
        waits: [...branch.waits, ...childAnalyses.flatMap((analysis) => analysis.waits)],
        asserts: [...branch.asserts, ...childAnalyses.flatMap((analysis) => analysis.asserts)],
        tree: [row, ...childAnalyses.flatMap((analysis) => analysis.tree)],
        warnings: toUniqueSortedValues([
            ...branch.warnings,
            ...childAnalyses.flatMap((analysis) => analysis.warnings)
        ]),
        errors: toUniqueSortedValues([
            ...toDepthErrors(path, depth),
            ...branch.errors,
            ...childAnalyses.flatMap((analysis) => analysis.errors)
        ])
    };
}

function toCommandBranch(
    command: RallarBlackBoxTestCommand,
    path: string,
    depth: number
): DistributedRecipeCommandBranch {
    const toChildCommandAnalysis = (child: RallarBlackBoxTestCommand, childPath: string) =>
        toDistributedRecipeCommandAnalysis(child, childPath, depth + 1);

    switch (command.kind) {
        case 'loop':
            return toLoopCommandBranch(command, path, toChildCommandAnalysis);
        case 'parallel':
            return toParallelCommandBranch(command, path, toChildCommandAnalysis);
        case 'recipe.load':
        case 'recipe.run':
            return toNestedRecipeCommandBranch(command, path, toChildCommandAnalysis);
        case 'wait':
            return toWaitCommandBranch(command, path);
        case 'assert':
            return toAssertCommandBranch(command, path);
        case 'rtc.connect':
            return toLeafCommandBranch(toRtcConnectCommandDetails(command));
        case 'rtc.stream':
            return toLeafCommandBranch(toRtcStreamCommandDetails(command));
        default:
            return toLeafCommandBranch([]);
    }
}

function toLeafCommandBranch(details: readonly string[]): DistributedRecipeCommandBranch {
    return {
        effectiveCommandCount: 1,
        childAnalyses: [],
        details,
        warnings: [],
        errors: [],
        loops: [],
        parallelGroups: [],
        waits: [],
        asserts: []
    };
}

function toDepthErrors(path: string, depth: number): readonly string[] {
    return depth > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth
        ? [`${path} exceeds max composite depth ${RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth}.`]
        : [];
}

function toDirectLiveServiceRequirements(command: RallarBlackBoxTestCommand): readonly string[] {
    return resolveCommandCapability(command.kind)
        ?.liveServiceRequirements
        .filter((requirement) => requirement !== COMPOSITE_CHILD_REQUIREMENTS_LABEL) ?? [];
}
