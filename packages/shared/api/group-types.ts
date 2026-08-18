import type {
    GroupFormationOutcome,
    GroupLifecycleState,
} from './group-lifecycle/group-lifecycle-policy.ts';
import type { MutationActor } from './mutation-actor.ts';

export type ApplicationId = string;
export type WorkspaceId = string;
export type GroupId = string;
export type PrincipalId = string;
export type SessionId = string;
export type ActorId = string;

export type GroupStatus =
    | 'active'
    | 'archived'
    | 'deleted';

export type GroupMemberStatus =
    | 'invited'
    | 'active'
    | 'left'
    | 'removed'
    | 'banned';

export type GroupRole =
    | 'owner'
    | 'admin'
    | 'member';

export type GroupJoinMode =
    | 'invite-only'
    | 'code'
    | 'open';

export type AuditStamp = Readonly<{
    atEpochMs: number;
    actor: MutationActor;
    reason: string | null;
    traceId: string | null;
    requestId: string | null;
}>;

export type GroupScope = Readonly<{
    applicationId: ApplicationId;
    workspaceId: WorkspaceId;
}>;

export type GroupRef =
    & GroupScope
    & Readonly<{
    groupId: GroupId;
}>;

type GroupBase =
    & GroupRef
    & Readonly<{
    slug: string | null;
    displayName: string;
    description: string | null;
    kind: 'party' | 'room' | 'team' | 'custom';
    joinMode: GroupJoinMode;
    maxMembers: number | null;
    maxSessionsPerMember: number | null;
    metadata: Record<string, unknown>;

    /** Guarded roster facts maintained with every authoritative group write. */
    activeMemberCount: number;
    ownerPrincipalId: PrincipalId;

    snapshotVersion: number;
    metadataVersion: number;
    rosterVersion: number;
    presenceVersion: number;

    created: AuditStamp;
    updated: AuditStamp;
    expiresAtEpochMs: number | null;
    emptySinceEpochMs: number | null;
    purgeAfterEpochMs: number | null;

    /**
     * Formation intent, orthogonal to the business `status` below. Authoritative
     * and policy-driven; the RTC activation projection observes connectivity and
     * never decides this.
     */
    lifecycleState: GroupLifecycleState;

    /**
     * Monotonic counter advanced only by an accepted lifecycle transition
     * command, never by joins. Election and readiness pin their member set to
     * this boundary so membership churn during FORMING cannot flap them.
     */
    formationEpoch: number;

    /** Completed criterion evaluations that did not reach full activation. */
    formationAttemptCount: number;

    /** Null until the criterion first decides; then the recorded decision. */
    lastFormationOutcome: GroupFormationOutcome | null;

    /**
     * When the current establishment phase began -- set by the
     * start-establishment and reopen-establishment transitions, because
     * `updated` is overwritten by any group write and the epoch is a counter,
     * not a time. Null before the first establishment. The deadline half of
     * the activation criterion measures from here.
     */
    establishmentStartedAtEpochMs: number | null;
}>;

export type Group = GroupBase & (
    | Readonly<{ status: 'active'; archived: null; deleted: null }>
    | Readonly<{ status: 'archived'; archived: AuditStamp; deleted: null }>
    | Readonly<{
        status: 'deleted';
        archived: AuditStamp | null;
        deleted: AuditStamp;
    }>
);

type GroupMemberBase =
    & GroupRef
    & Readonly<{
    principalId: PrincipalId;
    role: GroupRole;
    joined: AuditStamp | null;
    updated: AuditStamp;
    invitedByPrincipalId: PrincipalId | null;
    invitationExpiresAtEpochMs: number | null;
}>;

export type GroupMember = GroupMemberBase & (
    | Readonly<{
        status: 'invited';
        joined: null;
        left: null;
        removed: null;
        banned: null;
    }>
    | Readonly<{
        status: 'active';
        joined: AuditStamp;
        left: null;
        removed: null;
        banned: null;
    }>
    | Readonly<{
        status: 'left';
        joined: AuditStamp | null;
        left: AuditStamp;
        removed: null;
        banned: null;
    }>
    | Readonly<{
        status: 'removed';
        joined: AuditStamp | null;
        left: null;
        removed: AuditStamp;
        banned: null;
    }>
    | Readonly<{
        status: 'banned';
        joined: AuditStamp | null;
        left: null;
        removed: null;
        banned: AuditStamp;
    }>
);

type GroupPresenceSessionBase =
    & GroupRef
    & Readonly<{
    sessionId: SessionId;
    principalId: PrincipalId;

    generationId: string;
    generationVersion: number;

    connectedAtEpochMs: number;
    lastHeartbeatAtEpochMs: number;
    expiresAtEpochMs: number;

}>;

export type GroupPresenceSession = GroupPresenceSessionBase & (
    | Readonly<{
        status: 'active';
        disconnectedAtEpochMs: null;
        disconnectReason: null;
    }>
    | Readonly<{
        status: 'disconnected';
        disconnectedAtEpochMs: number;
        disconnectReason: string;
    }>
);

export type GroupStateCausalRevision = Readonly<{
    groupRevision: number;
    presenceRevision: number;
}>;

export type GroupPresenceSummary =
    & GroupRef
    & Readonly<{
        causalRevision: GroupStateCausalRevision;
        activePrincipalIds: readonly PrincipalId[];
        activeSessionIds: readonly SessionId[];
        activeSessions: readonly GroupPresenceSession[];
        activePrincipalCount: number;
        activeSessionCount: number;
        computedAtEpochMs: number;
    }>;

export type GroupPresenceAdmissionSession = Readonly<{
    sessionId: SessionId;
    generationId: string;
    /**
     * Deterministic monotonic projection of connectedAtEpochMs. Together with
     * generationId this is the total-order and fencing identity.
     */
    generationVersion: number;
    connectedAtEpochMs: number;
}>;

export type GroupPresenceAdmission =
    & GroupRef
    & Readonly<{
        principalId: PrincipalId;
        /** Canonical: sorted by sessionId and unique by sessionId. */
        admittedSessions: readonly GroupPresenceAdmissionSession[];
        updatedAtEpochMs: number;
    }>;

export type GroupSnapshot = Readonly<{
    /** Compatibility projection; causalRevision is authoritative. */
    stateRevision: number;
    causalRevision: GroupStateCausalRevision;
    group: Group;
    members: readonly GroupMember[];
    activeSessions: readonly GroupPresenceSession[];

    memberCount: number;
    onlineMemberCount: number;
}>;

export type GroupEventType =
    | 'group-created'
    | 'group-updated'
    | 'group-archived'
    | 'group-deleted'
    | 'member-invited'
    | 'member-joined'
    | 'member-left'
    | 'member-removed'
    | 'member-banned'
    | 'member-unbanned'
    | 'member-role-changed'
    | 'ownership-transferred'
    | 'session-connected'
    | 'session-heartbeat'
    | 'session-disconnected';

export type GroupEvent =
    & GroupRef
    & Readonly<{
    eventId: string;
    eventType: GroupEventType;
    snapshotVersion: number;
    causalRevision: GroupStateCausalRevision;
    occurredAtEpochMs: number;
    actor: MutationActor;
    reason: string | null;
    traceId: string | null;
    requestId: string | null;
    payload: Record<string, unknown>;
}>;
