import type { RallarBlackBoxDistributedGroupAssertion } from './distributed/group-assertions.ts';
import type {
    RallarBlackBoxTestAssertOperator,
    RallarBlackBoxTestCrdtTransport,
    RallarBlackBoxTestError,
    RallarBlackBoxTestMessagesCarrier,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord
} from './rallar-black-box-test-contracts.ts';

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

export interface RallarBlackBoxDistributedRunRecipeSelection {
    readonly recipeId: string;
    /** Absent when the selection references a catalog recipe the agent loads by recipeId. */
    readonly recipe?: RallarBlackBoxTestRecipe;
    /** Absent when the recipe runs on every targeted agent regardless of role. */
    readonly role?: string;
    /** Absent when the selection names no catalog profile. */
    readonly profile?: string;
    readonly variables: RallarBlackBoxTestRecord;
    readonly secretRefs: readonly string[];
    readonly required: boolean;
}

export interface RallarBlackBoxDistributedRoleAssignment {
    readonly role: string;
    readonly agentId: string;
    /** Empty when the agent runs every recipe selection for its role. */
    readonly recipeIds: readonly string[];
    readonly required: boolean;
    readonly variables: RallarBlackBoxTestRecord;
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
    readonly variables: RallarBlackBoxTestRecord;
    readonly secretRefs: readonly string[];
    readonly roleAssignments: readonly RallarBlackBoxDistributedRoleAssignment[];
    /** Absent when roles come from targetPolicy.roles or roleAssignments instead of a pattern. */
    readonly roleAssignmentPolicy?: RallarBlackBoxDistributedRoleAssignmentPolicy;
    readonly ackTimeoutMs: number;
    readonly barrier: RallarBlackBoxDistributedBarrierPolicy;
    readonly artifactPolicy: RallarBlackBoxDistributedArtifactPolicy;
    readonly groupAssertions: readonly RallarBlackBoxDistributedGroupAssertion[];
    readonly metadata: RallarBlackBoxTestRecord;
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
    readonly roleAssignments: readonly RallarBlackBoxDistributedRoleAssignment[];
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
    readonly assertionCapabilityBlockedAgents: number;
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
    readonly roles: readonly string[];
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
    readonly agentId: string;
    /** Absent when the start command link names no role. */
    readonly role?: string;
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
