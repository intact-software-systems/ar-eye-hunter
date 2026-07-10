import type { RallarBlackBoxDistributedRunRecipeSelection } from './distributed-run.ts';
import type { ControlDistributedRunSnapshot } from './control-snapshots.ts';
import { distributedRunRecipeSelectionKey } from './distributed-run-evidence.ts';

export type DistributedRunMonitorMembershipWork = {
    targetAgentIndexPassCount: number;
    targetAgentVisitCount: number;
    recipeSelectionIndexPassCount: number;
    recipeSelectionVisitCount: number;
    roleAssignmentIndexPassCount: number;
    roleAssignmentVisitCount: number;
    targetPolicyRoleMembershipVisitCount: number;
    membershipDescriptorBuildCount: number;
    membershipInvertedIndexWriteCount: number;
    membershipIntersectionCandidateVisitCount: number;
    recipeTargetCountProjectionVisitCount: number;
    retainedMembershipDescriptorCount: number;
    retainedRecipeTargetCountCount: number;
    agentRoleLookupCount: number;
    recipeTargetCountLookupCount: number;
    linkedAgentExpectedMembershipProbeCount: number;
};

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
    distributedRun: ControlDistributedRunSnapshot,
    work: DistributedRunMonitorMembershipWork,
): DistributedRunMonitorMembershipIndex {
    work.roleAssignmentIndexPassCount += 1;
    const resolvedAssignments = distributedRun.targetResolution?.roleAssignments;
    const assignments = resolvedAssignments ?? distributedRun.manifest.roleAssignments ?? [];
    const displayRolesByAgentId = new Map<string, string[]>();
    const expectedRolesByAgentId = new Map<string, Set<string>>();
    const assignedRecipeIdsByAgentId = new Map<string, Set<string>>();

    for (const assignment of assignments) {
        work.roleAssignmentVisitCount += 1;
        appendMapValue(displayRolesByAgentId, assignment.agentId, assignment.role);
        addMapSetValue(expectedRolesByAgentId, assignment.agentId, assignment.role);
        for (const recipeId of assignment.recipeIds ?? []) {
            addMapSetValue(assignedRecipeIdsByAgentId, assignment.agentId, recipeId);
        }
    }

    if (resolvedAssignments === undefined) {
        for (const [role, agentIds] of Object.entries(
            distributedRun.manifest.targetPolicy.roles ?? {},
        )) {
            for (const agentId of agentIds) {
                work.targetPolicyRoleMembershipVisitCount += 1;
                addMapSetValue(expectedRolesByAgentId, agentId, role);
            }
        }
    }

    work.recipeSelectionIndexPassCount += 1;
    const recipeSelections: RallarBlackBoxDistributedRunRecipeSelection[] = [];
    const recipeIds: string[] = [];
    const recipeMembershipDescriptors: RecipeMembershipDescriptor[] = [];
    const targetCountByRecipeIndex: number[] = [];
    const selectedRecipeKeys = new Set<string>();
    const selectedRoles = new Set<string>();
    let recipeIndex = 0;
    for (const selection of distributedRun.manifest.recipes) {
        work.recipeSelectionVisitCount += 1;
        recipeSelections.push(selection);
        const recipeId = distributedRunRecipeSelectionKey(selection) ??
            `recipe-${recipeIndex + 1}`;
        recipeIds.push(recipeId);
        const selectionKey = distributedRunRecipeSelectionKey(selection);
        recipeMembershipDescriptors.push({
            selectionKey,
            role: selection.role,
        });
        targetCountByRecipeIndex.push(0);
        work.retainedRecipeTargetCountCount += 1;
        if (selectionKey) selectedRecipeKeys.add(selectionKey);
        if (selection.role) selectedRoles.add(selection.role);
        recipeIndex += 1;
    }

    work.targetAgentIndexPassCount += 1;
    const targetAgentIds: string[] = [];
    const targetMultiplicityByAgentId = new Map<string, number>();
    for (const agentId of distributedRun.targetAgentIds) {
        work.targetAgentVisitCount += 1;
        targetAgentIds.push(agentId);
        targetMultiplicityByAgentId.set(
            agentId,
            (targetMultiplicityByAgentId.get(agentId) ?? 0) + 1,
        );
    }

    const targetMembershipByAgentId = new Map<string, TargetMembershipDescriptor>();
    const targetAgentIdsByAssignedRecipeId = new Map<string, Set<string>>();
    const targetAgentIdsByRole = new Map<string, Set<string>>();
    const assignedRecipeMultiplicityById = new Map<string, number>();
    const roleMultiplicityByRole = new Map<string, number>();
    let unroledFallbackTargetMultiplicity = 0;
    for (const [agentId, multiplicity] of targetMultiplicityByAgentId) {
        work.membershipDescriptorBuildCount += 1;
        const assignedRecipeIds = assignedRecipeIdsByAgentId.get(agentId) ?? EMPTY_STRINGS;
        const roles = expectedRolesByAgentId.get(agentId) ?? EMPTY_STRINGS;
        const hasExplicitSelection = hasSelectedValue(
            assignedRecipeIds,
            selectedRecipeKeys,
        ) || hasSelectedValue(roles, selectedRoles);
        targetMembershipByAgentId.set(agentId, {
            multiplicity,
            assignedRecipeIds,
            roles,
            hasExplicitSelection,
        });
        work.retainedMembershipDescriptorCount += 1;
        if (assignedRecipeIds.size === 0 || !hasExplicitSelection) {
            unroledFallbackTargetMultiplicity += multiplicity;
        }
        for (const recipeId of assignedRecipeIds) {
            if (!selectedRecipeKeys.has(recipeId)) continue;
            addInvertedTarget(
                targetAgentIdsByAssignedRecipeId,
                recipeId,
                agentId,
                work,
            );
            incrementMultiplicity(
                assignedRecipeMultiplicityById,
                recipeId,
                multiplicity,
            );
        }
        for (const role of roles) {
            if (!selectedRoles.has(role)) continue;
            addInvertedTarget(targetAgentIdsByRole, role, agentId, work);
            incrementMultiplicity(roleMultiplicityByRole, role, multiplicity);
        }
    }

    const intersectionMultiplicityByRecipeIdAndRole = new Map<
        string,
        Map<string, number>
    >();
    for (let selectionIndex = 0;
        selectionIndex < recipeMembershipDescriptors.length;
        selectionIndex += 1) {
        work.recipeTargetCountProjectionVisitCount += 1;
        const descriptor = recipeMembershipDescriptors[selectionIndex]!;
        const directMultiplicity = descriptor.selectionKey
            ? assignedRecipeMultiplicityById.get(descriptor.selectionKey) ?? 0
            : 0;
        if (!descriptor.role) {
            targetCountByRecipeIndex[selectionIndex] =
                unroledFallbackTargetMultiplicity + directMultiplicity;
            continue;
        }
        const roleMultiplicity = roleMultiplicityByRole.get(descriptor.role) ?? 0;
        const overlapMultiplicity = descriptor.selectionKey
            ? cachedIntersectionMultiplicity({
                recipeId: descriptor.selectionKey,
                role: descriptor.role,
                targetAgentIdsByAssignedRecipeId,
                targetAgentIdsByRole,
                targetMultiplicityByAgentId,
                intersectionMultiplicityByRecipeIdAndRole,
                work,
            })
            : 0;
        targetCountByRecipeIndex[selectionIndex] =
            directMultiplicity + roleMultiplicity - overlapMultiplicity;
    }

    return {
        targetAgentIds,
        recipeSelections,
        recipeIds,
        roleByAgentId: new Map([...displayRolesByAgentId].map(([agentId, roles]) => [
            agentId,
            roles.join(', '),
        ])),
        recipeMembershipDescriptors,
        targetMembershipByAgentId,
        targetCountByRecipeIndex,
    };
}

