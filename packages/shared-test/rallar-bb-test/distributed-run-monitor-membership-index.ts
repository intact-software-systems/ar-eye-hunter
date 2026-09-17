import type { ControlDistributedRunSnapshot } from './control-snapshots.ts';
import { resolveDistributedRunRecipeSelectionKey } from './distributed-run-evidence.ts';
import type { RallarBlackBoxDistributedRunRecipeSelection } from './distributed-run.ts';

type RecipeMembershipDescriptor = Readonly<{
    selectionKey?: string;
    role?: string;
}>;

type TargetMembershipDescriptor = Readonly<{
    multiplicity: number;
    assignedRecipeIds: ReadonlySet<string>;
    roles: ReadonlySet<string>;
    hasExplicitSelection: boolean;
}>;

export type DistributedRunMonitorMembershipIndex = Readonly<{
    targetAgentIds: readonly string[];
    recipeSelections: readonly RallarBlackBoxDistributedRunRecipeSelection[];
    recipeIds: readonly string[];
    roleByAgentId: ReadonlyMap<string, string>;
    recipeMembershipDescriptors: readonly RecipeMembershipDescriptor[];
    targetMembershipByAgentId: ReadonlyMap<string, TargetMembershipDescriptor>;
    targetCountByRecipeIndex: readonly number[];
}>;

