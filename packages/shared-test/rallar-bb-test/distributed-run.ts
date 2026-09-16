import {
    collectDistributedAssertionFeatures,
    validateAgentAssertionCapability,
    type DistributedAssertionFeatures
} from './distributed/control-agent-capabilities.ts';
import {
    validateDistributedGroupAssertions,
    type RallarBlackBoxDistributedGroupAssertion
} from './distributed/group-assertions.ts';
import type {
    RallarBlackBoxTestAssertOperator,
    RallarBlackBoxTestCrdtTransport,
    RallarBlackBoxTestError,
    RallarBlackBoxTestMessagesCarrier,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord
} from './rallar-black-box-test-contracts.ts';

export {
    isDistributedRunTerminalState,
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_TERMINAL_STATES,
    rollupDistributedRunResult
} from './distributed/distributed-run-rollup.ts';
export type {
    RallarBlackBoxDistributedRunRollup,
    RallarBlackBoxDistributedRunRollupFailure,
    RallarBlackBoxDistributedRunRollupInput,
    RallarBlackBoxDistributedRunTerminalState
} from './distributed/distributed-run-rollup.ts';
export type {
    RallarBlackBoxDistributedGroupAssertion,
    RallarBlackBoxDistributedGroupAssertionResult,
    RallarBlackBoxGroupAssertionAggregate
} from './distributed/group-assertions.ts';

export const RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES = [
    'draft',
    'resolving-targets',
    'staging',
    'waiting-for-ack',
    'waiting-for-barrier',
    'ready',
    'running',
    'passed',
    'failed',
    'cancelled',
    'timed-out'
] as const;

export const RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES = [
    'all-online-group-members',
    'selected-agents',
    'role-map'
] as const;

export const RALLAR_BLACK_BOX_DISTRIBUTED_START_MODES = [
    'manual',
    'auto-after-ready',
    'scheduled'
] as const;

export const RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_PATTERNS = [
    'all-agents',
    'sender-receiver',
    'one-sender-many-receivers',
    'three-browser-matrix'
] as const;

export const RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_POLICY_MODES = [
    'ordered-targets'
] as const;

export const RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_ORDERINGS = [
    'agent-id'
] as const;

export type RallarBlackBoxDistributedRunState = typeof RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES[number];

export type RallarBlackBoxDistributedTargetPolicyMode = typeof RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES[number];

export type RallarBlackBoxDistributedStartMode = typeof RALLAR_BLACK_BOX_DISTRIBUTED_START_MODES[number];

export type RallarBlackBoxDistributedRolePattern = typeof RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_PATTERNS[number];

export type RallarBlackBoxDistributedRoleAssignmentPolicyMode =
    typeof RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_POLICY_MODES[number];

export type RallarBlackBoxDistributedRoleAssignmentOrdering =
    typeof RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_ORDERINGS[number];

/** A type alias rather than an interface: recipe commands carry the same value as a JSON roomRef record. */
export type RallarBlackBoxDistributedGroupRef = Readonly<{
    applicationId: string;
    workspaceId: string;
    groupId: string;
}>;

export interface RallarBlackBoxGeoLocation {
    readonly latitude: number;
    readonly longitude: number;
    /** Absent when the fleet configuration names no place for the coordinates. */
    readonly label?: string;
    readonly precision: 'exact' | 'approximate';
}

/** Identity facts an agent reports from its configuration; each is absent when that configuration omits it. */
export interface RallarBlackBoxControlAgentIdentity {
    /** Absent before the agent's Rallar configuration names a principal. */
    readonly principalId?: string;
    /** Absent before the agent's Rallar configuration names a client or principal. */
    readonly clientId?: string;
    /** Absent before the agent's Rallar configuration names a user or principal. */
    readonly username?: string;
    /** Absent before the agent's Rallar configuration names a session. */
    readonly sessionId?: string;
    /** Absent before the agent's Rallar configuration names a client instance or principal. */
    readonly clientInstanceId?: string;
    /** Absent when the agent's configuration names no application scope. */
    readonly applicationId?: string;
    /** Absent when the agent's configuration names no workspace scope. */
    readonly workspaceId?: string;
    /** Absent when the agent's configuration names no group or room. */
    readonly groupId?: string;
    /** Absent when the agent's configuration names no provider mode. */
    readonly providerMode?: string;
    /** Absent when the agent's browser configuration and user agent give no label. */
    readonly browserLabel?: string;
    /** Absent when an agent build predates session labels. */
    readonly sessionLabel?: string;
    /** Absent when the fleet configuration names no region. */
    readonly region?: string;
    /** Absent when the fleet configuration names no hosting provider. */
    readonly provider?: string;
    /** Absent when the fleet configuration names no datacenter. */
    readonly datacenter?: string;
    /** Absent when the fleet configuration names no host. */
    readonly hostId?: string;
    /** Absent when the fleet configuration names no agent pool. */
    readonly agentPoolId?: string;
    /** Absent when the fleet configuration names no deployment. */
    readonly deploymentId?: string;
    /** Absent when neither the fleet nor the browser configuration names the browser. */
    readonly browserName?: string;
    /** Absent when neither the fleet nor the browser configuration names the browser version. */
    readonly browserVersion?: string;
    /** Absent when neither the fleet nor the browser configuration names the operating system. */
    readonly os?: string;
    /** Absent when the fleet configuration lists no tags. */
    readonly tags?: readonly string[];
    /** Absent when the fleet configuration gives no valid coordinates. */
    readonly location?: RallarBlackBoxGeoLocation;
    /** Absent when an agent build predates capability advertisement or advertises an unreadable block. */
    readonly capabilities?: RallarBlackBoxControlAgentCapabilities;
    /** Absent when an agent build predates identity timestamps. */
    readonly updatedAtEpochMs?: number;
}

