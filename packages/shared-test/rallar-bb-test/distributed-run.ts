import type {
    RallarBlackBoxTestAssertOperator,
    RallarBlackBoxTestCrdtTransport,
    RallarBlackBoxTestRecipe,
} from './types.ts';
import {
    collectDistributedAssertionFeatures,
    validateAgentAssertionCapability,
    type DistributedAssertionFeatures,
} from './distributed/control-agent-capabilities.ts';

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
    'timed-out',
] as const;

export const RALLAR_BLACK_BOX_DISTRIBUTED_RUN_TERMINAL_STATES = [
    'passed',
    'failed',
    'cancelled',
    'timed-out',
] as const;

export const RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES = [
    'all-online-group-members',
    'selected-agents',
    'role-map',
] as const;

export const RALLAR_BLACK_BOX_DISTRIBUTED_START_MODES = [
    'manual',
    'auto-after-ready',
    'scheduled',
] as const;

export const RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_PATTERNS = [
    'all-agents',
    'sender-receiver',
    'one-sender-many-receivers',
    'three-browser-matrix',
] as const;

export const RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_POLICY_MODES = [
    'ordered-targets',
] as const;

export const RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_ORDERINGS = [
    'agent-id',
] as const;

export type RallarBlackBoxDistributedRunState =
    typeof RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES[number];

export type RallarBlackBoxDistributedRunTerminalState =
    typeof RALLAR_BLACK_BOX_DISTRIBUTED_RUN_TERMINAL_STATES[number];

export type RallarBlackBoxDistributedTargetPolicyMode =
    typeof RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES[number];

export type RallarBlackBoxDistributedStartMode =
    typeof RALLAR_BLACK_BOX_DISTRIBUTED_START_MODES[number];

export type RallarBlackBoxDistributedRolePattern =
    typeof RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_PATTERNS[number];

export type RallarBlackBoxDistributedRoleAssignmentPolicyMode =
    typeof RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_POLICY_MODES[number];

export type RallarBlackBoxDistributedRoleAssignmentOrdering =
    typeof RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_ORDERINGS[number];

export type RallarBlackBoxDistributedGroupRef = Readonly<{
    applicationId: string;
    workspaceId: string;
    groupId: string;
}>;

export type RallarBlackBoxGeoLocation = Readonly<{
    latitude: number;
    longitude: number;
    label?: string;
    precision?: 'exact' | 'approximate';
}>;

export type RallarBlackBoxControlAgentIdentity = Readonly<{
    principalId?: string;
    clientId?: string;
    username?: string;
    sessionId?: string;
    clientInstanceId?: string;
    applicationId?: string;
    workspaceId?: string;
    groupId?: string;
    providerMode?: string;
    browserLabel?: string;
    sessionLabel?: string;
    region?: string;
    provider?: string;
    datacenter?: string;
    hostId?: string;
    agentPoolId?: string;
    deploymentId?: string;
    browserName?: string;
    browserVersion?: string;
    os?: string;
    tags?: readonly string[];
    location?: RallarBlackBoxGeoLocation;
    capabilities?: RallarBlackBoxControlAgentCapabilities;
    updatedAtEpochMs?: number;
}>;

export type RallarBlackBoxControlAgentCapabilities = Readonly<{
    crdt?: RallarBlackBoxControlAgentCrdtCapability;
    assertions?: RallarBlackBoxControlAgentAssertionsCapability;
}>;

export type RallarBlackBoxControlAgentAssertionsCapability = Readonly<{
    absence: boolean;
    untilLoop: boolean;
    operators: readonly RallarBlackBoxTestAssertOperator[];
}>;

export type RallarBlackBoxControlAgentCrdtCapability = Readonly<{
    supported: boolean;
    transports?: readonly RallarBlackBoxTestCrdtTransport[];
    runtimeSurface?: string;
    apiBaseUrlConfigured?: boolean;
}>;

export type RallarBlackBoxGroupMemberCandidate = Readonly<{
    principalId: string;
    username?: string;
    displayName?: string;
    applicationId?: string;
    workspaceId?: string;
    groupId?: string;
    status?: string;
    online?: boolean;
    sessionIds?: readonly string[];
}>;

