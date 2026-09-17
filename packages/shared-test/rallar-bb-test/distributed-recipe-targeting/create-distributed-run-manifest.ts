import type { DistributedRecipeCatalogItem } from '../distributed-recipe-catalog.ts';
import type {
    RallarBlackBoxDistributedBarrierPolicy,
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRolePattern,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRecipeSelection,
    RallarBlackBoxDistributedRunStart,
    RallarBlackBoxDistributedTargetPolicy,
    RallarBlackBoxDistributedTargetPolicyMode
} from '../distributed-run.ts';
import type { RallarBlackBoxDistributedGroupAssertion } from '../distributed/group-assertions.ts';
import {
    toOrderedTargetRoleAssignmentPolicy,
    toRecipeRoleForPattern,
    toRoleAssignmentsForPattern,
    toRolesForPattern
} from './distributed-recipe-role-pattern.ts';

export type CreateDistributedRunManifestInput = CreateDistributedRunManifestFields & RallarBlackBoxDistributedRunStart;

export interface CreateDistributedRunManifestFields {
    readonly distributedRunId: string;
    readonly controlRunId: string;
    /** Absent when the author gives the run no display name. */
    readonly displayName?: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly recipes: readonly DistributedRecipeCatalogItem[];
    readonly targetAgentIds: readonly string[];
    readonly targetPolicyMode: RallarBlackBoxDistributedTargetPolicyMode;
    readonly rolePattern: RallarBlackBoxDistributedRolePattern;
    readonly ackTimeoutMs: number;
    readonly barrier: RallarBlackBoxDistributedBarrierPolicy;
    /** Absent when staging should accept however many agents the target policy resolves. */
    readonly expectedParticipantCount?: number;
    readonly groupAssertions: readonly RallarBlackBoxDistributedGroupAssertion[];
}

interface ToTargetPolicyInput {
    readonly mode: RallarBlackBoxDistributedTargetPolicyMode;
    readonly agentIds: readonly string[];
    readonly roles: Readonly<Record<string, readonly string[]>>;
    /** Absent when staging should accept however many agents the target policy resolves. */
    readonly expectedParticipantCount?: number;
}

export function createDistributedRunManifest(
    input: CreateDistributedRunManifestInput
): RallarBlackBoxDistributedRunManifest {
    const recipeSelections = input.recipes.map((item, index) => ({
        recipeId: item.recipe.recipeId,
        recipe: item.recipe,
        role: toRecipeRoleForPattern(input.rolePattern, index, input.recipes.length),
        profile: item.profiles[0],
        required: true,
        variables: {}
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
        roleAssignments,
        roleAssignmentPolicy,
        ackTimeoutMs: input.ackTimeoutMs,
        barrier: input.barrier
    } as const;
    const settings = {
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

function toTargetPolicy(input: ToTargetPolicyInput): RallarBlackBoxDistributedTargetPolicy {
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