export interface RallarBlackBoxControlAgentCapabilities {
    readonly crdt: RallarBlackBoxControlAgentCrdtCapability;
    /** Absent when an agent build predates assertion capability advertisement. */
    readonly assertions?: RallarBlackBoxControlAgentAssertionsCapability;
    readonly messaging: RallarBlackBoxControlAgentMessagingCapability;
}

export interface RallarBlackBoxControlAgentMessagingCapability {
    readonly supported: boolean;
    readonly carriers: readonly RallarBlackBoxTestMessagesCarrier[];
    readonly faults: boolean;
    readonly storageCounters: boolean;
    readonly reload: boolean;
}

export interface RallarBlackBoxControlAgentAssertionsCapability {
    readonly absence: boolean;
    readonly untilLoop: boolean;
    readonly operators: readonly RallarBlackBoxTestAssertOperator[];
}

export interface RallarBlackBoxControlAgentCrdtCapability {
    readonly supported: boolean;
    readonly transports: readonly RallarBlackBoxTestCrdtTransport[];
    /** Absent when the agent's configuration names no provider mode. */
    readonly runtimeSurface?: string;
    readonly apiBaseUrlConfigured: boolean;
}

export interface RallarBlackBoxGroupMemberCandidate {
    readonly principalId: string;
    /** Absent when the group member listing names no username. */
    readonly username?: string;
    /** Empty when the member may match an agent in any session. */
    readonly sessionIds: readonly string[];
}

export interface RallarBlackBoxControlAgentCandidate {
    readonly agentId: string;
    readonly connected: boolean;
    /** Absent before the control server has seen any traffic from the agent. */
    readonly lastSeenAtEpochMs?: number;
    /** Absent before the agent sends its first heartbeat. */
    readonly lastHeartbeatAtEpochMs?: number;
    /** Absent before the agent reports identity metadata. */
    readonly identity?: RallarBlackBoxControlAgentIdentity;
}

export type RallarBlackBoxGroupControlAgentMatchStatus = RallarBlackBoxGroupControlAgentMatch['status'];

export type RallarBlackBoxGroupControlAgentMatch =
    | RallarBlackBoxMatchedGroupControlAgent
    | RallarBlackBoxUntargetableGroupMember
    | RallarBlackBoxUnmatchedControlAgent;

export interface RallarBlackBoxMatchedGroupControlAgent {
    readonly status: 'matched';
    readonly targetable: true;
    readonly reason: string;
    readonly member: RallarBlackBoxGroupMemberCandidate;
    readonly agent: RallarBlackBoxControlAgentCandidate;
    readonly candidateAgents: readonly RallarBlackBoxControlAgentCandidate[];
}

export interface RallarBlackBoxUntargetableGroupMember {
    readonly status: 'unmatched-group-member' | 'offline-agent' | 'stale-agent' | 'duplicate-session';
    readonly targetable: false;
    readonly reason: string;
    readonly member: RallarBlackBoxGroupMemberCandidate;
    readonly candidateAgents: readonly RallarBlackBoxControlAgentCandidate[];
}

export interface RallarBlackBoxUnmatchedControlAgent {
    readonly status: 'agent-without-group-member' | 'agent-without-identity';
    readonly targetable: false;
    readonly reason: string;
    readonly agent: RallarBlackBoxControlAgentCandidate;
    readonly candidateAgents: readonly RallarBlackBoxControlAgentCandidate[];
}

export interface RallarBlackBoxGroupControlAgentMatchResult {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly matches: readonly RallarBlackBoxGroupControlAgentMatch[];
    readonly targetableAgentIds: readonly string[];
    readonly summary: RallarBlackBoxGroupControlAgentMatchSummary;
}

export interface RallarBlackBoxGroupControlAgentMatchSummary {
    readonly members: number;
    readonly agents: number;
    readonly matched: number;
    readonly targetable: number;
    readonly unmatchedMembers: number;
    readonly offlineAgents: number;
    readonly staleAgents: number;
    readonly duplicateSessions: number;
    readonly agentsWithoutMembers: number;
    readonly agentsWithoutIdentity: number;
}

/** Author-supplied variables and metadata: JSON objects the manifest carries as recorded. */
export type RallarBlackBoxDistributedRunVariables = RallarBlackBoxTestRecord;

