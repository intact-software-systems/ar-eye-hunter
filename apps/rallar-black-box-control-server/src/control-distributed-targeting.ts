import {
    type RallarBlackBoxControlAgentCandidate,
    type RallarBlackBoxControlAgentIdentity,
    type RallarBlackBoxDistributedRoleAssignment,
    type RallarBlackBoxDistributedRunManifest,
    type RallarBlackBoxDistributedRunRecipeSelection,
    type RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { ControlDistributedRunState, ControlRunState } from './control-service-state.ts';

export function isResolvedTargetPolicy(manifest: RallarBlackBoxDistributedRunManifest): boolean {
    return manifest.targetPolicy.mode === 'all-online-group-members' ||
        manifest.roleAssignmentPolicy !== undefined;
}
export function toControlAgentCandidates(
    run: ControlRunState | undefined
): readonly RallarBlackBoxControlAgentCandidate[] {
    if (!run) {
        return [];
    }
    return Array.from(run.agents.values(), (agent) => ({
        agentId: agent.agentId,
        connected: agent.connected,
        lastSeenAtEpochMs: agent.lastSeenAtEpochMs,
        lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
        identity: agent.identity
    }));
}
export function toExplicitDistributedTargetResolution(
    distributedRun: ControlDistributedRunState,
    run: ControlRunState | undefined,
    nowEpochMs: number
): RallarBlackBoxDistributedTargetResolution {
    const targetAgentIds = toDistributedTargetAgentIds(distributedRun, run);
    const roleAssignments = toExplicitRoleAssignmentsForTargets(
        distributedRun.manifest,
        targetAgentIds
    );
    const roleCounts = countStrings(roleAssignments.map((assignment) => assignment.role));
    const candidates = toControlAgentCandidates(run);
    const candidateById = new Map(candidates.map((candidate) => [candidate.agentId, candidate]));
    const selectedCandidates = targetAgentIds
        .map((agentId) => candidateById.get(agentId))
        .filter((candidate): candidate is RallarBlackBoxControlAgentCandidate => Boolean(candidate));
    const expected = distributedRun.manifest.targetPolicy.expectedParticipantCount;

    return {
        group: distributedRun.manifest.group,
        resolvedAtEpochMs: nowEpochMs,
        staleAfterMs: 30_000,
        targetPolicyMode: distributedRun.manifest.targetPolicy.mode,
        targetAgentIds,
        roleAssignments,
        blockers: [],
        summary: {
            agents: candidates.length,
            targetable: targetAgentIds.length,
            selected: targetAgentIds.length,
            expectedParticipantCount: expected,
            missingExpectedParticipants: expected === undefined
                ? 0
                : Math.max(0, expected - targetAgentIds.length),
            staleAgents: 0,
            offlineAgents: 0,
            wrongGroupAgents: 0,
            agentsWithoutIdentity: 0,
            roleCounts,
            regions: countStrings(selectedCandidates.map((candidate) => candidate.identity?.region)),
            providers: countStrings(selectedCandidates.map((candidate) => candidate.identity?.provider))
        }
    };
}
export function toExplicitRoleAssignmentsForTargets(
    manifest: RallarBlackBoxDistributedRunManifest,
    targetAgentIds: readonly string[]
): readonly RallarBlackBoxDistributedRoleAssignment[] {
    const selected = new Set(targetAgentIds);
    const explicitAssignments = manifest.roleAssignments ?? [];
    if (explicitAssignments.length > 0) {
        return explicitAssignments
            .filter((assignment) => selected.has(assignment.agentId))
            .map((assignment) => ({ ...assignment }));
    }

    return Object.entries(manifest.targetPolicy.roles ?? {})
        .flatMap(([role, agentIds]) =>
            agentIds
                .filter((agentId) => selected.has(agentId))
                .map((agentId) => ({ role, agentId, required: true }))
        );
}
export function toDistributedTargetAgentIds(
    distributedRun: ControlDistributedRunState,
    run: ControlRunState | undefined
): string[] {
    const policy = distributedRun.manifest.targetPolicy;
    const unique = (values: readonly string[]) => [
        ...new Set(
            values.map(cleanSegment).filter((value): value is string => Boolean(value))
        )
    ];

    if (policy.mode === 'selected-agents') {
        return unique(policy.agentIds ?? []);
    }

    if (policy.mode === 'role-map') {
        return unique([
            ...Object.values(policy.roles ?? {}).flat(),
            ...(distributedRun.manifest.roleAssignments ?? []).map((assignment) => assignment.agentId)
        ]);
    }

    if (!run) {
        return [];
    }

    return Array.from(run.agents.values())
        .filter((agent) =>
            agent.connected &&
            isDistributedGroupIdentity(agent.identity, distributedRun.manifest)
        )
        .map((agent) => agent.agentId);
}
export function isDistributedGroupIdentity(
    identity: RallarBlackBoxControlAgentIdentity | undefined,
    manifest: RallarBlackBoxDistributedRunManifest
): boolean {
    return identity?.applicationId === manifest.group.applicationId &&
        identity.workspaceId === manifest.group.workspaceId &&
        identity.groupId === manifest.group.groupId;
}
export function toRecipeSelectionsForAgent(
    distributedRun: ControlDistributedRunState,
    agentId: string
): readonly RallarBlackBoxDistributedRunRecipeSelection[] {
    const manifest = distributedRun.manifest;
    const roles = toRolesForAgent(distributedRun, agentId);
    const assignments = toRoleAssignmentsForAgent(distributedRun, agentId);
    const assignedRecipeIds = new Set(
        assignments.flatMap((assignment) => assignment.recipeIds ?? [])
    );
    const selections = manifest.recipes.filter((selection) => {
        const recipeId = toDistributedRecipeKey(selection);
        if (assignedRecipeIds.size > 0 && recipeId && assignedRecipeIds.has(recipeId)) {
            return true;
        }
        if (selection.role) {
            return roles.has(selection.role);
        }
        return assignedRecipeIds.size === 0;
    });

    return selections.length > 0
        ? selections
        : manifest.recipes.filter((selection) => !selection.role);
}
export function toRolesForAgent(
    distributedRun: ControlDistributedRunState,
    agentId: string
): Set<string> {
    const manifest = distributedRun.manifest;
    const roles = new Set<string>();
    const resolvedAssignments = distributedRun.targetResolution?.roleAssignments;
    if (resolvedAssignments) {
        for (const assignment of resolvedAssignments) {
            if (assignment.agentId === agentId) {
                roles.add(assignment.role);
            }
        }
        return roles;
    }

    for (const [role, agentIds] of Object.entries(manifest.targetPolicy.roles ?? {})) {
        if (agentIds.includes(agentId)) {
            roles.add(role);
        }
    }
    for (const assignment of manifest.roleAssignments ?? []) {
        if (assignment.agentId === agentId) {
            roles.add(assignment.role);
        }
    }
    return roles;
}
export function toRoleAssignmentsForAgent(
    distributedRun: ControlDistributedRunState,
    agentId: string
): readonly RallarBlackBoxDistributedRoleAssignment[] {
    const assignments = distributedRun.targetResolution?.roleAssignments ??
        distributedRun.manifest.roleAssignments ??
        [];
    return assignments.filter((assignment) => assignment.agentId === agentId);
}
export function toDistributedRecipeKey(selection: RallarBlackBoxDistributedRunRecipeSelection): string | undefined {
    return cleanSegment(selection.recipeId) ??
        cleanSegment(selection.recipe?.recipeId) ??
        cleanSegment(selection.role) ??
        undefined;
}
function countStrings(values: readonly unknown[]): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const value of values) {
        if (typeof value !== 'string' || value.trim().length === 0) {
            continue;
        }
        const key = value.trim();
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
    );
}
function cleanSegment(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function toDistributedTargetFailure(
    distributedRun: ControlDistributedRunState
): ControlDistributedRunState['error'] {
    if (distributedRun.targetAgentIds.length === 0) {
        return {
            code: 'RALLAR_BB_DISTRIBUTED_NO_TARGET_AGENTS',
            message: 'No target control agents were resolved for this distributed run.',
            details: { targetPolicy: distributedRun.manifest.targetPolicy, group: distributedRun.manifest.group }
        };
    }
    const expectedParticipantCount = distributedRun.manifest.targetPolicy.expectedParticipantCount;
    if (expectedParticipantCount !== undefined && distributedRun.targetAgentIds.length !== expectedParticipantCount) {
        return {
            code: 'RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH',
            message:
                `Resolved ${distributedRun.targetAgentIds.length} target agents, expected ${expectedParticipantCount}.`,
            details: { targetAgentIds: distributedRun.targetAgentIds, expectedParticipantCount }
        };
    }
    return undefined;
}