export type RallarBlackBoxControlAgentCandidate = Readonly<{
    agentId: string;
    connected: boolean;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    identity?: RallarBlackBoxControlAgentIdentity;
}>;

export type RallarBlackBoxGroupControlAgentMatchStatus =
    | 'matched'
    | 'unmatched-group-member'
    | 'offline-agent'
    | 'stale-agent'
    | 'duplicate-session'
    | 'agent-without-group-member'
    | 'agent-without-identity';

export type RallarBlackBoxGroupControlAgentMatch = Readonly<{
    status: RallarBlackBoxGroupControlAgentMatchStatus;
    targetable: boolean;
    reason: string;
    member?: RallarBlackBoxGroupMemberCandidate;
    agent?: RallarBlackBoxControlAgentCandidate;
    candidateAgents: readonly RallarBlackBoxControlAgentCandidate[];
}>;

export type RallarBlackBoxGroupControlAgentMatchResult = Readonly<{
    group: RallarBlackBoxDistributedGroupRef;
    matches: readonly RallarBlackBoxGroupControlAgentMatch[];
    targetableAgentIds: readonly string[];
    summary: Readonly<{
        members: number;
        agents: number;
        matched: number;
        targetable: number;
        unmatchedMembers: number;
        offlineAgents: number;
        staleAgents: number;
        duplicateSessions: number;
        agentsWithoutMembers: number;
        agentsWithoutIdentity: number;
    }>;
}>;

export type RallarBlackBoxDistributedRunRecipeSelection = Readonly<{
    recipeId?: string;
    recipe?: RallarBlackBoxTestRecipe;
    role?: string;
    profile?: string;
    variables?: Readonly<Record<string, unknown>>;
    secretRefs?: readonly string[];
    required?: boolean;
}>;

export type RallarBlackBoxDistributedRoleAssignment = Readonly<{
    role: string;
    agentId: string;
    recipeIds?: readonly string[];
    required?: boolean;
    variables?: Readonly<Record<string, unknown>>;
}>;

export type RallarBlackBoxDistributedRoleAssignmentPolicy = Readonly<{
    mode: RallarBlackBoxDistributedRoleAssignmentPolicyMode;
    pattern: RallarBlackBoxDistributedRolePattern;
    orderBy?: RallarBlackBoxDistributedRoleAssignmentOrdering;
}>;

export type RallarBlackBoxDistributedTargetPolicy = Readonly<{
    mode: RallarBlackBoxDistributedTargetPolicyMode;
    expectedParticipantCount?: number;
    agentIds?: readonly string[];
    roles?: Readonly<Record<string, readonly string[]>>;
    includeOfflineExpectedAgents?: boolean;
}>;

export type RallarBlackBoxDistributedArtifactPolicy = Readonly<{
    retainArtifacts?: boolean;
    includeEventJsonl?: boolean;
    includeResultJsonl?: boolean;
    includeFailureBundle?: boolean;
    includeDistributedMetadata?: boolean;
    retentionDays?: number;
}>;

export type RallarBlackBoxDistributedBarrierPolicy = Readonly<{
    enabled?: boolean;
    timeoutMs?: number;
}>;

export type RallarBlackBoxDistributedRunManifest = Readonly<{
    schemaVersion?: 1;
    distributedRunId: string;
    controlRunId?: string;
    displayName?: string;
    description?: string;
    group: RallarBlackBoxDistributedGroupRef;
    recipes: readonly RallarBlackBoxDistributedRunRecipeSelection[];
    targetPolicy: RallarBlackBoxDistributedTargetPolicy;
    variables?: Readonly<Record<string, unknown>>;
    secretRefs?: readonly string[];
    roleAssignments?: readonly RallarBlackBoxDistributedRoleAssignment[];
    roleAssignmentPolicy?: RallarBlackBoxDistributedRoleAssignmentPolicy;
    ackTimeoutMs?: number;
    barrier?: RallarBlackBoxDistributedBarrierPolicy;
    startMode?: RallarBlackBoxDistributedStartMode;
    startDeadlineEpochMs?: number;
    artifactPolicy?: RallarBlackBoxDistributedArtifactPolicy;
    metadata?: Readonly<Record<string, unknown>>;
}>;