export interface RallarBlackBoxDistributedRunRecipeSelection {
    readonly recipeId: string;
    /** Absent when the selection references a catalog recipe the agent loads by recipeId. */
    readonly recipe?: RallarBlackBoxTestRecipe;
    /** Absent when the recipe runs on every targeted agent regardless of role. */
    readonly role?: string;
    /** Absent when the selection names no catalog profile. */
    readonly profile?: string;
    readonly variables: RallarBlackBoxDistributedRunVariables;
    readonly secretRefs: readonly string[];
    readonly required: boolean;
}

export interface RallarBlackBoxDistributedRoleAssignment {
    readonly role: string;
    readonly agentId: string;
    /** Empty when the agent runs every recipe selection for its role. */
    readonly recipeIds: readonly string[];
    readonly required: boolean;
    readonly variables: RallarBlackBoxDistributedRunVariables;
}

/** A role an agent holds after target resolution; authored assignments pass through with their recipe scope. */
export interface RallarBlackBoxDistributedResolvedRoleAssignment {
    readonly role: string;
    readonly agentId: string;
    readonly required: boolean;
    /** Absent when the role came from targetPolicy.roles or a role pattern instead of an authored assignment. */
    readonly recipeIds?: readonly string[];
    /** Absent when the role came from targetPolicy.roles or a role pattern instead of an authored assignment. */
    readonly variables?: RallarBlackBoxDistributedRunVariables;
}

export interface RallarBlackBoxDistributedRoleAssignmentPolicy {
    readonly mode: RallarBlackBoxDistributedRoleAssignmentPolicyMode;
    readonly pattern: RallarBlackBoxDistributedRolePattern;
    readonly orderBy: RallarBlackBoxDistributedRoleAssignmentOrdering;
}

export type RallarBlackBoxDistributedTargetPolicy =
    | RallarBlackBoxDistributedAllOnlineTargetPolicy
    | RallarBlackBoxDistributedSelectedAgentsTargetPolicy
    | RallarBlackBoxDistributedRoleMapTargetPolicy;

interface RallarBlackBoxDistributedTargetPolicyFields {
    /** Absent when staging accepts however many agents the policy resolves. */
    readonly expectedParticipantCount?: number;
    readonly includeOfflineExpectedAgents: boolean;
}

export interface RallarBlackBoxDistributedAllOnlineTargetPolicy extends RallarBlackBoxDistributedTargetPolicyFields {
    readonly mode: 'all-online-group-members';
}

export interface RallarBlackBoxDistributedSelectedAgentsTargetPolicy
    extends RallarBlackBoxDistributedTargetPolicyFields {
    readonly mode: 'selected-agents';
    readonly agentIds: readonly string[];
}

export interface RallarBlackBoxDistributedRoleMapTargetPolicy extends RallarBlackBoxDistributedTargetPolicyFields {
    readonly mode: 'role-map';
    readonly roles: Readonly<Record<string, readonly string[]>>;
}

export interface RallarBlackBoxDistributedArtifactPolicy {
    readonly retainArtifacts: boolean;
    readonly includeEventJsonl: boolean;
    readonly includeResultJsonl: boolean;
    readonly includeFailureBundle: boolean;
    readonly includeDistributedMetadata: boolean;
    /** Absent when the author requests no retention period. */
    readonly retentionDays?: number;
}

export type RallarBlackBoxDistributedBarrierPolicy =
    | RallarBlackBoxDistributedDisabledBarrierPolicy
    | RallarBlackBoxDistributedEnabledBarrierPolicy;

export interface RallarBlackBoxDistributedDisabledBarrierPolicy {
    readonly enabled: false;
}

export interface RallarBlackBoxDistributedEnabledBarrierPolicy {
    readonly enabled: true;
    readonly timeoutMs: number;
}

export type RallarBlackBoxDistributedRunManifest =
    | RallarBlackBoxDistributedUnscheduledRunManifest
    | RallarBlackBoxDistributedScheduledRunManifest;

export interface RallarBlackBoxDistributedRunManifestFields {
    readonly schemaVersion: 1;
    readonly distributedRunId: string;
    readonly controlRunId: string;
    /** Absent when the author gives the run no display name. */
    readonly displayName?: string;
    /** Absent when the author gives the run no description. */
    readonly description?: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly recipes: readonly RallarBlackBoxDistributedRunRecipeSelection[];
    readonly targetPolicy: RallarBlackBoxDistributedTargetPolicy;
    readonly variables: RallarBlackBoxDistributedRunVariables;
    readonly secretRefs: readonly string[];
    readonly roleAssignments: readonly RallarBlackBoxDistributedRoleAssignment[];
    /** Absent when roles come from targetPolicy.roles or roleAssignments instead of a pattern. */
    readonly roleAssignmentPolicy?: RallarBlackBoxDistributedRoleAssignmentPolicy;
    readonly ackTimeoutMs: number;
    readonly barrier: RallarBlackBoxDistributedBarrierPolicy;
    readonly artifactPolicy: RallarBlackBoxDistributedArtifactPolicy;
    readonly groupAssertions: readonly RallarBlackBoxDistributedGroupAssertion[];
    readonly metadata: RallarBlackBoxDistributedRunVariables;
}

