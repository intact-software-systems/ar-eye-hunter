import { toRolesForPattern } from '../distributed-recipe-targeting/distributed-recipe-role-pattern.ts';
import type {
    RallarBlackBoxControlAgentCandidate,
    RallarBlackBoxControlAgentIdentity,
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRoleAssignment,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRecipeSelection,
    RallarBlackBoxDistributedTargetBlocker,
    RallarBlackBoxDistributedTargetResolution,
    RallarBlackBoxDistributedTargetResolutionSummary
} from '../distributed-run.ts';
import {
    computeDistributedAssertionFeatures,
    toMissingAssertionCapabilityReason,
    validateAgentAssertionCapability,
    type DistributedAssertionFeatures
} from './control-agent-capabilities.ts';

import { RecipeCaptureRequirements } from '../recipe/recipe-capture-requirements.ts';
import { toMissingRtcCaptureSupportReason } from './rtc-capture-support.ts';

export interface ResolveDistributedRunTargetsInput {
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly agents: readonly RallarBlackBoxControlAgentCandidate[];
    readonly nowEpochMs: number;
    readonly staleAfterMs: number;
}

export interface ComputeDistributedTargetResolutionSummaryInput {
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly agents: readonly RallarBlackBoxControlAgentCandidate[];
    readonly targetableAgentIds: readonly string[];
    readonly targetAgentIds: readonly string[];
    readonly roleAssignments: readonly RallarBlackBoxDistributedRoleAssignment[];
    readonly blockers: readonly RallarBlackBoxDistributedTargetBlocker[];
}

interface ResolveDistributedTargetBlockerInput {
    readonly agent: RallarBlackBoxControlAgentCandidate;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly nowEpochMs: number;
    readonly staleAfterMs: number;
    readonly assertionFeatures: DistributedAssertionFeatures;
}

export function resolveDistributedRunTargets(
    input: ResolveDistributedRunTargetsInput
): RallarBlackBoxDistributedTargetResolution {
    const assertionFeatures = computeDistributedAssertionFeatures(
        input.manifest.recipes.flatMap((selection) => selection.recipe === undefined ? [] : [selection.recipe])
    );
    const blockers: RallarBlackBoxDistributedTargetBlocker[] = [];
    const targetableAgentIds: string[] = [];
    for (const agent of input.agents) {
        const blocker = resolveDistributedTargetBlocker({
            agent,
            group: input.manifest.group,
            nowEpochMs: input.nowEpochMs,
            staleAfterMs: input.staleAfterMs,
            assertionFeatures
        });
        if (blocker) {
            blockers.push(blocker);
        }
        else {
            targetableAgentIds.push(agent.agentId);
        }
    }

    const selectedAgentIds = resolveDistributedSelectedAgentIds(input.manifest, targetableAgentIds);
    const selectedRoles = resolveDistributedRoleAssignments(input.manifest, selectedAgentIds);
    blockers.push(
        ...toDistributedCaptureBlockers({ ...input, selectedAgentIds, selectedRoles, eligibilityBlockers: blockers })
    );
    const blocked = new Set(blockers.map((blocker) => blocker.agentId));
    const targetable = new Set(targetableAgentIds);
    const targetAgentIds = selectedAgentIds.filter((agentId) => targetable.has(agentId) && !blocked.has(agentId));
    const selected = new Set(targetAgentIds);
    const roleAssignments = selectedRoles.filter((assignment) => selected.has(assignment.agentId));
    return {
        group: input.manifest.group,
        resolvedAtEpochMs: input.nowEpochMs,
        staleAfterMs: input.staleAfterMs,
        targetPolicyMode: input.manifest.targetPolicy.mode,
        targetAgentIds,
        roleAssignments,
        blockers,
        summary: computeDistributedTargetResolutionSummary({
            manifest: input.manifest,
            agents: input.agents,
            targetableAgentIds: targetableAgentIds.filter((agentId) => !blocked.has(agentId)),
            targetAgentIds,
            roleAssignments,
            blockers
        })
    };
}

