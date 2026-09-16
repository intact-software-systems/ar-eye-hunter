import type { RallarBlackBoxTestCommandKind } from '../rallar-black-box-test-contracts.ts';

export type DistributedRecipePreflightServiceBadge = Readonly<{
    label: string;
    tone: string;
}>;

export type DistributedRecipePreflightLoop = Readonly<{
    path: string;
    commandId?: string;
    estimatedIterations: number;
    childCommandCount: number;
    effectiveCommandCount: number;
    count?: number;
    durationMs?: number;
    intervalMs?: number;
    maxCommands?: number;
    frameCount?: number;
}>;

export type DistributedRecipePreflightParallel = Readonly<{
    path: string;
    commandId?: string;
    groupCount: number;
    maxConcurrency: number;
    effectiveCommandCount: number;
    groups: readonly string[];
}>;

export type DistributedRecipePreflightWait = Readonly<{
    path: string;
    commandId?: string;
    matchSummary: string;
    timeoutMs?: number;
}>;

export type DistributedRecipePreflightAssert = Readonly<{
    path: string;
    commandId?: string;
    predicate: string;
}>;

export type DistributedRecipePreflightTreeRow = Readonly<{
    path: string;
    depth: number;
    kind: RallarBlackBoxTestCommandKind;
    commandId?: string;
    label: string;
    summary: string;
    effectiveCommandCount: number;
    details: readonly string[];
    warnings: readonly string[];
}>;

export type DistributedRecipePreflightSummary = Readonly<{
    recipeId: string;
    manifestCommandCount: number;
    effectiveCommandCount: number;
    effectiveFrameCount?: number;
    maxDepth: number;
    commandKinds: readonly RallarBlackBoxTestCommandKind[];
    providerModes: readonly string[];
    runtimeSurfaces: readonly string[];
    liveServiceRequirements: readonly string[];
    serviceBadges: readonly DistributedRecipePreflightServiceBadge[];
    loops: readonly DistributedRecipePreflightLoop[];
    parallelGroups: readonly DistributedRecipePreflightParallel[];
    waits: readonly DistributedRecipePreflightWait[];
    asserts: readonly DistributedRecipePreflightAssert[];
    tree: readonly DistributedRecipePreflightTreeRow[];
    warnings: readonly string[];
    errors: readonly string[];
}>;

/**
 * One command node of the preflight walk. The walker aggregates children into the
 * parent node, so every list here already carries the complete subtree.
 */
export type DistributedRecipeCommandAnalysis = Readonly<{
    effectiveCommandCount: number;
    effectiveFrameCount?: number;
    maxDepth: number;
    commandKinds: readonly RallarBlackBoxTestCommandKind[];
    liveServiceRequirements: readonly string[];
    loops: readonly DistributedRecipePreflightLoop[];
    parallelGroups: readonly DistributedRecipePreflightParallel[];
    waits: readonly DistributedRecipePreflightWait[];
    asserts: readonly DistributedRecipePreflightAssert[];
    tree: readonly DistributedRecipePreflightTreeRow[];
    warnings: readonly string[];
    errors: readonly string[];
}>;

/**
 * What one command-kind branch contributes before the walker merges child analyses.
 */
export type DistributedRecipeCommandBranch = Readonly<{
    effectiveCommandCount: number;
    childAnalyses: readonly DistributedRecipeCommandAnalysis[];
    summary?: string;
    details: readonly string[];
    warnings: readonly string[];
    errors: readonly string[];
    loops: readonly DistributedRecipePreflightLoop[];
    parallelGroups: readonly DistributedRecipePreflightParallel[];
    waits: readonly DistributedRecipePreflightWait[];
    asserts: readonly DistributedRecipePreflightAssert[];
}>;

export const COMPOSITE_CHILD_REQUIREMENTS_LABEL = 'same live requirements as its child commands';
export const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