export interface RallarBlackBoxDistributedUnscheduledRunManifest extends RallarBlackBoxDistributedRunManifestFields {
    readonly startMode: 'manual' | 'auto-after-ready';
}

export interface RallarBlackBoxDistributedScheduledRunManifest extends RallarBlackBoxDistributedRunManifestFields {
    readonly startMode: 'scheduled';
    readonly startDeadlineEpochMs: number;
}

export type RallarBlackBoxDistributedTargetBlockerStatus = RallarBlackBoxDistributedTargetBlocker['status'];

export type RallarBlackBoxDistributedTargetBlocker =
    | RallarBlackBoxDistributedIdentifiedTargetBlocker
    | RallarBlackBoxDistributedUnidentifiedTargetBlocker;

export interface RallarBlackBoxDistributedIdentifiedTargetBlocker {
    readonly agentId: string;
    readonly status: 'offline-agent' | 'stale-agent' | 'different-group' | 'missing-assertion-capability';
    readonly reason: string;
    readonly identity: RallarBlackBoxControlAgentIdentity;
}

export interface RallarBlackBoxDistributedUnidentifiedTargetBlocker {
    readonly agentId: string;
    readonly status: 'agent-without-identity';
    readonly reason: string;
}

export interface RallarBlackBoxDistributedTargetResolution {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly resolvedAtEpochMs: number;
    readonly staleAfterMs: number;
    readonly targetPolicyMode: RallarBlackBoxDistributedTargetPolicyMode;
    readonly targetAgentIds: readonly string[];
    readonly roleAssignments: readonly RallarBlackBoxDistributedResolvedRoleAssignment[];
    readonly blockers: readonly RallarBlackBoxDistributedTargetBlocker[];
    readonly summary: RallarBlackBoxDistributedTargetResolutionSummary;
}

export interface RallarBlackBoxDistributedTargetResolutionSummary {
    readonly agents: number;
    readonly targetable: number;
    readonly selected: number;
    /** Absent when the target policy expects no participant count. */
    readonly expectedParticipantCount?: number;
    readonly missingExpectedParticipants: number;
    readonly staleAgents: number;
    readonly offlineAgents: number;
    readonly wrongGroupAgents: number;
    /** Absent from explicit target resolutions, which do not gate agents on assertion capabilities. */
    readonly assertionCapabilityBlockedAgents?: number;
    readonly agentsWithoutIdentity: number;
    readonly roleCounts: Readonly<Record<string, number>>;
    readonly regions: Readonly<Record<string, number>>;
    readonly providers: Readonly<Record<string, number>>;
}

export type RallarBlackBoxDistributedRunItemState =
    | 'pending'
    | 'targeted'
    | 'acknowledged'
    | 'ready'
    | 'running'
    | 'passed'
    | 'failed'
    | 'cancelled'
    | 'timed-out'
    | 'disconnected'
    | 'skipped';

export interface RallarBlackBoxDistributedParticipantResult {
    readonly agentId: string;
    /** Absent when the agent has not reported a client identity. */
    readonly clientId?: string;
    /** Absent when the agent has not reported a session identity. */
    readonly sessionId?: string;
    /** Absent when the participant result was assembled outside control-server evaluation. */
    readonly roles?: readonly string[];
    /** Absent when the participant is required, the rollup's reading of an unmarked participant. */
    readonly required?: boolean;
    readonly state: RallarBlackBoxDistributedRunItemState;
    /** Absent while the participant's readiness or outcome is undecided. */
    readonly ok?: boolean;
    /** Absent until every stage (and barrier) command for the agent has a result. */
    readonly acknowledgedAtEpochMs?: number;
    /** Absent until the agent's start results record a start time. */
    readonly startedAtEpochMs?: number;
    /** Absent until the agent's start results record an end time. */
    readonly endedAtEpochMs?: number;
    /** Absent unless the participant failed, timed out or disconnected. */
    readonly error?: RallarBlackBoxTestError;
}

export interface RallarBlackBoxDistributedRecipeResult {
    readonly recipeKey: string;
    /** Absent when the start command link names no recipe. */
    readonly recipeId?: string;
    /** Absent when the result was assembled outside control-server evaluation. */
    readonly agentId?: string;
    /** Absent when the start command link names no role. */
    readonly role?: string;
    /** Absent when the recipe is required, the rollup's reading of an unmarked recipe. */
    readonly required?: boolean;
    readonly state: RallarBlackBoxDistributedRunItemState;
    /** Absent until the recipe's start command has a result. */
    readonly ok?: boolean;
    /** Absent until the recipe's start command has a result. */
    readonly commandResultCount?: number;
    /** Absent until the recipe's start command has a result. */
    readonly failureCount?: number;
    /** Absent until the recipe result records a start time. */
    readonly startedAtEpochMs?: number;
    /** Absent until the recipe result records an end time. */
    readonly endedAtEpochMs?: number;
    /** Absent unless the recipe's start command failed. */
    readonly error?: RallarBlackBoxTestError;
}

export interface RallarBlackBoxDistributedRunValidationIssue {
    readonly path: string;
    readonly message: string;
}