export type RallarBlackBoxDistributedTargetBlockerStatus =
    | 'offline-agent'
    | 'stale-agent'
    | 'different-group'
    | 'missing-assertion-capability'
    | 'agent-without-identity';

export type RallarBlackBoxDistributedTargetBlocker = Readonly<{
    agentId: string;
    status: RallarBlackBoxDistributedTargetBlockerStatus;
    reason: string;
    identity?: RallarBlackBoxControlAgentIdentity;
}>;

export type RallarBlackBoxDistributedTargetResolution = Readonly<{
    group: RallarBlackBoxDistributedGroupRef;
    resolvedAtEpochMs: number;
    staleAfterMs: number;
    targetPolicyMode: RallarBlackBoxDistributedTargetPolicyMode;
    targetAgentIds: readonly string[];
    roleAssignments: readonly RallarBlackBoxDistributedRoleAssignment[];
    blockers: readonly RallarBlackBoxDistributedTargetBlocker[];
    summary: Readonly<{
        agents: number;
        targetable: number;
        selected: number;
        expectedParticipantCount?: number;
        missingExpectedParticipants: number;
        staleAgents: number;
        offlineAgents: number;
        wrongGroupAgents: number;
        assertionCapabilityBlockedAgents?: number;
        agentsWithoutIdentity: number;
        roleCounts: Readonly<Record<string, number>>;
        regions: Readonly<Record<string, number>>;
        providers: Readonly<Record<string, number>>;
    }>;
}>;

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

export type RallarBlackBoxDistributedRunError = Readonly<{
    code: string;
    message: string;
    details?: unknown;
}>;

export type RallarBlackBoxDistributedParticipantResult = Readonly<{
    agentId: string;
    clientId?: string;
    sessionId?: string;
    roles?: readonly string[];
    required?: boolean;
    state: RallarBlackBoxDistributedRunItemState;
    ok?: boolean;
    acknowledgedAtEpochMs?: number;
    startedAtEpochMs?: number;
    endedAtEpochMs?: number;
    error?: RallarBlackBoxDistributedRunError;
}>;

export type RallarBlackBoxDistributedRecipeResult = Readonly<{
    recipeKey: string;
    recipeId?: string;
    agentId?: string;
    role?: string;
    required?: boolean;
    state: RallarBlackBoxDistributedRunItemState;
    ok?: boolean;
    commandResultCount?: number;
    failureCount?: number;
    startedAtEpochMs?: number;
    endedAtEpochMs?: number;
    error?: RallarBlackBoxDistributedRunError;
}>;

export type RallarBlackBoxDistributedRunRollupInput = Readonly<{
    stateHint?: RallarBlackBoxDistributedRunState;
    participants?: readonly RallarBlackBoxDistributedParticipantResult[];
    recipes?: readonly RallarBlackBoxDistributedRecipeResult[];
}>;

export type RallarBlackBoxDistributedRunRollup = Readonly<{
    state: RallarBlackBoxDistributedRunState;
    ok: boolean;
    summary: Readonly<{
        participants: number;
        requiredParticipants: number;
        readyParticipants: number;
        passedParticipants: number;
        failedParticipants: number;
        recipes: number;
        requiredRecipes: number;
        passedRecipes: number;
        failedRecipes: number;
        blockingFailures: number;
    }>;
    failures: readonly Readonly<{
        kind: 'participant' | 'recipe';
        key: string;
        state: RallarBlackBoxDistributedRunItemState;
        required: boolean;
        error?: RallarBlackBoxDistributedRunError;
    }>[];
}>;

export type RallarBlackBoxDistributedRunValidationIssue = Readonly<{
    path: string;
    message: string;
}>;

export type RallarBlackBoxDistributedRunValidationResult =
    | Readonly<{ ok: true; errors: readonly [] }>
    | Readonly<{ ok: false; errors: readonly RallarBlackBoxDistributedRunValidationIssue[] }>;

export function isDistributedRunTerminalState(
    state: RallarBlackBoxDistributedRunState,
): state is RallarBlackBoxDistributedRunTerminalState {
    return RALLAR_BLACK_BOX_DISTRIBUTED_RUN_TERMINAL_STATES.includes(
        state as RallarBlackBoxDistributedRunTerminalState,
    );
}

