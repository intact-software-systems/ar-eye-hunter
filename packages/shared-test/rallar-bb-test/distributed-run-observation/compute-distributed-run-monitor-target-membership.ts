import type { RallarBlackBoxDistributedRunRecipeSelection } from '../distributed-run.ts';

export interface ComputeDistributedRunMonitorTargetMembershipInput {
    readonly targetAgentIds: readonly string[];
    readonly assignments: DistributedRunMonitorAssignmentMembership;
    readonly recipes: DistributedRunMonitorRecipeSelectionKeys;
}

export interface DistributedRunMonitorAssignmentMembership {
    readonly expectedRolesByAgentId: ReadonlyMap<string, ReadonlySet<string>>;
    readonly assignedRecipeIdsByAgentId: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface DistributedRunMonitorRecipeSelectionKeys {
    readonly selections: readonly DistributedRunMonitorRecipeSelectionKey[];
    readonly selectedRecipeKeys: ReadonlySet<string>;
    readonly selectedRoles: ReadonlySet<string>;
}

export interface DistributedRunMonitorRecipeSelectionKey {
    readonly selection: RallarBlackBoxDistributedRunRecipeSelection;
    readonly recipeId: string;
    /** Absent when the recipeId is blank, which only an undecoded snapshot carries; no assignment names it. */
    readonly selectionKey?: string;
}

export interface DistributedRunMonitorTargetMembership {
    readonly targetAgentIds: readonly string[];
    readonly membershipByAgentId: ReadonlyMap<string, DistributedRunMonitorTargetAgentMembership>;
    readonly recipes: readonly DistributedRunMonitorRecipeMembership[];
}

export interface DistributedRunMonitorTargetAgentMembership {
    readonly multiplicity: number;
    readonly assignedRecipeIds: ReadonlySet<string>;
    readonly roles: ReadonlySet<string>;
    readonly hasExplicitSelection: boolean;
}

export interface DistributedRunMonitorRecipeMembership extends DistributedRunMonitorRecipeSelectionKey {
    readonly targetCount: number;
}

interface TargetAgentIndex {
    readonly membershipByAgentId: ReadonlyMap<string, DistributedRunMonitorTargetAgentMembership>;
    readonly multiplicityByAgentId: ReadonlyMap<string, number>;
    readonly byAssignedRecipeId: SelectedTargetIndex;
    readonly byRole: SelectedTargetIndex;
    /** Targets with no recipe assignment, or none a selection names, run every role-less recipe. */
    readonly unroledFallbackMultiplicity: number;
}

interface SelectedTargetIndex {
    readonly targetAgentIdsByValue: ReadonlyMap<string, ReadonlySet<string>>;
    readonly multiplicityByValue: ReadonlyMap<string, number>;
}

interface MutableSelectedTargetIndex extends SelectedTargetIndex {
    readonly targetAgentIdsByValue: Map<string, Set<string>>;
    readonly multiplicityByValue: Map<string, number>;
}

interface ToTargetAgentIndexInput {
    readonly multiplicityByAgentId: ReadonlyMap<string, number>;
    readonly assignments: DistributedRunMonitorAssignmentMembership;
    readonly recipes: DistributedRunMonitorRecipeSelectionKeys;
}

interface AddSelectedTargetsInput {
    readonly agentId: string;
    readonly multiplicity: number;
    readonly values: ReadonlySet<string>;
    readonly selectedValues: ReadonlySet<string>;
}

interface ComputeIntersectionMultiplicityInput {
    readonly recipeId: string;
    readonly role: string;
    readonly targets: TargetAgentIndex;
}

const EMPTY_STRINGS: ReadonlySet<string> = new Set();

/** Each recipe counts its target slots once: direct recipe assignments plus role matches minus their overlap. */
export function computeDistributedRunMonitorTargetMembership(
    input: ComputeDistributedRunMonitorTargetMembershipInput
): DistributedRunMonitorTargetMembership {
    const targetAgentIds: string[] = [];
    const multiplicityByAgentId = new Map<string, number>();
    for (const agentId of input.targetAgentIds) {
        targetAgentIds.push(agentId);
        incrementMultiplicity(multiplicityByAgentId, agentId, 1);
    }
    const targets = toTargetAgentIndex({
        multiplicityByAgentId,
        assignments: input.assignments,
        recipes: input.recipes
    });
    const overlapByRecipeIdAndRole = computeOverlapByRecipeIdAndRole(input.recipes, targets);

    return {
        targetAgentIds,
        membershipByAgentId: targets.membershipByAgentId,
        recipes: input.recipes.selections.map((recipe) => ({
            ...recipe,
            targetCount: computeRecipeTargetCount(recipe, targets, overlapByRecipeIdAndRole)
        }))
    };
}

function toTargetAgentIndex(input: ToTargetAgentIndexInput): TargetAgentIndex {
    const { assignments, recipes } = input;
    const membershipByAgentId = new Map<string, DistributedRunMonitorTargetAgentMembership>();
    const byAssignedRecipeId = createEmptySelectedTargetIndex();
    const byRole = createEmptySelectedTargetIndex();
    let unroledFallbackMultiplicity = 0;
    for (const [agentId, multiplicity] of input.multiplicityByAgentId) {
        const assignedRecipeIds = assignments.assignedRecipeIdsByAgentId.get(agentId) ?? EMPTY_STRINGS;
        const roles = assignments.expectedRolesByAgentId.get(agentId) ?? EMPTY_STRINGS;
        const hasExplicitSelection = hasSelectedValue(assignedRecipeIds, recipes.selectedRecipeKeys) ||
            hasSelectedValue(roles, recipes.selectedRoles);
        membershipByAgentId.set(agentId, { multiplicity, assignedRecipeIds, roles, hasExplicitSelection });
        if (assignedRecipeIds.size === 0 || !hasExplicitSelection) {
            unroledFallbackMultiplicity += multiplicity;
        }
        addSelectedTargets(byAssignedRecipeId, {
            agentId,
            multiplicity,
            values: assignedRecipeIds,
            selectedValues: recipes.selectedRecipeKeys
        });
        addSelectedTargets(byRole, { agentId, multiplicity, values: roles, selectedValues: recipes.selectedRoles });
    }
    return {
        membershipByAgentId,
        multiplicityByAgentId: input.multiplicityByAgentId,
        byAssignedRecipeId,
        byRole,
        unroledFallbackMultiplicity
    };
}

/** Selections repeating one recipe id and role share one intersection count. */
function computeOverlapByRecipeIdAndRole(
    recipes: DistributedRunMonitorRecipeSelectionKeys,
    targets: TargetAgentIndex
): ReadonlyMap<string, ReadonlyMap<string, number>> {
    const overlapByRecipeIdAndRole = new Map<string, Map<string, number>>();
    for (const { selection, selectionKey } of recipes.selections) {
        const role = selection.role;
        if (!selectionKey || !role) {
            continue;
        }
        const overlapByRole = overlapByRecipeIdAndRole.get(selectionKey) ?? new Map<string, number>();
        if (!overlapByRole.has(role)) {
            overlapByRole.set(role, computeIntersectionMultiplicity({ recipeId: selectionKey, role, targets }));
        }
        overlapByRecipeIdAndRole.set(selectionKey, overlapByRole);
    }
    return overlapByRecipeIdAndRole;
}

function computeRecipeTargetCount(
    recipe: DistributedRunMonitorRecipeSelectionKey,
    targets: TargetAgentIndex,
    overlapByRecipeIdAndRole: ReadonlyMap<string, ReadonlyMap<string, number>>
): number {
    const directMultiplicity = recipe.selectionKey
        ? targets.byAssignedRecipeId.multiplicityByValue.get(recipe.selectionKey) ?? 0
        : 0;
    const role = recipe.selection.role;
    if (!role) {
        return targets.unroledFallbackMultiplicity + directMultiplicity;
    }
    const overlap = recipe.selectionKey
        ? overlapByRecipeIdAndRole.get(recipe.selectionKey)?.get(role) ?? 0
        : 0;
    return directMultiplicity + (targets.byRole.multiplicityByValue.get(role) ?? 0) - overlap;
}

function computeIntersectionMultiplicity(input: ComputeIntersectionMultiplicityInput): number {
    const directTargets = input.targets.byAssignedRecipeId.targetAgentIdsByValue.get(input.recipeId) ?? EMPTY_STRINGS;
    const roleTargets = input.targets.byRole.targetAgentIdsByValue.get(input.role) ?? EMPTY_STRINGS;
    const [candidates, membership] = directTargets.size <= roleTargets.size
        ? [directTargets, roleTargets]
        : [roleTargets, directTargets];
    let intersectionMultiplicity = 0;
    for (const agentId of candidates) {
        if (membership.has(agentId)) {
            intersectionMultiplicity += input.targets.multiplicityByAgentId.get(agentId) ?? 0;
        }
    }
    return intersectionMultiplicity;
}

function hasSelectedValue(values: ReadonlySet<string>, selectedValues: ReadonlySet<string>): boolean {
    for (const value of values) {
        if (selectedValues.has(value)) {
            return true;
        }
    }
    return false;
}

function createEmptySelectedTargetIndex(): MutableSelectedTargetIndex {
    return { targetAgentIdsByValue: new Map(), multiplicityByValue: new Map() };
}

function addSelectedTargets(index: MutableSelectedTargetIndex, input: AddSelectedTargetsInput): void {
    for (const value of input.values) {
        if (!input.selectedValues.has(value)) {
            continue;
        }
        const targetAgentIds = index.targetAgentIdsByValue.get(value);
        if (targetAgentIds) {
            targetAgentIds.add(input.agentId);
        }
        else {
            index.targetAgentIdsByValue.set(value, new Set([input.agentId]));
        }
        incrementMultiplicity(index.multiplicityByValue, value, input.multiplicity);
    }
}

function incrementMultiplicity(multiplicityByValue: Map<string, number>, value: string, multiplicity: number): void {
    multiplicityByValue.set(value, (multiplicityByValue.get(value) ?? 0) + multiplicity);
}