/** Capture eligibility depends on the actual role-selected executable requirements. */
interface DistributedCaptureBlockersInput extends ResolveDistributedRunTargetsInput {
    readonly selectedAgentIds: readonly string[];
    readonly selectedRoles: readonly RallarBlackBoxDistributedRoleAssignment[];
    readonly eligibilityBlockers: readonly RallarBlackBoxDistributedTargetBlocker[];
}

function toDistributedCaptureBlockers(
    input: DistributedCaptureBlockersInput
): readonly RallarBlackBoxDistributedTargetBlocker[] {
    const blockers: RallarBlackBoxDistributedTargetBlocker[] = [];
    for (const agentId of input.selectedAgentIds) {
        const identity = input.agents.find((agent) => agent.agentId === agentId)?.identity;
        const required = new RecipeCaptureRequirements().collect({
            selections: toDistributedAgentRecipeSelections(input.manifest, input.selectedRoles, agentId),
            run: input.manifest.rtcCaptureMode
        });
        if (required.length === 0) {
            continue;
        }
        const unavailable = input.eligibilityBlockers.find((blocker) => blocker.agentId === agentId);
        const reason = unavailable
            ? `Required RTC capture target is unavailable: ${unavailable.reason}`
            : toMissingRtcCaptureSupportReason(required, identity?.capabilities?.rtcCapture);
        if (reason) {
            const status = 'missing-rtc-capture-capability';
            blockers.push(identity ? { agentId, identity, status, reason } : { agentId, status, reason });
        }
    }
    return blockers;
}

/** Every blocker counter counts the resolution's blockers, so a resolution that blocks no agent counts zero of each. */
export function computeDistributedTargetResolutionSummary(
    input: ComputeDistributedTargetResolutionSummaryInput
): RallarBlackBoxDistributedTargetResolutionSummary {
    const expected = input.manifest.targetPolicy.expectedParticipantCount;
    const countBlockers = (status: RallarBlackBoxDistributedTargetBlocker['status']): number =>
        input.blockers.filter((blocker) => blocker.status === status).length;
    const selectedAgentIds = new Set(input.targetAgentIds);
    const selectedAgents = input.agents.filter((agent) => selectedAgentIds.has(agent.agentId));

    return {
        agents: input.agents.length,
        targetable: input.targetableAgentIds.length,
        selected: input.targetAgentIds.length,
        expectedParticipantCount: expected,
        missingExpectedParticipants: expected === undefined
            ? 0
            : Math.max(0, expected - input.targetAgentIds.length),
        staleAgents: countBlockers('stale-agent'),
        offlineAgents: countBlockers('offline-agent'),
        wrongGroupAgents: countBlockers('different-group'),
        assertionCapabilityBlockedAgents: countBlockers('missing-assertion-capability'),
        agentsWithoutIdentity: countBlockers('agent-without-identity'),
        roleCounts: computeSortedCounts(input.roleAssignments.map((assignment) => assignment.role)),
        regions: computeSortedCounts(toNonEmptyTexts(selectedAgents.map((agent) => agent.identity?.region))),
        providers: computeSortedCounts(toNonEmptyTexts(selectedAgents.map((agent) => agent.identity?.provider)))
    };
}

function resolveDistributedTargetBlocker(
    input: ResolveDistributedTargetBlockerInput
): RallarBlackBoxDistributedTargetBlocker | undefined {
    const { agentId, identity } = input.agent;
    if (!identity) {
        return {
            agentId,
            status: 'agent-without-identity',
            reason: 'Control agent has not reported Rallar identity metadata.'
        };
    }
    if (!isControlAgentIdentityInGroup(identity, input.group)) {
        return {
            agentId,
            status: 'different-group',
            reason: 'Control agent reports a different application, workspace, or group.',
            identity
        };
    }
    if (!input.agent.connected) {
        return { agentId, status: 'offline-agent', reason: 'Control agent is offline.', identity };
    }
    if (isControlAgentStale(input)) {
        return { agentId, status: 'stale-agent', reason: 'Control agent heartbeat is stale.', identity };
    }
    const missingAssertionCapabilities = validateAgentAssertionCapability(
        input.assertionFeatures,
        identity.capabilities
    );
    return missingAssertionCapabilities.length > 0
        ? {
            agentId,
            status: 'missing-assertion-capability',
            reason: toMissingAssertionCapabilityReason(missingAssertionCapabilities),
            identity
        }
        : undefined;
}