export function validateDistributedRunManifestContract(
    manifest: RallarBlackBoxDistributedRunManifest,
): RallarBlackBoxDistributedRunValidationResult {
    const errors: RallarBlackBoxDistributedRunValidationIssue[] = [];

    requireNonEmptyString(manifest.distributedRunId, '$.distributedRunId', errors);
    requireNonEmptyString(manifest.group.applicationId, '$.group.applicationId', errors);
    requireNonEmptyString(manifest.group.workspaceId, '$.group.workspaceId', errors);
    requireNonEmptyString(manifest.group.groupId, '$.group.groupId', errors);

    if (manifest.recipes.length === 0) {
        errors.push({ path: '$.recipes', message: 'At least one recipe selection is required.' });
    }

    manifest.recipes.forEach((recipe, index) => {
        if (!cleanString(recipe.recipeId) && !recipe.recipe) {
            errors.push({
                path: `$.recipes[${index}]`,
                message: 'Recipe selection requires recipeId or inline recipe.',
            });
        }
    });

    const expectedParticipantCount = manifest.targetPolicy.expectedParticipantCount;
    if (expectedParticipantCount !== undefined && (!Number.isInteger(expectedParticipantCount) || expectedParticipantCount < 1)) {
        errors.push({
            path: '$.targetPolicy.expectedParticipantCount',
            message: 'Expected participant count must be an integer >= 1.',
        });
    }

    if (manifest.targetPolicy.mode === 'selected-agents' && (manifest.targetPolicy.agentIds?.length ?? 0) === 0) {
        errors.push({
            path: '$.targetPolicy.agentIds',
            message: 'selected-agents target policy requires at least one agent ID.',
        });
    }

    if (manifest.targetPolicy.mode === 'role-map') {
        const roleMapCount = Object.values(manifest.targetPolicy.roles ?? {})
            .reduce((count, agentIds) => count + agentIds.length, 0);
        const roleAssignmentCount = manifest.roleAssignments?.length ?? 0;
        if (roleMapCount === 0 && roleAssignmentCount === 0) {
            errors.push({
                path: '$.targetPolicy.roles',
                message: 'role-map target policy requires roles or roleAssignments.',
            });
        }
    }

    if (manifest.roleAssignmentPolicy !== undefined) {
        const policy = manifest.roleAssignmentPolicy;
        if (policy.mode !== 'ordered-targets') {
            errors.push({
                path: '$.roleAssignmentPolicy.mode',
                message: 'Role assignment policy mode must be ordered-targets.',
            });
        }
        if (!RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_PATTERNS.includes(policy.pattern)) {
            errors.push({
                path: '$.roleAssignmentPolicy.pattern',
                message: 'Role assignment policy pattern is not supported.',
            });
        }
        if (
            policy.orderBy !== undefined &&
            !RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_ORDERINGS.includes(policy.orderBy)
        ) {
            errors.push({
                path: '$.roleAssignmentPolicy.orderBy',
                message: 'Role assignment policy ordering is not supported.',
            });
        }
    }

    if (manifest.startMode === 'scheduled' && manifest.startDeadlineEpochMs === undefined) {
        errors.push({
            path: '$.startDeadlineEpochMs',
            message: 'Scheduled distributed runs require startDeadlineEpochMs.',
        });
    }

    if (manifest.ackTimeoutMs !== undefined && (!Number.isInteger(manifest.ackTimeoutMs) || manifest.ackTimeoutMs < 1)) {
        errors.push({
            path: '$.ackTimeoutMs',
            message: 'ACK timeout must be an integer >= 1.',
        });
    }

    if (
        manifest.barrier?.timeoutMs !== undefined &&
        (!Number.isInteger(manifest.barrier.timeoutMs) || manifest.barrier.timeoutMs < 1)
    ) {
        errors.push({
            path: '$.barrier.timeoutMs',
            message: 'Barrier timeout must be an integer >= 1.',
        });
    }

    return errors.length === 0
        ? { ok: true, errors: [] }
        : { ok: false, errors };
}