export function distributedRunMonitorAgentRole(
    index: DistributedRunMonitorMembershipIndex,
    agentId: string,
    work: DistributedRunMonitorMembershipWork,
): string | undefined {
    work.agentRoleLookupCount += 1;
    return index.roleByAgentId.get(agentId);
}

export function distributedRunMonitorRecipeTargetCount(
    index: DistributedRunMonitorMembershipIndex,
    recipeIndex: number,
    work: DistributedRunMonitorMembershipWork,
): number {
    work.recipeTargetCountLookupCount += 1;
    return index.targetCountByRecipeIndex[recipeIndex] ?? 0;
}

export function distributedRunMonitorExpectedTargetMultiplicity(
    index: DistributedRunMonitorMembershipIndex,
    recipeIndex: number,
    agentId: string,
    work: DistributedRunMonitorMembershipWork,
): number {
    work.linkedAgentExpectedMembershipProbeCount += 1;
    const target = index.targetMembershipByAgentId.get(agentId);
    const recipe = index.recipeMembershipDescriptors[recipeIndex];
    if (target === undefined || recipe === undefined) return 0;
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
    selectedValues: ReadonlySet<string>,
): boolean {
    for (const value of values) {
        if (selectedValues.has(value)) return true;
    }
    return false;
}

function addInvertedTarget(
    targetsByValue: Map<string, Set<string>>,
    value: string,
    agentId: string,
    work: DistributedRunMonitorMembershipWork,
): void {
    const targets = targetsByValue.get(value);
    if (targets) targets.add(agentId);
    else targetsByValue.set(value, new Set([agentId]));
    work.membershipInvertedIndexWriteCount += 1;
}