/** Cross-field rules a schema-valid manifest must also satisfy; empty when it does. */
export function validateDistributedRunManifestContract(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    return [
        ...validateManifestIdentity(manifest),
        ...validateTargetPolicy(manifest),
        ...validateRoleAssignmentPolicy(manifest),
        ...validateStart(manifest),
        ...validateTimeouts(manifest),
        ...validateDistributedGroupAssertions(manifest)
    ];
}

export interface ResolveGroupMemberControlAgentMatchesInput {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly members: readonly RallarBlackBoxGroupMemberCandidate[];
    readonly agents: readonly RallarBlackBoxControlAgentCandidate[];
    readonly nowEpochMs: number;
    readonly staleAfterMs: number;
}

export function resolveGroupMemberControlAgentMatches(
    input: ResolveGroupMemberControlAgentMatchesInput
): RallarBlackBoxGroupControlAgentMatchResult {
    const consumedAgentIds = new Set<string>();
    const matches: RallarBlackBoxGroupControlAgentMatch[] = [];

    for (const member of input.members) {
        const candidates = input.agents.filter((agent) => agentMatchesMemberInGroup(agent, member, input.group));
        const activeCandidates = candidates.filter((agent) =>
            agent.connected && !agentIsStale(agent, input.nowEpochMs, input.staleAfterMs)
        );

        if (activeCandidates.length === 1) {
            const agent = activeCandidates[0];
            consumedAgentIds.add(agent.agentId);
            matches.push({
                status: 'matched',
                targetable: true,
                reason: 'Group member has one connected control agent with matching identity.',
                member,
                agent,
                candidateAgents: candidates
            });
            continue;
        }

        if (activeCandidates.length > 1) {
            activeCandidates.forEach((agent) => consumedAgentIds.add(agent.agentId));
            matches.push({
                status: 'duplicate-session',
                targetable: false,
                reason: 'Group member matches multiple connected control agents; select a target explicitly.',
                member,
                candidateAgents: candidates
            });
            continue;
        }

        if (candidates.some((agent) => agent.connected && agentIsStale(agent, input.nowEpochMs, input.staleAfterMs))) {
            candidates.forEach((agent) => consumedAgentIds.add(agent.agentId));
            matches.push({
                status: 'stale-agent',
                targetable: false,
                reason: 'Matching control agent is connected but stale.',
                member,
                candidateAgents: candidates
            });
            continue;
        }

        if (candidates.some((agent) => !agent.connected)) {
            candidates.forEach((agent) => consumedAgentIds.add(agent.agentId));
            matches.push({
                status: 'offline-agent',
                targetable: false,
                reason: 'Matching control agent is offline.',
                member,
                candidateAgents: candidates
            });
            continue;
        }

        matches.push({
            status: 'unmatched-group-member',
            targetable: false,
            reason: 'No connected control agent identity matches this group member.',
            member,
            candidateAgents: []
        });
    }

    for (const agent of input.agents) {
        if (consumedAgentIds.has(agent.agentId)) {
            continue;
        }

        if (
            !agent.identity ||
            !cleanString(agent.identity.principalId ?? agent.identity.clientId ?? agent.identity.username)
        ) {
            matches.push({
                status: 'agent-without-identity',
                targetable: false,
                reason: 'Control agent has not reported Rallar identity metadata.',
                agent,
                candidateAgents: [agent]
            });
            continue;
        }

        if (identityMatchesGroup(agent.identity, input.group)) {
            matches.push({
                status: 'agent-without-group-member',
                targetable: false,
                reason: 'Control agent reports this group but no matching group member was observed.',
                agent,
                candidateAgents: [agent]
            });
        }
    }

    const targetableAgentIds = matches
        .filter((match) => match.status === 'matched')
        .map((match) => match.agent.agentId);
    const count = (status: RallarBlackBoxGroupControlAgentMatchStatus) =>
        matches.filter((match) => match.status === status).length;

    return {
        group: input.group,
        matches,
        targetableAgentIds,
        summary: {
            members: input.members.length,
            agents: input.agents.length,
            matched: count('matched'),
            targetable: targetableAgentIds.length,
            unmatchedMembers: count('unmatched-group-member'),
            offlineAgents: count('offline-agent'),
            staleAgents: count('stale-agent'),
            duplicateSessions: count('duplicate-session'),
            agentsWithoutMembers: count('agent-without-group-member'),
            agentsWithoutIdentity: count('agent-without-identity')
        }
    };
}

export function resolveDistributedTargetAgentIds(
    input: Readonly<{
        matchResult: RallarBlackBoxGroupControlAgentMatchResult;
        targetPolicy: RallarBlackBoxDistributedTargetPolicy;
    }>
): readonly string[] {
    const targetable = new Set(input.matchResult.targetableAgentIds);
    const unique = (values: readonly string[]) => [...new Set(values)].filter((value) => targetable.has(value));

    switch (input.targetPolicy.mode) {
        case 'all-online-group-members':
            return input.matchResult.targetableAgentIds;
        case 'selected-agents':
            return unique(input.targetPolicy.agentIds);
        case 'role-map':
            return unique(Object.values(input.targetPolicy.roles).flat());
    }
}

