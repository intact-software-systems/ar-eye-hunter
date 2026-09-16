import type { DistributedRecipeCatalogItem } from '../distributed-recipe-catalog.ts';
import type {
    RallarBlackBoxDistributedBarrierPolicy,
    RallarBlackBoxDistributedGroupAssertion,
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRecipeSelection,
    RallarBlackBoxDistributedTargetPolicy
} from '../distributed-run.ts';
import {
    DistributedRecipeRolePattern,
    toOrderedTargetRoleAssignmentPolicy,
    toRecipeRoleForPattern,
    toRoleAssignmentsForPattern,
    toRolesForPattern
} from './distributed-recipe-role-pattern.ts';

export type DistributedRecipeTargetPolicyMode =
    | 'all-online-group-members'
    | 'selected-agents'
    | 'role-map';

export type BuildDistributedRunManifestInput = Readonly<{
    distributedRunId: string;
    controlRunId: string;
    displayName?: string;
    group: RallarBlackBoxDistributedGroupRef;
    recipes: readonly DistributedRecipeCatalogItem[];
    targetAgentIds: readonly string[];
    targetPolicyMode: DistributedRecipeTargetPolicyMode;
    rolePattern: DistributedRecipeRolePattern;
    ackTimeoutMs: number;
    barrier?: RallarBlackBoxDistributedBarrierPolicy;
    startMode: 'manual' | 'auto-after-ready' | 'scheduled';
    startDeadlineEpochMs?: number;
    expectedParticipantCount?: number;
    groupAssertions?: readonly RallarBlackBoxDistributedGroupAssertion[];
}>;

export function buildDistributedRunManifest(
    input: BuildDistributedRunManifestInput
): RallarBlackBoxDistributedRunManifest {
    const recipeSelections = input.recipes.map((item, index) => ({
        recipeId: item.recipe.recipeId,
        recipe: item.recipe,
        role: toRecipeRoleForPattern(input.rolePattern, index, input.recipes.length),
        profile: item.profiles[0],
        required: true
    } satisfies RallarBlackBoxDistributedRunRecipeSelection));
    const roles = toRolesForPattern(input.rolePattern, input.targetAgentIds);
    const targetPolicy = toTargetPolicy({
        mode: input.targetPolicyMode,
        agentIds: input.targetAgentIds,
        roles,
        expectedParticipantCount: input.expectedParticipantCount
    });
    const useOrderedTargetRoles = input.targetPolicyMode === 'all-online-group-members' &&
        input.rolePattern !== 'all-agents';
    const roleAssignments = useOrderedTargetRoles
        ? undefined
        : toRoleAssignmentsForPattern(input.rolePattern, input.targetAgentIds);
    const roleAssignmentPolicy = useOrderedTargetRoles
        ? toOrderedTargetRoleAssignmentPolicy(input.rolePattern)
        : undefined;

    return {
        schemaVersion: 1,
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        displayName: input.displayName,
        group: input.group,
        recipes: recipeSelections,
        targetPolicy,
        roleAssignments,
        roleAssignmentPolicy,
        ackTimeoutMs: input.ackTimeoutMs,
        barrier: input.barrier,
        startMode: input.startMode,
        startDeadlineEpochMs: input.startMode === 'scheduled'
            ? input.startDeadlineEpochMs
            : undefined,
        artifactPolicy: {
            retainArtifacts: true,
            includeDistributedMetadata: true,
            includeEventJsonl: true,
            includeResultJsonl: true,
            includeFailureBundle: true
        },
        groupAssertions: input.groupAssertions,
        metadata: {
            createdBy: 'rallar-black-box-spa',
            rolePattern: input.rolePattern
        }
    };
}

function toTargetPolicy(
    input: Readonly<{
        mode: DistributedRecipeTargetPolicyMode;
        agentIds: readonly string[];
        roles: Readonly<Record<string, readonly string[]>>;
        expectedParticipantCount?: number;
    }>
): RallarBlackBoxDistributedTargetPolicy {
    const expected = input.expectedParticipantCount && input.expectedParticipantCount > 0
        ? { expectedParticipantCount: Math.floor(input.expectedParticipantCount) }
        : {};
    if (input.mode === 'all-online-group-members') {
        return {
            mode: input.mode,
            ...expected
        };
    }
    if (input.mode === 'role-map') {
        return {
            mode: input.mode,
            roles: input.roles,
            ...expected
        };
    }
    return {
        mode: input.mode,
        agentIds: input.agentIds,
        ...expected
    };
}