export function resolveGroupMemberControlAgentMatches(input: Readonly<{
    group: RallarBlackBoxDistributedGroupRef;
    members: readonly RallarBlackBoxGroupMemberCandidate[];
    agents: readonly RallarBlackBoxControlAgentCandidate[];
    nowEpochMs?: number;
    staleAfterMs?: number;
}>): RallarBlackBoxGroupControlAgentMatchResult {
    const nowEpochMs = input.nowEpochMs ?? Date.now();
    const staleAfterMs = input.staleAfterMs ?? 30_000;
    const consumedAgentIds = new Set<string>();
    const matches: RallarBlackBoxGroupControlAgentMatch[] = [];

    for (const member of input.members) {
        const candidates = input.agents.filter(agent =>
            agentMatchesMemberInGroup(agent, member, input.group)
        );
        const activeCandidates = candidates.filter(agent =>
            agent.connected && !agentIsStale(agent, nowEpochMs, staleAfterMs)
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
                candidateAgents: candidates,
            });
            continue;
        }

        if (activeCandidates.length > 1) {
            activeCandidates.forEach(agent => consumedAgentIds.add(agent.agentId));
            matches.push({
                status: 'duplicate-session',
                targetable: false,
                reason: 'Group member matches multiple connected control agents; select a target explicitly.',
                member,
                candidateAgents: candidates,
            });
            continue;
        }

        if (candidates.some(agent => agent.connected && agentIsStale(agent, nowEpochMs, staleAfterMs))) {
            candidates.forEach(agent => consumedAgentIds.add(agent.agentId));
            matches.push({
                status: 'stale-agent',
                targetable: false,
                reason: 'Matching control agent is connected but stale.',
                member,
                candidateAgents: candidates,
            });
            continue;
        }

        if (candidates.some(agent => !agent.connected)) {
            candidates.forEach(agent => consumedAgentIds.add(agent.agentId));
            matches.push({
                status: 'offline-agent',
                targetable: false,
                reason: 'Matching control agent is offline.',
                member,
                candidateAgents: candidates,
            });
            continue;
        }

        matches.push({
            status: 'unmatched-group-member',
            targetable: false,
            reason: 'No connected control agent identity matches this group member.',
            member,
            candidateAgents: [],
        });
    }

    for (const agent of input.agents) {
        if (consumedAgentIds.has(agent.agentId)) {
            continue;
        }

        if (!agent.identity || !cleanString(agent.identity.principalId ?? agent.identity.clientId ?? agent.identity.username)) {
            matches.push({
                status: 'agent-without-identity',
                targetable: false,
                reason: 'Control agent has not reported Rallar identity metadata.',
                agent,
                candidateAgents: [agent],
            });
            continue;
        }

        if (identityMatchesGroup(agent.identity, input.group)) {
            matches.push({
                status: 'agent-without-group-member',
                targetable: false,
                reason: 'Control agent reports this group but no matching group member was observed.',
                agent,
                candidateAgents: [agent],
            });
        }
    }

    const targetableAgentIds = matches
        .filter(match => match.targetable && match.agent)
        .map(match => match.agent!.agentId);
    const count = (status: RallarBlackBoxGroupControlAgentMatchStatus) =>
        matches.filter(match => match.status === status).length;

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
            agentsWithoutIdentity: count('agent-without-identity'),
        },
    };
}

export function resolveDistributedTargetAgentIds(input: Readonly<{
    matchResult: RallarBlackBoxGroupControlAgentMatchResult;
    targetPolicy: RallarBlackBoxDistributedTargetPolicy;
}>): readonly string[] {
    const targetable = new Set(input.matchResult.targetableAgentIds);
    const unique = (values: readonly string[]) => [...new Set(values)].filter(value => targetable.has(value));

    switch (input.targetPolicy.mode) {
        case 'all-online-group-members':
            return input.matchResult.targetableAgentIds;
        case 'selected-agents':
            return unique(input.targetPolicy.agentIds ?? []);
        case 'role-map':
            return unique(Object.values(input.targetPolicy.roles ?? {}).flat());
    }
}