export interface ResolveDistributedRunTargetsInput {
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly agents: readonly RallarBlackBoxControlAgentCandidate[];
    readonly nowEpochMs: number;
    readonly staleAfterMs: number;
}

export function resolveDistributedRunTargets(
    input: ResolveDistributedRunTargetsInput
): RallarBlackBoxDistributedTargetResolution {
    const { nowEpochMs, staleAfterMs } = input;
    const blockers: RallarBlackBoxDistributedTargetBlocker[] = [];
    const targetableAgentIds: string[] = [];
    const targetableById = new Set<string>();
    const assertionFeatures = collectDistributedAssertionFeatures(
        input.manifest.recipes
            .map((selection) => selection.recipe)
            .filter((recipe): recipe is RallarBlackBoxTestRecipe => recipe !== undefined)
    );

    for (const agent of input.agents) {
        const blocker = distributedTargetBlocker({
            agent,
            group: input.manifest.group,
            nowEpochMs,
            staleAfterMs,
            assertionFeatures
        });
        if (blocker) {
            blockers.push(blocker);
            continue;
        }
        targetableAgentIds.push(agent.agentId);
        targetableById.add(agent.agentId);
    }

    const selected = distributedSelectedAgentIds({
        policy: input.manifest.targetPolicy,
        targetableAgentIds,
        targetableById,
        roleAssignments: input.manifest.roleAssignments
    });
    const roleAssignments = distributedRoleAssignments({
        manifest: input.manifest,
        targetAgentIds: selected
    });
    const roleCounts = countBy(roleAssignments.map((assignment) => assignment.role));
    const selectedAgentSet = new Set(selected);
    const selectedAgents = input.agents.filter((agent) => selectedAgentSet.has(agent.agentId));
    const expected = input.manifest.targetPolicy.expectedParticipantCount;

    return {
        group: input.manifest.group,
        resolvedAtEpochMs: nowEpochMs,
        staleAfterMs,
        targetPolicyMode: input.manifest.targetPolicy.mode,
        targetAgentIds: selected,
        roleAssignments,
        blockers,
        summary: {
            agents: input.agents.length,
            targetable: targetableAgentIds.length,
            selected: selected.length,
            expectedParticipantCount: expected,
            missingExpectedParticipants: expected === undefined
                ? 0
                : Math.max(0, expected - selected.length),
            staleAgents: blockers.filter((blocker) => blocker.status === 'stale-agent').length,
            offlineAgents: blockers.filter((blocker) => blocker.status === 'offline-agent').length,
            wrongGroupAgents: blockers.filter((blocker) => blocker.status === 'different-group').length,
            assertionCapabilityBlockedAgents: blockers
                .filter((blocker) => blocker.status === 'missing-assertion-capability').length,
            agentsWithoutIdentity: blockers.filter((blocker) => blocker.status === 'agent-without-identity').length,
            roleCounts,
            regions: countBy(selectedAgents.map((agent) => agent.identity?.region).filter(isString)),
            providers: countBy(selectedAgents.map((agent) => agent.identity?.provider).filter(isString))
        }
    };
}

function validateManifestIdentity(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    return [
        ...requireNonEmptyString(manifest.distributedRunId, '$.distributedRunId'),
        ...requireNonEmptyString(manifest.controlRunId, '$.controlRunId'),
        ...requireNonEmptyString(manifest.group.applicationId, '$.group.applicationId'),
        ...requireNonEmptyString(manifest.group.workspaceId, '$.group.workspaceId'),
        ...requireNonEmptyString(manifest.group.groupId, '$.group.groupId'),
        ...(manifest.recipes.length === 0
            ? [{ path: '$.recipes', message: 'At least one recipe selection is required.' }]
            : []),
        ...manifest.recipes.flatMap((recipe, index) =>
            requireNonEmptyString(recipe.recipeId, `$.recipes[${index}].recipeId`)
        )
    ];
}

function validateTargetPolicy(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const policy = manifest.targetPolicy;
    const errors: RallarBlackBoxDistributedRunValidationIssue[] = [];
    const expectedParticipantCount = policy.expectedParticipantCount;
    if (
        expectedParticipantCount !== undefined &&
        (!Number.isInteger(expectedParticipantCount) || expectedParticipantCount < 1)
    ) {
        errors.push({
            path: '$.targetPolicy.expectedParticipantCount',
            message: 'Expected participant count must be an integer >= 1.'
        });
    }
    if (policy.mode !== 'selected-agents' && 'agentIds' in policy) {
        errors.push({
            path: '$.targetPolicy.agentIds',
            message: 'Only selected-agents target policies accept agentIds.'
        });
    }
    if (policy.mode !== 'role-map' && 'roles' in policy) {
        errors.push({ path: '$.targetPolicy.roles', message: 'Only role-map target policies accept roles.' });
    }
    if (policy.mode === 'selected-agents' && (!('agentIds' in policy) || policy.agentIds.length === 0)) {
        errors.push({
            path: '$.targetPolicy.agentIds',
            message: 'selected-agents target policy requires at least one agent ID.'
        });
    }
    if (policy.mode === 'role-map') {
        errors.push(...validateRoleMap(policy, manifest.roleAssignments));
    }
    return errors;
}

