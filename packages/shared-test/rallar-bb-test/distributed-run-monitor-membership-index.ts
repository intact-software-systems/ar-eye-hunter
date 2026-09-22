import type { ControlDistributedRunSnapshot } from './control-snapshots.ts';
import { resolveDistributedRunRecipeSelectionKey } from './distributed-run-evidence.ts';
import {
    computeDistributedRunMonitorTargetMembership,
    type DistributedRunMonitorAssignmentMembership,
    type DistributedRunMonitorRecipeMembership,
    type DistributedRunMonitorRecipeSelectionKey,
    type DistributedRunMonitorRecipeSelectionKeys,
    type DistributedRunMonitorTargetAgentMembership
} from './distributed-run-observation/compute-distributed-run-monitor-target-membership.ts';
import type { RallarBlackBoxDistributedRunRecipeSelection } from './distributed-run.ts';

export interface DistributedRunMonitorMembershipIndex {
    readonly targetAgentIds: readonly string[];
    readonly recipes: readonly DistributedRunMonitorRecipeMembership[];
    readonly roleByAgentId: ReadonlyMap<string, string>;
    readonly targetMembershipByAgentId: ReadonlyMap<string, DistributedRunMonitorTargetAgentMembership>;
}

interface AssignmentRoles extends DistributedRunMonitorAssignmentMembership {
    readonly displayRolesByAgentId: ReadonlyMap<string, readonly string[]>;
}

export function createDistributedRunMonitorMembershipIndex(
    distributedRun: ControlDistributedRunSnapshot
): DistributedRunMonitorMembershipIndex {
    const assignments = toAssignmentRoles(distributedRun);
    const targets = computeDistributedRunMonitorTargetMembership({
        targetAgentIds: distributedRun.targetAgentIds,
        assignments,
        recipes: toRecipeSelectionKeys(distributedRun.manifest.recipes)
    });

    return {
        targetAgentIds: targets.targetAgentIds,
        recipes: targets.recipes,
        roleByAgentId: new Map([...assignments.displayRolesByAgentId].map(([agentId, roles]) => [
            agentId,
            roles.join(', ')
        ])),
        targetMembershipByAgentId: targets.membershipByAgentId
    };
}

export function computeDistributedRunMonitorExpectedTargetMultiplicity(
    index: DistributedRunMonitorMembershipIndex,
    recipe: DistributedRunMonitorRecipeMembership,
    agentId: string
): number {
    const target = index.targetMembershipByAgentId.get(agentId);
    if (target === undefined) {
        return 0;
    }
    const role = recipe.selection.role;
    const matchesRole = role !== undefined && role !== '' && target.roles.has(role);
    if (target.assignedRecipeIds.size === 0) {
        return !role || matchesRole ? target.multiplicity : 0;
    }
    const matchesRecipe = recipe.selectionKey !== undefined && target.assignedRecipeIds.has(recipe.selectionKey);
    return matchesRecipe || matchesRole || (!role && !target.hasExplicitSelection) ? target.multiplicity : 0;
}

function toAssignmentRoles(distributedRun: ControlDistributedRunSnapshot): AssignmentRoles {
    const resolvedAssignments = distributedRun.targetResolution?.roleAssignments;
    const displayRolesByAgentId = new Map<string, string[]>();
    const expectedRolesByAgentId = new Map<string, Set<string>>();
    const assignedRecipeIdsByAgentId = new Map<string, Set<string>>();
    for (const assignment of resolvedAssignments ?? distributedRun.manifest.roleAssignments) {
        appendMapValue(displayRolesByAgentId, assignment.agentId, assignment.role);
        addMapSetValue(expectedRolesByAgentId, assignment.agentId, assignment.role);
        for (const recipeId of assignment.recipeIds) {
            addMapSetValue(assignedRecipeIdsByAgentId, assignment.agentId, recipeId);
        }
    }

    const targetPolicy = distributedRun.manifest.targetPolicy;
    if (resolvedAssignments === undefined && targetPolicy.mode === 'role-map') {
        for (const [role, agentIds] of Object.entries(targetPolicy.roles)) {
            for (const agentId of agentIds) {
                addMapSetValue(expectedRolesByAgentId, agentId, role);
            }
        }
    }
    return { displayRolesByAgentId, expectedRolesByAgentId, assignedRecipeIdsByAgentId };
}

function toRecipeSelectionKeys(
    recipeSelections: readonly RallarBlackBoxDistributedRunRecipeSelection[]
): DistributedRunMonitorRecipeSelectionKeys {
    const selections: DistributedRunMonitorRecipeSelectionKey[] = [];
    const selectedRecipeKeys = new Set<string>();
    const selectedRoles = new Set<string>();
    for (const selection of recipeSelections) {
        const selectionKey = resolveDistributedRunRecipeSelectionKey(selection) || undefined;
        selections.push({
            selection,
            recipeId: selectionKey ?? `recipe-${selections.length + 1}`,
            selectionKey
        });
        if (selectionKey) {
            selectedRecipeKeys.add(selectionKey);
        }
        if (selection.role) {
            selectedRoles.add(selection.role);
        }
    }
    return { selections, selectedRecipeKeys, selectedRoles };
}

function appendMapValue<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value): void {
    const values = map.get(key);
    if (values) {
        values.push(value);
    }
    else {
        map.set(key, [value]);
    }
}

function addMapSetValue<Key, Value>(map: Map<Key, Set<Value>>, key: Key, value: Value): void {
    const values = map.get(key);
    if (values) {
        values.add(value);
    }
    else {
        map.set(key, new Set([value]));
    }
}