export function resolveDistributedRunTargets(input: Readonly<{
    manifest: RallarBlackBoxDistributedRunManifest;
    agents: readonly RallarBlackBoxControlAgentCandidate[];
    nowEpochMs?: number;
    staleAfterMs?: number;
}>): RallarBlackBoxDistributedTargetResolution {
    const nowEpochMs = input.nowEpochMs ?? Date.now();
    const staleAfterMs = input.staleAfterMs ?? 30_000;
    const blockers: RallarBlackBoxDistributedTargetBlocker[] = [];
    const targetableAgentIds: string[] = [];
    const targetableById = new Set<string>();
    const assertionFeatures = collectDistributedAssertionFeatures(
        input.manifest.recipes
            .map(selection => selection.recipe)
            .filter((recipe): recipe is RallarBlackBoxTestRecipe => recipe !== undefined),
    );

    for (const agent of input.agents) {
        const blocker = distributedTargetBlocker({
            agent,
            group: input.manifest.group,
            nowEpochMs,
            staleAfterMs,
            assertionFeatures,
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
        roleAssignments: input.manifest.roleAssignments ?? [],
    });
    const roleAssignments = distributedRoleAssignments({
        manifest: input.manifest,
        targetAgentIds: selected,
    });
    const roleCounts = countBy(roleAssignments.map(assignment => assignment.role));
    const selectedAgentSet = new Set(selected);
    const selectedAgents = input.agents.filter(agent => selectedAgentSet.has(agent.agentId));
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
            staleAgents: blockers.filter(blocker => blocker.status === 'stale-agent').length,
            offlineAgents: blockers.filter(blocker => blocker.status === 'offline-agent').length,
            wrongGroupAgents: blockers.filter(blocker => blocker.status === 'different-group').length,
            assertionCapabilityBlockedAgents: blockers
                .filter(blocker => blocker.status === 'missing-assertion-capability').length,
            agentsWithoutIdentity: blockers.filter(blocker => blocker.status === 'agent-without-identity').length,
            roleCounts,
            regions: countBy(selectedAgents.map(agent => agent.identity?.region).filter(isString)),
            providers: countBy(selectedAgents.map(agent => agent.identity?.provider).filter(isString)),
        },
    };
}

interface DistributedTargetBlockerInput {
    readonly agent: RallarBlackBoxControlAgentCandidate;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly nowEpochMs: number;
    readonly staleAfterMs: number;
    readonly assertionFeatures: DistributedAssertionFeatures;
}

function distributedTargetBlocker(
    input: DistributedTargetBlockerInput,
): RallarBlackBoxDistributedTargetBlocker | undefined {
    const agent = input.agent;
    if (!agent.identity) {
        return {
            agentId: agent.agentId,
            status: 'agent-without-identity',
            reason: 'Control agent has not reported Rallar identity metadata.',
        };
    }
    if (!identityMatchesGroup(agent.identity, input.group)) {
        return {
            agentId: agent.agentId,
            status: 'different-group',
            reason: 'Control agent reports a different application, workspace, or group.',
            identity: agent.identity,
        };
    }
    if (!agent.connected) {
        return {
            agentId: agent.agentId,
            status: 'offline-agent',
            reason: 'Control agent is offline.',
            identity: agent.identity,
        };
    }
    if (agentIsStale(agent, input.nowEpochMs, input.staleAfterMs)) {
        return {
            agentId: agent.agentId,
            status: 'stale-agent',
            reason: 'Control agent heartbeat is stale.',
            identity: agent.identity,
        };
    }
    const unmetAssertionReason = validateAgentAssertionCapability(
        input.assertionFeatures,
        agent.identity.capabilities,
    );
    if (unmetAssertionReason) {
        return {
            agentId: agent.agentId,
            status: 'missing-assertion-capability',
            reason: unmetAssertionReason,
            identity: agent.identity,
        };
    }
    return undefined;
}