export function createDistributedRunMonitorMembershipIndex(
    distributedRun: ControlDistributedRunSnapshot
): DistributedRunMonitorMembershipIndex {
    const resolvedAssignments = distributedRun.targetResolution?.roleAssignments;
    const assignments = resolvedAssignments ?? distributedRun.manifest.roleAssignments;
    const displayRolesByAgentId = new Map<string, string[]>();
    const expectedRolesByAgentId = new Map<string, Set<string>>();
    const assignedRecipeIdsByAgentId = new Map<string, Set<string>>();

    for (const assignment of assignments) {
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

    const recipeSelections: RallarBlackBoxDistributedRunRecipeSelection[] = [];
    const recipeIds: string[] = [];
    const recipeMembershipDescriptors: RecipeMembershipDescriptor[] = [];
    const targetCountByRecipeIndex: number[] = [];
    const selectedRecipeKeys = new Set<string>();
    const selectedRoles = new Set<string>();
    let recipeIndex = 0;
    for (const selection of distributedRun.manifest.recipes) {
        recipeSelections.push(selection);
        const selectionKey = resolveDistributedRunRecipeSelectionKey(selection) || undefined;
        const recipeId = selectionKey ?? `recipe-${recipeIndex + 1}`;
        recipeIds.push(recipeId);
        recipeMembershipDescriptors.push({
            selectionKey,
            role: selection.role
        });
        targetCountByRecipeIndex.push(0);
        if (selectionKey) {
            selectedRecipeKeys.add(selectionKey);
        }
        if (selection.role) {
            selectedRoles.add(selection.role);
        }
        recipeIndex += 1;
    }

    const targetAgentIds: string[] = [];
    const targetMultiplicityByAgentId = new Map<string, number>();
    for (const agentId of distributedRun.targetAgentIds) {
        targetAgentIds.push(agentId);
        targetMultiplicityByAgentId.set(
            agentId,
            (targetMultiplicityByAgentId.get(agentId) ?? 0) + 1
        );
    }

    const targetMembershipByAgentId = new Map<string, TargetMembershipDescriptor>();
    const targetAgentIdsByAssignedRecipeId = new Map<string, Set<string>>();
    const targetAgentIdsByRole = new Map<string, Set<string>>();
    const assignedRecipeMultiplicityById = new Map<string, number>();
    const roleMultiplicityByRole = new Map<string, number>();
    let unroledFallbackTargetMultiplicity = 0;
    for (const [agentId, multiplicity] of targetMultiplicityByAgentId) {
        const assignedRecipeIds = assignedRecipeIdsByAgentId.get(agentId) ?? EMPTY_STRINGS;
        const roles = expectedRolesByAgentId.get(agentId) ?? EMPTY_STRINGS;
        const hasExplicitSelection = hasSelectedValue(
            assignedRecipeIds,
            selectedRecipeKeys
        ) || hasSelectedValue(roles, selectedRoles);
        targetMembershipByAgentId.set(agentId, {
            multiplicity,
            assignedRecipeIds,
            roles,
            hasExplicitSelection
        });
        if (assignedRecipeIds.size === 0 || !hasExplicitSelection) {
            unroledFallbackTargetMultiplicity += multiplicity;
        }
        for (const recipeId of assignedRecipeIds) {
            if (!selectedRecipeKeys.has(recipeId)) {
                continue;
            }
            addInvertedTarget(targetAgentIdsByAssignedRecipeId, recipeId, agentId);
            incrementMultiplicity(
                assignedRecipeMultiplicityById,
                recipeId,
                multiplicity
            );
        }
        for (const role of roles) {
            if (!selectedRoles.has(role)) {
                continue;
            }
            addInvertedTarget(targetAgentIdsByRole, role, agentId);
            incrementMultiplicity(roleMultiplicityByRole, role, multiplicity);
        }
    }

    const intersectionMultiplicityByRecipeIdAndRole = new Map<string, Map<string, number>>();
    for (let selectionIndex = 0; selectionIndex < recipeMembershipDescriptors.length; selectionIndex += 1) {
        const descriptor = recipeMembershipDescriptors[selectionIndex]!;
        const directMultiplicity = descriptor.selectionKey
            ? assignedRecipeMultiplicityById.get(descriptor.selectionKey) ?? 0
            : 0;
        if (!descriptor.role) {
            targetCountByRecipeIndex[selectionIndex] = unroledFallbackTargetMultiplicity + directMultiplicity;
            continue;
        }
        const roleMultiplicity = roleMultiplicityByRole.get(descriptor.role) ?? 0;
        const overlap = descriptor.selectionKey
            ? cachedIntersectionMultiplicity({
                recipeId: descriptor.selectionKey,
                role: descriptor.role,
                targetAgentIdsByAssignedRecipeId,
                targetAgentIdsByRole,
                targetMultiplicityByAgentId,
                intersectionMultiplicityByRecipeIdAndRole
            })
            : 0;
        targetCountByRecipeIndex[selectionIndex] = directMultiplicity + roleMultiplicity - overlap;
    }

    return {
        targetAgentIds,
        recipeSelections,
        recipeIds,
        roleByAgentId: new Map([...displayRolesByAgentId].map(([agentId, roles]) => [
            agentId,
            roles.join(', ')
        ])),
        recipeMembershipDescriptors,
        targetMembershipByAgentId,
        targetCountByRecipeIndex
    };
}

export function distributedRunMonitorAgentRole(
    index: DistributedRunMonitorMembershipIndex,
    agentId: string
): string | undefined {
    return index.roleByAgentId.get(agentId);
}

export function distributedRunMonitorRecipeTargetCount(
    index: DistributedRunMonitorMembershipIndex,
    recipeIndex: number
): number {
    return index.targetCountByRecipeIndex[recipeIndex] ?? 0;
}

export function distributedRunMonitorExpectedTargetMultiplicity(
    index: DistributedRunMonitorMembershipIndex,
    recipeIndex: number,
    agentId: string
): number {
    const target = index.targetMembershipByAgentId.get(agentId);
    const recipe = index.recipeMembershipDescriptors[recipeIndex];
    if (target === undefined || recipe === undefined) {
        return 0;
    }
    if (target.assignedRecipeIds.size === 0) {
        return recipe.role
            ? target.roles.has(recipe.role) ? target.multiplicity : 0
            : target.multiplicity;
    }
    if (
        (recipe.selectionKey && target.assignedRecipeIds.has(recipe.selectionKey)) ||
        (recipe.role && target.roles.has(recipe.role))
    ) {
        return target.multiplicity;
    }
    return !recipe.role && !target.hasExplicitSelection
        ? target.multiplicity
        : 0;
}

const EMPTY_STRINGS: ReadonlySet<string> = new Set();

function hasSelectedValue(
    values: ReadonlySet<string>,
    selectedValues: ReadonlySet<string>
): boolean {
    for (const value of values) {
        if (selectedValues.has(value)) {
            return true;
        }
    }
    return false;
}

function addInvertedTarget(
    targetsByValue: Map<string, Set<string>>,
    value: string,
    agentId: string
): void {
    const targets = targetsByValue.get(value);
    if (targets) {
        targets.add(agentId);
    }
    else {
        targetsByValue.set(value, new Set([agentId]));
    }
}

function incrementMultiplicity(
    multiplicityByValue: Map<string, number>,
    value: string,
    multiplicity: number
): void {
    multiplicityByValue.set(
        value,
        (multiplicityByValue.get(value) ?? 0) + multiplicity
    );
}

function cachedIntersectionMultiplicity(
    input: Readonly<{
        recipeId: string;
        role: string;
        targetAgentIdsByAssignedRecipeId: ReadonlyMap<string, ReadonlySet<string>>;
        targetAgentIdsByRole: ReadonlyMap<string, ReadonlySet<string>>;
        targetMultiplicityByAgentId: ReadonlyMap<string, number>;
        intersectionMultiplicityByRecipeIdAndRole: Map<string, Map<string, number>>;
    }>
): number {
    const cachedByRole = input.intersectionMultiplicityByRecipeIdAndRole.get(
        input.recipeId
    );
    const cached = cachedByRole?.get(input.role);
    if (cached !== undefined) {
        return cached;
    }

    const directTargets = input.targetAgentIdsByAssignedRecipeId.get(input.recipeId) ??
        EMPTY_STRINGS;
    const roleTargets = input.targetAgentIdsByRole.get(input.role) ?? EMPTY_STRINGS;
    const [candidates, membership] = directTargets.size <= roleTargets.size
        ? [directTargets, roleTargets]
        : [roleTargets, directTargets];
    let intersectionMultiplicity = 0;
    for (const agentId of candidates) {
        if (membership.has(agentId)) {
            intersectionMultiplicity += input.targetMultiplicityByAgentId.get(agentId) ?? 0;
        }
    }
    const byRole = cachedByRole ?? new Map<string, number>();
    if (!cachedByRole) {
        input.intersectionMultiplicityByRecipeIdAndRole.set(input.recipeId, byRole);
    }
    byRole.set(input.role, intersectionMultiplicity);
    return intersectionMultiplicity;
}

function appendMapValue<Key, Value>(
    map: Map<Key, Value[]>,
    key: Key,
    value: Value
): void {
    const values = map.get(key);
    if (values) {
        values.push(value);
    }
    else {
        map.set(key, [value]);
    }
}

function addMapSetValue<Key, Value>(
    map: Map<Key, Set<Value>>,
    key: Key,
    value: Value
): void {
    const values = map.get(key);
    if (values) {
        values.add(value);
    }
    else {
        map.set(key, new Set([value]));
    }
}