/** One command-link key shared by selection, admission and controller dispatch. */
export function toDistributedRecipeKey(selection: RallarBlackBoxDistributedRunRecipeSelection): string | undefined {
    return selection.recipeId?.trim() || selection.recipe?.recipeId?.trim() || selection.role?.trim() || undefined;
}

/** Role-selected recipes used by both admission and controller command construction. */
export function toDistributedAgentRecipeSelections(
    manifest: RallarBlackBoxDistributedRunManifest,
    assignments: readonly RallarBlackBoxDistributedRoleAssignment[],
    agentId: string
): readonly RallarBlackBoxDistributedRunRecipeSelection[] {
    const assigned = assignments.filter((assignment) => assignment.agentId === agentId);
    const roles = new Set(assigned.map((assignment) => assignment.role));
    const recipeIds = new Set(assigned.flatMap((assignment) => assignment.recipeIds));
    const selections = manifest.recipes.filter((selection) => {
        const key = toDistributedRecipeKey(selection);
        if (recipeIds.size > 0 && key && recipeIds.has(key)) {
            return true;
        }
        return selection.role ? roles.has(selection.role) : recipeIds.size === 0;
    });
    return selections.length > 0 ? selections : manifest.recipes.filter((selection) => !selection.role);
}

function resolveDistributedSelectedAgentIds(
    manifest: RallarBlackBoxDistributedRunManifest,
    targetableAgentIds: readonly string[]
): readonly string[] {
    const policy = manifest.targetPolicy;
    if (policy.mode === 'all-online-group-members') {
        return [...targetableAgentIds].sort((left, right) => left.localeCompare(right));
    }
    const candidates = policy.mode === 'selected-agents'
        ? policy.agentIds
        : [
            ...Object.values(policy.roles).flat(),
            ...manifest.roleAssignments.map((assignment) => assignment.agentId)
        ];
    return [...new Set(candidates)]
        .sort((left, right) => left.localeCompare(right));
}

function resolveDistributedRoleAssignments(
    manifest: RallarBlackBoxDistributedRunManifest,
    targetAgentIds: readonly string[]
): readonly RallarBlackBoxDistributedRoleAssignment[] {
    const selected = new Set(targetAgentIds);
    if (manifest.roleAssignments.length > 0) {
        return manifest.roleAssignments
            .filter((assignment) => selected.has(assignment.agentId))
            .map((assignment) => ({ ...assignment }));
    }

    const policy = manifest.targetPolicy;
    if (policy.mode === 'role-map' && Object.keys(policy.roles).length > 0) {
        return toResolvedRoleAssignments(policy.roles)
            .filter((assignment) => selected.has(assignment.agentId));
    }

    const rolePolicy = manifest.roleAssignmentPolicy;
    return rolePolicy === undefined
        ? []
        : toResolvedRoleAssignments(toRolesForPattern(rolePolicy.pattern, targetAgentIds));
}

function toResolvedRoleAssignments(
    roles: Readonly<Record<string, readonly string[]>>
): readonly RallarBlackBoxDistributedRoleAssignment[] {
    return Object.entries(roles)
        .flatMap(([role, agentIds]) => agentIds.map((agentId) => ({ role, agentId, recipeIds: [], variables: {} })));
}

function computeSortedCounts(values: readonly string[]): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const value of values) {
        counts[value] = (counts[value] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
    );
}

function toNonEmptyTexts(values: readonly (string | undefined)[]): readonly string[] {
    return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function isControlAgentIdentityInGroup(
    identity: RallarBlackBoxControlAgentIdentity,
    group: RallarBlackBoxDistributedGroupRef
): boolean {
    return identity.applicationId === group.applicationId &&
        identity.workspaceId === group.workspaceId &&
        identity.groupId === group.groupId;
}

function isControlAgentStale(input: ResolveDistributedTargetBlockerInput): boolean {
    const { agent } = input;
    const lastSeen = agent.lastHeartbeatAtEpochMs ?? agent.lastSeenAtEpochMs ?? agent.identity?.updatedAtEpochMs;
    return lastSeen !== undefined && input.nowEpochMs - lastSeen > input.staleAfterMs;
}