function validateRoleMap(
    policy: RallarBlackBoxDistributedRoleMapTargetPolicy,
    roleAssignments: readonly RallarBlackBoxDistributedRoleAssignment[]
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    if (!('roles' in policy)) {
        return [{ path: '$.targetPolicy.roles', message: 'A role-map target policy requires roles.' }];
    }
    const roleMapCount = Object.values(policy.roles).reduce((count, agentIds) => count + agentIds.length, 0);
    return roleMapCount === 0 && roleAssignments.length === 0
        ? [{ path: '$.targetPolicy.roles', message: 'role-map target policy requires roles or roleAssignments.' }]
        : [];
}

function validateRoleAssignmentPolicy(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const policy = manifest.roleAssignmentPolicy;
    if (policy === undefined) {
        return [];
    }
    return [
        ...(policy.mode === 'ordered-targets'
            ? []
            : [{
                path: '$.roleAssignmentPolicy.mode',
                message: 'Role assignment policy mode must be ordered-targets.'
            }]),
        ...(RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_PATTERNS.includes(policy.pattern)
            ? []
            : [{
                path: '$.roleAssignmentPolicy.pattern',
                message: 'Role assignment policy pattern is not supported.'
            }]),
        ...(RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_ORDERINGS.includes(policy.orderBy)
            ? []
            : [{
                path: '$.roleAssignmentPolicy.orderBy',
                message: 'Role assignment policy ordering is not supported.'
            }])
    ];
}

function validateStart(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    if (manifest.startMode === 'scheduled') {
        return 'startDeadlineEpochMs' in manifest
            ? []
            : [{ path: '$.startDeadlineEpochMs', message: 'Scheduled distributed runs require startDeadlineEpochMs.' }];
    }
    return 'startDeadlineEpochMs' in manifest
        ? [{
            path: '$.startDeadlineEpochMs',
            message: 'Only scheduled distributed runs accept startDeadlineEpochMs.'
        }]
        : [];
}

function validateTimeouts(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    const errors: RallarBlackBoxDistributedRunValidationIssue[] = [];
    if (!Number.isInteger(manifest.ackTimeoutMs) || manifest.ackTimeoutMs < 1) {
        errors.push({ path: '$.ackTimeoutMs', message: 'ACK timeout must be an integer >= 1.' });
    }
    const barrier = manifest.barrier;
    if (barrier.enabled && !('timeoutMs' in barrier)) {
        errors.push({ path: '$.barrier.timeoutMs', message: 'An enabled barrier requires timeoutMs.' });
    }
    else if (barrier.enabled && (!Number.isInteger(barrier.timeoutMs) || barrier.timeoutMs < 1)) {
        errors.push({ path: '$.barrier.timeoutMs', message: 'Barrier timeout must be an integer >= 1.' });
    }
    else if (!barrier.enabled && 'timeoutMs' in barrier) {
        errors.push({ path: '$.barrier.timeoutMs', message: 'A disabled barrier accepts no timeoutMs.' });
    }
    return errors;
}

interface DistributedTargetBlockerInput {
    readonly agent: RallarBlackBoxControlAgentCandidate;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly nowEpochMs: number;
    readonly staleAfterMs: number;
    readonly assertionFeatures: DistributedAssertionFeatures;
}

function distributedTargetBlocker(
    input: DistributedTargetBlockerInput
): RallarBlackBoxDistributedTargetBlocker | undefined {
    const agent = input.agent;
    if (!agent.identity) {
        return {
            agentId: agent.agentId,
            status: 'agent-without-identity',
            reason: 'Control agent has not reported Rallar identity metadata.'
        };
    }
    if (!identityMatchesGroup(agent.identity, input.group)) {
        return {
            agentId: agent.agentId,
            status: 'different-group',
            reason: 'Control agent reports a different application, workspace, or group.',
            identity: agent.identity
        };
    }
    if (!agent.connected) {
        return {
            agentId: agent.agentId,
            status: 'offline-agent',
            reason: 'Control agent is offline.',
            identity: agent.identity
        };
    }
    if (agentIsStale(agent, input.nowEpochMs, input.staleAfterMs)) {
        return {
            agentId: agent.agentId,
            status: 'stale-agent',
            reason: 'Control agent heartbeat is stale.',
            identity: agent.identity
        };
    }
    const unmetAssertionReason = validateAgentAssertionCapability(
        input.assertionFeatures,
        agent.identity.capabilities
    );
    if (unmetAssertionReason) {
        return {
            agentId: agent.agentId,
            status: 'missing-assertion-capability',
            reason: unmetAssertionReason,
            identity: agent.identity
        };
    }
    return undefined;
}