function distributedSelectedAgentIds(input: Readonly<{
    policy: RallarBlackBoxDistributedTargetPolicy;
    targetableAgentIds: readonly string[];
    targetableById: ReadonlySet<string>;
    roleAssignments: readonly RallarBlackBoxDistributedRoleAssignment[];
}>): readonly string[] {
    const uniqueTargetable = (values: readonly string[]) =>
        [...new Set(values)]
            .filter(value => input.targetableById.has(value))
            .sort((left, right) => left.localeCompare(right));

    if (input.policy.mode === 'all-online-group-members') {
        return [...input.targetableAgentIds].sort((left, right) => left.localeCompare(right));
    }
    if (input.policy.mode === 'selected-agents') {
        return uniqueTargetable(input.policy.agentIds ?? []);
    }
    return uniqueTargetable([
        ...Object.values(input.policy.roles ?? {}).flat(),
        ...input.roleAssignments.map(assignment => assignment.agentId),
    ]);
}

function distributedRoleAssignments(input: Readonly<{
    manifest: RallarBlackBoxDistributedRunManifest;
    targetAgentIds: readonly string[];
}>): readonly RallarBlackBoxDistributedRoleAssignment[] {
    if ((input.manifest.roleAssignments?.length ?? 0) > 0) {
        const selected = new Set(input.targetAgentIds);
        return (input.manifest.roleAssignments ?? [])
            .filter(assignment => selected.has(assignment.agentId))
            .map(assignment => ({ ...assignment }));
    }

    const roles = input.manifest.targetPolicy.roles;
    if (roles && Object.keys(roles).length > 0) {
        const selected = new Set(input.targetAgentIds);
        return Object.entries(roles)
            .flatMap(([role, agentIds]) =>
                agentIds
                    .filter(agentId => selected.has(agentId))
                    .map(agentId => ({
                        role,
                        agentId,
                        required: true,
                    }))
            );
    }

    const policy = input.manifest.roleAssignmentPolicy;
    if (!policy || policy.mode !== 'ordered-targets') {
        return [];
    }

    return roleAssignmentsForPattern(policy.pattern, input.targetAgentIds);
}

function roleAssignmentsForPattern(
    pattern: RallarBlackBoxDistributedRolePattern,
    agentIds: readonly string[],
): readonly RallarBlackBoxDistributedRoleAssignment[] {
    if (pattern === 'all-agents') {
        return [];
    }
    if (pattern === 'sender-receiver') {
        return [
            ...agentIds.slice(0, 1).map(agentId => ({ role: 'sender', agentId, required: true })),
            ...agentIds.slice(1, 2).map(agentId => ({ role: 'receiver', agentId, required: true })),
        ];
    }
    if (pattern === 'one-sender-many-receivers') {
        return [
            ...agentIds.slice(0, 1).map(agentId => ({ role: 'sender', agentId, required: true })),
            ...agentIds.slice(1).map(agentId => ({ role: 'receiver', agentId, required: true })),
        ];
    }
    return [
        ...agentIds.slice(0, 1).map(agentId => ({ role: 'publisher', agentId, required: true })),
        ...agentIds.slice(1, 2).map(agentId => ({ role: 'relay', agentId, required: true })),
        ...agentIds.slice(2).map(agentId => ({ role: 'observer', agentId, required: true })),
    ];
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const value of values) {
        counts[value] = (counts[value] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
    );
}

function isString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

export function rollupDistributedRunResult(
    input: RallarBlackBoxDistributedRunRollupInput,
): RallarBlackBoxDistributedRunRollup {
    const participants = input.participants ?? [];
    const recipes = input.recipes ?? [];
    const requiredParticipants = participants.filter(item => item.required !== false);
    const requiredRecipes = recipes.filter(item => item.required !== false);
    const requiredItems = [
        ...requiredParticipants.map(item => ({ kind: 'participant' as const, key: item.agentId, item })),
        ...requiredRecipes.map(item => ({ kind: 'recipe' as const, key: itemKey(item), item })),
    ];
    const failures = requiredItems
        .filter(({ item }) => isBlockingItemFailure(item))
        .map(({ kind, key, item }) => ({
            kind,
            key,
            state: item.state,
            required: item.required !== false,
            error: item.error,
        }));

    const state = deriveRollupState(input.stateHint, requiredParticipants, requiredRecipes, failures);

    return {
        state,
        ok: state === 'passed',
        summary: {
            participants: participants.length,
            requiredParticipants: requiredParticipants.length,
            readyParticipants: requiredParticipants.filter(item => item.state === 'ready' || item.state === 'running' || item.state === 'passed').length,
            passedParticipants: requiredParticipants.filter(item => item.state === 'passed').length,
            failedParticipants: requiredParticipants.filter(isBlockingItemFailure).length,
            recipes: recipes.length,
            requiredRecipes: requiredRecipes.length,
            passedRecipes: requiredRecipes.filter(item => item.state === 'passed' && item.ok !== false).length,
            failedRecipes: requiredRecipes.filter(isBlockingItemFailure).length,
            blockingFailures: failures.length,
        },
        failures,
    };
}

