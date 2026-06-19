import type {
    ClientInstanceStatus,
    ClientPlatform,
    ClientPresenceState,
    ClientPrincipalStatus,
    ClientTransport,
} from './client-types.ts';
import type { Group, GroupJoinMode, GroupMemberStatus, GroupRole, GroupStatus, } from './group-types.ts';

export const DEFAULT_STATE_APPLICATION_ID = 'rallar-server';
export const DEFAULT_STATE_WORKSPACE_ID = 'default';

export type StateScope = Readonly<{
    applicationId: string;
    workspaceId: string;
}>;

export type MutationActorInput = Readonly<{
    actorPrincipalId?: string;
    actorSessionId?: string;
    reason?: string;
    traceId?: string;
    requestId?: string;
}>;

export type UpsertClientPrincipalRequest =
    & MutationActorInput
    & Readonly<{
    username: string;
    displayName?: string;
    avatarUrl?: string;
    status?: ClientPrincipalStatus;
    authProvider?: string;
    externalSubjectId?: string;
    roles?: readonly string[];
    metadata?: Record<string, unknown>;
    lastSeenAtEpochMs?: number;
}>;

export type UpsertClientInstanceRequest =
    & MutationActorInput
    & Readonly<{
    status?: ClientInstanceStatus;
    platform?: ClientPlatform;
    deviceLabel?: string;
    appVersion?: string;
    userAgent?: string;
    capabilities?: readonly string[];
}>;

export type ConnectClientSessionRequest =
    & MutationActorInput
    & Readonly<{
    presenceState?: ClientPresenceState;
    transport?: ClientTransport;
    connectionId?: string;
    authenticatedAtEpochMs?: number;
    connectedAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    expiresAtEpochMs?: number;
}>;

export type HeartbeatClientSessionRequest =
    & MutationActorInput
    & Readonly<{
    presenceState?: ClientPresenceState;
    lastHeartbeatAtEpochMs?: number;
    expiresAtEpochMs?: number;
}>;

export type DisconnectClientSessionRequest =
    & MutationActorInput
    & Readonly<{
    disconnectedAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    expiresAtEpochMs?: number;
}>;

export type CreateGroupRequest =
    & MutationActorInput
    & Readonly<{
    groupId: string;
    slug?: string;
    displayName: string;
    description?: string;
    kind: Group['kind'];
    joinMode?: GroupJoinMode;
    maxMembers?: number;
    maxSessionsPerMember?: number;
    metadata?: Record<string, unknown>;
    createdByPrincipalId: string;
    expiresAtEpochMs?: number;
    purgeAfterEpochMs?: number;
}>;

export type UpdateGroupRequest =
    & MutationActorInput
    & Readonly<{
    slug?: string;
    displayName?: string;
    description?: string;
    kind?: Group['kind'];
    status?: GroupStatus;
    joinMode?: GroupJoinMode;
    maxMembers?: number;
    maxSessionsPerMember?: number;
    metadata?: Record<string, unknown>;
    expiresAtEpochMs?: number;
    emptySinceEpochMs?: number;
    purgeAfterEpochMs?: number;
}>;

export type AppointGroupDirectorRequest =
    & MutationActorInput
    & Readonly<{
    heartbeatTtlMs?: number;
}>;

export type UpsertGroupMemberRequest =
    & MutationActorInput
    & Readonly<{
    role?: GroupRole;
    status: GroupMemberStatus;
    invitedByPrincipalId?: string;
    invitationExpiresAtEpochMs?: number;
}>;

export type ConnectGroupPresenceSessionRequest =
    & MutationActorInput
    & Readonly<{
    principalId: string;
    connectedAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    expiresAtEpochMs?: number;
}>;

export type HeartbeatGroupPresenceSessionRequest =
    & MutationActorInput
    & Readonly<{
    principalId?: string;
    lastHeartbeatAtEpochMs?: number;
    expiresAtEpochMs?: number;
}>;

export type DisconnectGroupPresenceSessionRequest =
    & MutationActorInput
    & Readonly<{
    principalId?: string;
    disconnectedAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    expiresAtEpochMs?: number;
}>;

export type StateErrorResponse = Readonly<{
    error: string;
}>;
