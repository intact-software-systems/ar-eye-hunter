import type { DistributedRecipeCatalogItem } from '../distributed-recipe-catalog.ts';
import type {
    RallarBlackBoxDistributedBarrierPolicy,
    RallarBlackBoxDistributedGroupAssertion,
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRecipeSelection,
    RallarBlackBoxDistributedScheduledRunManifest,
    RallarBlackBoxDistributedTargetPolicy,
    RallarBlackBoxDistributedUnscheduledRunManifest
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

export type BuildDistributedRunManifestStart =
    | Pick<RallarBlackBoxDistributedUnscheduledRunManifest, 'startMode'>
    | Pick<RallarBlackBoxDistributedScheduledRunManifest, 'startMode' | 'startDeadlineEpochMs'>;

export type BuildDistributedRunManifestInput = BuildDistributedRunManifestFields & BuildDistributedRunManifestStart;

export interface BuildDistributedRunManifestFields {
    readonly distributedRunId: string;
    readonly controlRunId: string;
    /** Absent when the author gives the run no display name. */
    readonly displayName?: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly recipes: readonly DistributedRecipeCatalogItem[];
    readonly targetAgentIds: readonly string[];
    readonly targetPolicyMode: DistributedRecipeTargetPolicyMode;
    readonly rolePattern: DistributedRecipeRolePattern;
    readonly ackTimeoutMs: number;
    readonly barrier: RallarBlackBoxDistributedBarrierPolicy;
    /** Absent when staging should accept however many agents the target policy resolves. */
    readonly expectedParticipantCount?: number;
    readonly groupAssertions: readonly RallarBlackBoxDistributedGroupAssertion[];
}

export function buildDistributedRunManifest(
    input: BuildDistributedRunManifestInput
): RallarBlackBoxDistributedRunManifest {
    const recipeSelections = input.recipes.map((item, index) => ({
        recipeId: item.recipe.recipeId,
        recipe: item.recipe,
        role: toRecipeRoleForPattern(input.rolePattern, index, input.recipes.length),
        profile: item.profiles[0],
        required: true,
        variables: {},
        secretRefs: []
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
        ? []
        : toRoleAssignmentsForPattern(input.rolePattern, input.targetAgentIds);
    const roleAssignmentPolicy = useOrderedTargetRoles
        ? toOrderedTargetRoleAssignmentPolicy(input.rolePattern)
        : undefined;
    const fields = {
        schemaVersion: 1,
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        displayName: input.displayName,
        group: input.group,
        recipes: recipeSelections,
        targetPolicy,
        variables: {},
        secretRefs: [],
        roleAssignments,
        roleAssignmentPolicy,
        ackTimeoutMs: input.ackTimeoutMs,
        barrier: input.barrier
    } as const;
    const settings = {
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

    return input.startMode === 'scheduled'
        ? { ...fields, startMode: input.startMode, startDeadlineEpochMs: input.startDeadlineEpochMs, ...settings }
        : { ...fields, startMode: input.startMode, ...settings };
}

interface ToTargetPolicyInput {
    readonly mode: DistributedRecipeTargetPolicyMode;
    readonly agentIds: readonly string[];
    readonly roles: Readonly<Record<string, readonly string[]>>;
    /** Absent when staging should accept however many agents the target policy resolves. */
    readonly expectedParticipantCount?: number;
}

function toTargetPolicy(input: ToTargetPolicyInput): RallarBlackBoxDistributedTargetPolicy {
    const expected = input.expectedParticipantCount && input.expectedParticipantCount > 0
        ? { expectedParticipantCount: Math.floor(input.expectedParticipantCount) }
        : {};
    if (input.mode === 'all-online-group-members') {
        return {
            mode: input.mode,
            ...expected,
            includeOfflineExpectedAgents: false
        };
    }
    if (input.mode === 'role-map') {
        return {
            mode: input.mode,
            roles: input.roles,
            ...expected,
            includeOfflineExpectedAgents: false
        };
    }
    return {
        mode: input.mode,
        agentIds: input.agentIds,
        ...expected,
        includeOfflineExpectedAgents: false
    };
}
