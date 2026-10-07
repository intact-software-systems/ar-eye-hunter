import type {
    RallarBlackBoxControlAgentCandidate,
    RallarBlackBoxDistributedRoleAssignment,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRecipeSelection,
    RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    computeDistributedTargetResolutionSummary,
    toDistributedAgentRecipeSelections
} from '@shared-test/rallar-bb-test/distributed/resolve-distributed-run-targets.ts';
import { snapshotExecutableRecipe } from '@shared-test/rallar-bb-test/recipe/snapshot-executable-recipe.ts';

import { toMissingRtcCaptureSupportReason } from '@shared-test/rallar-bb-test/distributed/rtc-capture-support.ts';
import { RecipeCaptureRequirements } from '@shared-test/rallar-bb-test/recipe/recipe-capture-requirements.ts';

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
        manifest: Object.freeze({
            ...manifest,
            controlRunId,
            group: Object.freeze({ ...manifest.group }),
            recipes: Object.freeze(manifest.recipes.map((selection) =>
                Object.freeze({
                    ...selection,
                    ...(selection.recipe === undefined ? {} : { recipe: snapshotExecutableRecipe(selection.recipe) }),
                    variables: Object.freeze({ ...selection.variables })
                })
            )),
            variables: Object.freeze({ ...manifest.variables }),
            roleAssignments: Object.freeze(manifest.roleAssignments.map((assignment) =>
                Object.freeze({
                    ...assignment,
                    recipeIds: Object.freeze([...assignment.recipeIds]),
                    variables: Object.freeze({ ...assignment.variables })
                })
            )),
            ...(manifest.roleAssignmentPolicy === undefined
                ? {}
                : { roleAssignmentPolicy: Object.freeze({ ...manifest.roleAssignmentPolicy }) }),
            barrier: Object.freeze({ ...manifest.barrier }),
            targetPolicy: manifest.targetPolicy.mode === 'selected-agents'
                ? Object.freeze({
                    ...manifest.targetPolicy,
                    agentIds: Object.freeze([...manifest.targetPolicy.agentIds])
                })
                : manifest.targetPolicy.mode === 'role-map'
                ? Object.freeze({
                    ...manifest.targetPolicy,
                    roles: Object.freeze(
                        Object.fromEntries(
                            Object.entries(manifest.targetPolicy.roles).map((
                                [role, agents]
                            ) => [role, Object.freeze([...agents])])
                        )
                    )
                })
                : Object.freeze({ ...manifest.targetPolicy }),
            groupAssertions: Object.freeze(
                manifest.groupAssertions.map((assertion) =>
                    Object.freeze({
                        ...assertion,
                        source: Object.freeze({ ...assertion.source }),
                        ...(assertion.scope === undefined ? {} : { scope: Object.freeze({ ...assertion.scope }) }),
                        ...('predicate' in assertion ? { predicate: Object.freeze({ ...assertion.predicate }) } : {}),
                        ...('count' in assertion ? { count: Object.freeze({ ...assertion.count }) } : {})
                    })
                )
            ),
            metadata: Object.freeze({ ...manifest.metadata })
        })
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
    return toDistributedAgentRecipeSelections(
        distributedRun.manifest,
        distributedRun.targetResolution?.roleAssignments ?? distributedRun.manifest.roleAssignments,
        agentId
    );
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

export function toDistributedTargetFailure(
    distributedRun: ControlDistributedRunState,
    run: ControlRunState | undefined
): ControlDistributedRunState['error'] {
    const manifest = distributedRun.manifest;
    const captureFailure = toDistributedCaptureFailure(distributedRun, run);
    if (captureFailure) {
        return captureFailure;
    }
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

/** Current support is rechecked without resolving or changing the already selected membership and roles. */
function toDistributedCaptureFailure(
    distributedRun: ControlDistributedRunState,
    run: ControlRunState | undefined
): ControlDistributedRunState['error'] {
    const manifest = distributedRun.manifest;
    const captureBlockers =
        distributedRun.targetResolution?.blockers.filter((blocker) =>
            blocker.status === 'missing-rtc-capture-capability'
        ) ?? [];
    if (captureBlockers.length > 0) {
        return {
            code: 'RALLAR_BB_DISTRIBUTED_CAPTURE_UNSUPPORTED',
            message: captureBlockers.map((blocker) => `${blocker.agentId}: ${blocker.reason}`).join(' '),
            details: { blockers: captureBlockers }
        };
    }
    const captureReasons = distributedRun.targetAgentIds.flatMap((agentId) => {
        const required = new RecipeCaptureRequirements().collect({
            selections: toRecipeSelectionsForAgent(distributedRun, agentId),
            run: manifest.rtcCaptureMode
        });
        const reason = toMissingRtcCaptureSupportReason(
            required,
            run?.agents.get(agentId)?.identity?.capabilities?.rtcCapture
        );
        return reason ? [`${agentId}: ${reason}`] : [];
    });
    if (captureReasons.length > 0) {
        return { code: 'RALLAR_BB_DISTRIBUTED_CAPTURE_UNSUPPORTED', message: captureReasons.join(' ') };
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
                .map((agentId) => ({ role, agentId, recipeIds: [], variables: {} }))
        );
}

function toUniqueIdentifiers(values: readonly string[]): string[] {
    return [
        ...new Set(values.map(toTrimmedIdentifier).filter((value): value is string => value !== undefined))
    ];
}