function distributedSelectedAgentIds(
    input: Readonly<{
        policy: RallarBlackBoxDistributedTargetPolicy;
        targetableAgentIds: readonly string[];
        targetableById: ReadonlySet<string>;
        roleAssignments: readonly RallarBlackBoxDistributedRoleAssignment[];
    }>
): readonly string[] {
    const uniqueTargetable = (values: readonly string[]) =>
        [...new Set(values)]
            .filter((value) => input.targetableById.has(value))
            .sort((left, right) => left.localeCompare(right));

    if (input.policy.mode === 'all-online-group-members') {
        return [...input.targetableAgentIds].sort((left, right) => left.localeCompare(right));
    }
    if (input.policy.mode === 'selected-agents') {
        return uniqueTargetable(input.policy.agentIds);
    }
    return uniqueTargetable([
        ...Object.values(input.policy.roles).flat(),
        ...input.roleAssignments.map((assignment) => assignment.agentId)
    ]);
}

function distributedRoleAssignments(
    input: Readonly<{
        manifest: RallarBlackBoxDistributedRunManifest;
        targetAgentIds: readonly string[];
    }>
): readonly RallarBlackBoxDistributedResolvedRoleAssignment[] {
    if (input.manifest.roleAssignments.length > 0) {
        const selected = new Set(input.targetAgentIds);
        return input.manifest.roleAssignments
            .filter((assignment) => selected.has(assignment.agentId))
            .map((assignment) => ({ ...assignment }));
    }

    const policy = input.manifest.targetPolicy;
    if (policy.mode === 'role-map' && Object.keys(policy.roles).length > 0) {
        const selected = new Set(input.targetAgentIds);
        return Object.entries(policy.roles)
            .flatMap(([role, agentIds]) =>
                agentIds
                    .filter((agentId) => selected.has(agentId))
                    .map((agentId) => ({
                        role,
                        agentId,
                        required: true
                    }))
            );
    }

    const rolePolicy = input.manifest.roleAssignmentPolicy;
    if (!rolePolicy || rolePolicy.mode !== 'ordered-targets') {
        return [];
    }

    return roleAssignmentsForPattern(rolePolicy.pattern, input.targetAgentIds);
}

function roleAssignmentsForPattern(
    pattern: RallarBlackBoxDistributedRolePattern,
    agentIds: readonly string[]
): readonly RallarBlackBoxDistributedResolvedRoleAssignment[] {
    if (pattern === 'all-agents') {
        return [];
    }
    if (pattern === 'sender-receiver') {
        return [
            ...agentIds.slice(0, 1).map((agentId) => ({ role: 'sender', agentId, required: true })),
            ...agentIds.slice(1, 2).map((agentId) => ({ role: 'receiver', agentId, required: true }))
        ];
    }
    if (pattern === 'one-sender-many-receivers') {
        return [
            ...agentIds.slice(0, 1).map((agentId) => ({ role: 'sender', agentId, required: true })),
            ...agentIds.slice(1).map((agentId) => ({ role: 'receiver', agentId, required: true }))
        ];
    }
    return [
        ...agentIds.slice(0, 1).map((agentId) => ({ role: 'publisher', agentId, required: true })),
        ...agentIds.slice(1, 2).map((agentId) => ({ role: 'relay', agentId, required: true })),
        ...agentIds.slice(2).map((agentId) => ({ role: 'observer', agentId, required: true }))
    ];
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const value of values) {
        counts[value] = (counts[value] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
    );
}

function isString(value: string | undefined): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function agentMatchesMemberInGroup(
    agent: RallarBlackBoxControlAgentCandidate,
    member: RallarBlackBoxGroupMemberCandidate,
    group: RallarBlackBoxDistributedGroupRef
): boolean {
    const identity = agent.identity;
    if (!identityMatchesGroup(identity, group)) {
        return false;
    }

    const memberIds = new Set(
        [
            member.principalId,
            member.username
        ].map(cleanString).filter((value): value is string => Boolean(value))
    );
    const identityIds = [
        identity.principalId,
        identity.clientId,
        identity.username
    ].map(cleanString).filter((value): value is string => Boolean(value));

    if (!identityIds.some((id) => memberIds.has(id))) {
        return false;
    }

    const memberSessionIds = new Set(
        member.sessionIds.map(cleanString).filter((value): value is string => Boolean(value))
    );
    if (memberSessionIds.size === 0) {
        return true;
    }

    return Boolean(identity.sessionId && memberSessionIds.has(identity.sessionId));
}

function identityMatchesGroup(
    identity: RallarBlackBoxControlAgentIdentity | undefined,
    group: RallarBlackBoxDistributedGroupRef
): identity is RallarBlackBoxControlAgentIdentity {
    if (!identity) {
        return false;
    }

    return identity.applicationId === group.applicationId &&
        identity.workspaceId === group.workspaceId &&
        identity.groupId === group.groupId;
}

function agentIsStale(
    agent: RallarBlackBoxControlAgentCandidate,
    nowEpochMs: number,
    staleAfterMs: number
): boolean {
    const lastSeen = agent.lastHeartbeatAtEpochMs ?? agent.lastSeenAtEpochMs ?? agent.identity?.updatedAtEpochMs;
    return typeof lastSeen === 'number' && nowEpochMs - lastSeen > staleAfterMs;
}

function requireNonEmptyString(
    value: string,
    path: string
): readonly RallarBlackBoxDistributedRunValidationIssue[] {
    return cleanString(value) ? [] : [{ path, message: 'A non-empty string is required.' }];
}

function cleanString(value: string | undefined): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined;
}