function deriveRollupState(
    stateHint: RallarBlackBoxDistributedRunState | undefined,
    participants: readonly RallarBlackBoxDistributedParticipantResult[],
    recipes: readonly RallarBlackBoxDistributedRecipeResult[],
    failures: readonly { state: RallarBlackBoxDistributedRunItemState }[],
): RallarBlackBoxDistributedRunState {
    if (stateHint && isDistributedRunTerminalState(stateHint)) {
        return stateHint;
    }

    if (failures.some(failure => failure.state === 'timed-out')) {
        return 'timed-out';
    }

    if (failures.some(failure => failure.state === 'cancelled')) {
        return 'cancelled';
    }

    if (failures.length > 0) {
        return 'failed';
    }

    if (recipes.length > 0 && recipes.every(item => item.state === 'passed' && item.ok !== false)) {
        return 'passed';
    }

    if (recipes.some(item => item.state === 'running') || participants.some(item => item.state === 'running')) {
        return 'running';
    }

    if (participants.length > 0 && participants.every(item =>
        item.state === 'ready' ||
        item.state === 'running' ||
        item.state === 'passed'
    )) {
        return 'ready';
    }

    if (participants.some(item => item.state === 'acknowledged')) {
        if (stateHint === 'waiting-for-barrier') {
            return 'waiting-for-barrier';
        }
        return 'waiting-for-ack';
    }

    return stateHint ?? 'draft';
}

function isBlockingItemFailure(item: Readonly<{
    state: RallarBlackBoxDistributedRunItemState;
    ok?: boolean;
}>): boolean {
    return item.ok === false ||
        item.state === 'failed' ||
        item.state === 'timed-out' ||
        item.state === 'cancelled' ||
        item.state === 'disconnected';
}

function agentMatchesMemberInGroup(
    agent: RallarBlackBoxControlAgentCandidate,
    member: RallarBlackBoxGroupMemberCandidate,
    group: RallarBlackBoxDistributedGroupRef,
): boolean {
    const identity = agent.identity;
    if (!identityMatchesGroup(identity, group)) {
        return false;
    }

    const memberIds = new Set([
        member.principalId,
        member.username,
    ].map(cleanString).filter((value): value is string => Boolean(value)));
    const identityIds = [
        identity?.principalId,
        identity?.clientId,
        identity?.username,
    ].map(cleanString).filter((value): value is string => Boolean(value));

    if (!identityIds.some(id => memberIds.has(id))) {
        return false;
    }

    const memberSessionIds = new Set((member.sessionIds ?? []).map(cleanString).filter((value): value is string => Boolean(value)));
    if (memberSessionIds.size === 0) {
        return true;
    }

    return Boolean(identity?.sessionId && memberSessionIds.has(identity.sessionId));
}

function identityMatchesGroup(
    identity: RallarBlackBoxControlAgentIdentity | undefined,
    group: RallarBlackBoxDistributedGroupRef,
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
    staleAfterMs: number,
): boolean {
    const lastSeen = agent.lastHeartbeatAtEpochMs ?? agent.lastSeenAtEpochMs ?? agent.identity?.updatedAtEpochMs;
    return typeof lastSeen === 'number' && nowEpochMs - lastSeen > staleAfterMs;
}

function itemKey(item: RallarBlackBoxDistributedRecipeResult): string {
    return item.recipeKey || [item.agentId, item.recipeId, item.role].filter(Boolean).join(':') || 'recipe';
}

function requireNonEmptyString(
    value: string,
    path: string,
    errors: RallarBlackBoxDistributedRunValidationIssue[],
): void {
    if (!cleanString(value)) {
        errors.push({ path, message: 'A non-empty string is required.' });
    }
}

function cleanString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined;
}
