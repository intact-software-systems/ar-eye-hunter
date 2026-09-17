import type {
    RallarBlackBoxControlAgentCandidate,
    RallarBlackBoxDistributedRoleAssignment,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRecipeSelection,
    RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { computeDistributedTargetResolutionSummary } from '@shared-test/rallar-bb-test/distributed/resolve-distributed-run-targets.ts';

import type { ControlDistributedRunState, ControlRunState } from '../control-service-state.ts';

export interface NormalizedDistributedRunManifest {
    readonly controlRunId: string;
    readonly manifest: RallarBlackBoxDistributedRunManifest;
}

export const DISTRIBUTED_TARGET_STALE_AFTER_MS = 30_000;

export function toNormalizedDistributedRunManifest(
    manifest: RallarBlackBoxDistributedRunManifest
): NormalizedDistributedRunManifest {
    const controlRunId = manifest.controlRunId.trim();
    return {
        controlRunId,
        manifest: { ...manifest, controlRunId }
    };
}

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
    const manifest = distributedRun.manifest;
    const targetAgentIds = toDistributedTargetAgentIds(distributedRun, run);
    const roleAssignments = toExplicitRoleAssignments(manifest, targetAgentIds);
    const candidates = toControlAgentCandidates(run);
    return {
        group: manifest.group,
        resolvedAtEpochMs: nowEpochMs,
        staleAfterMs: DISTRIBUTED_TARGET_STALE_AFTER_MS,
        targetPolicyMode: manifest.targetPolicy.mode,
        targetAgentIds,
        roleAssignments,
        blockers: [],
        summary: computeDistributedTargetResolutionSummary({
            manifest,
            agents: candidates,
            targetableAgentIds: targetAgentIds,
            targetAgentIds,
            roleAssignments,
            blockers: []
        })
    };
}

export function toDistributedTargetAgentIds(
    distributedRun: ControlDistributedRunState,
    run: ControlRunState | undefined
): string[] {
    const manifest = distributedRun.manifest;
    const policy = manifest.targetPolicy;
    if (policy.mode === 'selected-agents') {
        return toUniqueIdentifiers(policy.agentIds);
    }
    if (policy.mode === 'role-map') {
        return toUniqueIdentifiers([
            ...Object.values(policy.roles).flat(),
            ...manifest.roleAssignments.map((assignment) => assignment.agentId)
        ]);
    }

    return Array.from(run?.agents.values() ?? [])
        .filter((agent) =>
            agent.connected &&
            agent.identity?.applicationId === manifest.group.applicationId &&
            agent.identity.workspaceId === manifest.group.workspaceId &&
            agent.identity.groupId === manifest.group.groupId
        )
        .map((agent) => agent.agentId);
}

export function toRecipeSelectionsForAgent(
    distributedRun: ControlDistributedRunState,
    agentId: string
): readonly RallarBlackBoxDistributedRunRecipeSelection[] {
    const manifest = distributedRun.manifest;
    const roles = toRolesForAgent(distributedRun, agentId);
    const assignedRecipeIds = new Set(
        toRoleAssignmentsForAgent(distributedRun, agentId).flatMap((assignment) => assignment.recipeIds)
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
    const resolvedAssignments = distributedRun.targetResolution?.roleAssignments;
    if (resolvedAssignments) {
        return new Set(
            resolvedAssignments.filter((assignment) => assignment.agentId === agentId).map((assignment) =>
                assignment.role
            )
        );
    }

    const roles = new Set<string>();
    const policyRoles = manifest.targetPolicy.mode === 'role-map' ? manifest.targetPolicy.roles : {};
    for (const [role, agentIds] of Object.entries(policyRoles)) {
        if (agentIds.includes(agentId)) {
            roles.add(role);
        }
    }
    for (const assignment of manifest.roleAssignments) {
        if (assignment.agentId === agentId) {
            roles.add(assignment.role);
        }
    }
    return roles;
}

export function toDistributedRecipeKey(selection: RallarBlackBoxDistributedRunRecipeSelection): string | undefined {
    return toTrimmedIdentifier(selection.recipeId) ??
        toTrimmedIdentifier(selection.recipe?.recipeId) ??
        toTrimmedIdentifier(selection.role);
}

export function toDistributedTargetFailure(
    distributedRun: ControlDistributedRunState
): ControlDistributedRunState['error'] {
    const manifest = distributedRun.manifest;
    if (distributedRun.targetAgentIds.length === 0) {
        return {
            code: 'RALLAR_BB_DISTRIBUTED_NO_TARGET_AGENTS',
            message: 'No target control agents were resolved for this distributed run.',
            details: { targetPolicy: manifest.targetPolicy, group: manifest.group }
        };
    }
    const expectedParticipantCount = manifest.targetPolicy.expectedParticipantCount;
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

function toTrimmedIdentifier(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function toExplicitRoleAssignments(
    manifest: RallarBlackBoxDistributedRunManifest,
    targetAgentIds: readonly string[]
): readonly RallarBlackBoxDistributedRoleAssignment[] {
    const selected = new Set(targetAgentIds);
    const explicitAssignments = manifest.roleAssignments;
    if (explicitAssignments.length > 0) {
        return explicitAssignments
            .filter((assignment) => selected.has(assignment.agentId))
            .map((assignment) => ({ ...assignment }));
    }

    return Object.entries(manifest.targetPolicy.mode === 'role-map' ? manifest.targetPolicy.roles : {})
        .flatMap(([role, agentIds]) =>
            agentIds
                .filter((agentId) => selected.has(agentId))
                .map((agentId) => ({ role, agentId, recipeIds: [], required: true, variables: {} }))
        );
}

function toRoleAssignmentsForAgent(
    distributedRun: ControlDistributedRunState,
    agentId: string
): readonly RallarBlackBoxDistributedRoleAssignment[] {
    const assignments = distributedRun.targetResolution?.roleAssignments ??
        distributedRun.manifest.roleAssignments;
    return assignments.filter((assignment) => assignment.agentId === agentId);
}

function toUniqueIdentifiers(values: readonly string[]): string[] {
    return [
        ...new Set(values.map(toTrimmedIdentifier).filter((value): value is string => value !== undefined))
    ];
}
