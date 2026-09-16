import { computeRtcReadinessWarnings } from '../browser/compute-rtc-readiness-warnings.ts';
import { uniqueSortedValues } from '../distributed/unique-sorted-values.ts';
import type { RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';
import {
    computeRecipeMetadataFrameCount,
    decodeFirstPositiveIntegerFrom
} from './distributed-recipe-command-preview.ts';
import {
    COMPOSITE_CHILD_REQUIREMENTS_LABEL,
    type DistributedRecipePreflightSummary
} from './distributed-recipe-preflight-contracts.ts';
import { resolveCommandCapabilities } from './resolve-command-capability.ts';
import { toDistributedRecipeCommandAnalysis } from './to-distributed-recipe-command-analysis.ts';
import {
    toPreflightCompatibilityWarnings,
    toPreflightServiceBadges
} from './to-preflight-service-badges.ts';

export function distributedRecipePreflight(
    recipe: RallarBlackBoxTestRecipe
): DistributedRecipePreflightSummary {
    const analyses = recipe.commands.map((command, index) =>
        toDistributedRecipeCommandAnalysis(command, `$.commands[${index}]`, 0)
    );
    const commandKinds = uniqueSortedValues(analyses.flatMap((analysis) => analysis.commandKinds));
    const capabilities = resolveCommandCapabilities(commandKinds);
    const liveServiceRequirements = uniqueSortedValues([
        ...capabilities.flatMap((capability) => capability.liveServiceRequirements),
        ...analyses.flatMap((analysis) => analysis.liveServiceRequirements)
    ].filter((requirement) => requirement !== COMPOSITE_CHILD_REQUIREMENTS_LABEL));

    return {
        recipeId: recipe.recipeId,
        manifestCommandCount: recipe.commands.length,
        effectiveCommandCount: analyses.reduce((sum, analysis) => sum + analysis.effectiveCommandCount, 0),
        effectiveFrameCount: computeRecipeMetadataFrameCount(recipe) ??
            decodeFirstPositiveIntegerFrom(analyses, (analysis) => analysis.effectiveFrameCount),
        maxDepth: analyses.reduce((maxDepth, analysis) => Math.max(maxDepth, analysis.maxDepth), 0),
        commandKinds,
        providerModes: uniqueSortedValues(capabilities.flatMap((capability) => capability.supportedProviderModes)),
        runtimeSurfaces: uniqueSortedValues(capabilities.flatMap((capability) => capability.runtimeSurfaces)),
        liveServiceRequirements,
        serviceBadges: toPreflightServiceBadges(commandKinds, liveServiceRequirements),
        loops: analyses.flatMap((analysis) => analysis.loops),
        parallelGroups: analyses.flatMap((analysis) => analysis.parallelGroups),
        waits: analyses.flatMap((analysis) => analysis.waits),
        asserts: analyses.flatMap((analysis) => analysis.asserts),
        tree: analyses.flatMap((analysis) => analysis.tree),
        warnings: uniqueSortedValues([
            ...analyses.flatMap((analysis) => analysis.warnings),
            ...computeRtcReadinessWarnings(recipe),
            ...toPreflightCompatibilityWarnings(commandKinds, liveServiceRequirements)
        ]),
        errors: uniqueSortedValues(analyses.flatMap((analysis) => analysis.errors))
    };
}
