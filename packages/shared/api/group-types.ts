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
    byPrincipalId?: PrincipalId;
    bySessionId?: SessionId;
    byServiceId?: string;
    reason?: string;
    traceId?: string;
    requestId?: string;
}>;

export type GroupScope = Readonly<{
    applicationId: ApplicationId;
    workspaceId?: WorkspaceId;
}>;

export type GroupRef =
    & GroupScope
    & Readonly<{
    groupId: GroupId;
}>;

export type Group =
    & GroupRef
    & Readonly<{
    slug?: string;
    displayName: string;
    description?: string;
    kind: 'party' | 'room' | 'team' | 'custom';
    status: GroupStatus;
    joinMode: GroupJoinMode;
    maxMembers?: number;
    maxSessionsPerMember?: number;
    metadata: Record<string, unknown>;

    snapshotVersion: number;
    metadataVersion: number;
    rosterVersion: number;
    presenceVersion: number;

    created: AuditStamp;
    updated: AuditStamp;
    archived?: AuditStamp;
    deleted?: AuditStamp;

    expiresAtEpochMs?: number;
    emptySinceEpochMs?: number;
    purgeAfterEpochMs?: number;
}>;

export type GroupMember =
    & GroupRef
    & Readonly<{
    principalId: PrincipalId;
    role: GroupRole;
    status: GroupMemberStatus;

    joined: AuditStamp;
    updated: AuditStamp;
    left?: AuditStamp;
    removed?: AuditStamp;
    banned?: AuditStamp;

    invitedByPrincipalId?: PrincipalId;
    invitationExpiresAtEpochMs?: number;
}>;

export type GroupPresenceSession =
    & GroupRef
    & Readonly<{
    sessionId: SessionId;
    principalId: PrincipalId;

    connectedAtEpochMs: number;
    lastHeartbeatAtEpochMs: number;
    expiresAtEpochMs: number;

    disconnectedAtEpochMs?: number;
    disconnectReason?: string;
}>;

export type GroupSnapshot = Readonly<{
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
    | 'session-connected'
    | 'session-heartbeat'
    | 'session-disconnected';

export type GroupEvent =
    & GroupRef
    & Readonly<{
    eventId: string;
    eventType: GroupEventType;
    snapshotVersion: number;
    occurredAtEpochMs: number;
    actor: {
        principalId?: PrincipalId;
        sessionId?: SessionId;
        serviceId?: string;
    };
    reason?: string;
    traceId?: string;
    requestId?: string;
    payload?: Record<string, unknown>;
}>;