function incrementMultiplicity(
    multiplicityByValue: Map<string, number>,
    value: string,
    multiplicity: number,
): void {
    multiplicityByValue.set(
        value,
        (multiplicityByValue.get(value) ?? 0) + multiplicity,
    );
}

function cachedIntersectionMultiplicity(input: Readonly<{
    recipeId: string;
    role: string;
    targetAgentIdsByAssignedRecipeId: ReadonlyMap<string, ReadonlySet<string>>;
    targetAgentIdsByRole: ReadonlyMap<string, ReadonlySet<string>>;
    targetMultiplicityByAgentId: ReadonlyMap<string, number>;
    intersectionMultiplicityByRecipeIdAndRole: Map<string, Map<string, number>>;
    work: DistributedRunMonitorMembershipWork;
}>): number {
    const cachedByRole = input.intersectionMultiplicityByRecipeIdAndRole.get(
        input.recipeId,
    );
    const cached = cachedByRole?.get(input.role);
    if (cached !== undefined) return cached;

    const directTargets = input.targetAgentIdsByAssignedRecipeId.get(input.recipeId) ??
        EMPTY_STRINGS;
    const roleTargets = input.targetAgentIdsByRole.get(input.role) ?? EMPTY_STRINGS;
    const [candidates, membership] = directTargets.size <= roleTargets.size
        ? [directTargets, roleTargets]
        : [roleTargets, directTargets];
    let intersectionMultiplicity = 0;
    for (const agentId of candidates) {
        input.work.membershipIntersectionCandidateVisitCount += 1;
        if (membership.has(agentId)) {
            intersectionMultiplicity +=
                input.targetMultiplicityByAgentId.get(agentId) ?? 0;
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
    value: Value,
): void {
    const values = map.get(key);
    if (values) values.push(value);
    else map.set(key, [value]);
}

function addMapSetValue<Key, Value>(
    map: Map<Key, Set<Value>>,
    key: Key,
    value: Value,
): void {
    const values = map.get(key);
    if (values) values.add(value);
    else map.set(key, new Set([value]));
}
