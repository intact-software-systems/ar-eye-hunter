import type { ApiJsonObject } from './api-json-value.ts';
import type {
    ClientInstanceStatus,
    ClientPlatform,
    ClientPresenceState,
    ClientPrincipalStatus,
    ClientTransport
} from './client-types.ts';
import type { GroupLifecyclePolicyInput } from './group-lifecycle/group-lifecycle-policy.ts';
import type { Group, GroupJoinMode, GroupMemberStatus, GroupRole, GroupSnapshot, GroupStatus } from './group-types.ts';

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
        metadata?: ApiJsonObject;
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
        generationId: string;
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
        generationId: string;
        presenceState?: ClientPresenceState;
        lastHeartbeatAtEpochMs?: number;
        expiresAtEpochMs?: number;
    }>;

export type DisconnectClientSessionRequest =
    & MutationActorInput
    & Readonly<{
        generationId: string;
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
        metadata?: ApiJsonObject;
        createdByPrincipalId: string;
        expiresAtEpochMs?: number;
        purgeAfterEpochMs?: number;
        lifecyclePolicy?: GroupLifecyclePolicyInput;
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
        metadata?: ApiJsonObject;
        expiresAtEpochMs?: number;
        emptySinceEpochMs?: number;
        purgeAfterEpochMs?: number;
    }>;

export type AppointGroupDirectorRequest =
    & MutationActorInput
    & Readonly<{
        heartbeatTtlMs?: number;
    }>;

export type JoinGroupRequest =
    & MutationActorInput
    & Readonly<{
        inviteToken?: string;
        joinCode?: string;
    }>;

export type CreateGroupInviteRequest =
    & MutationActorInput
    & Readonly<{
        invitationExpiresAtEpochMs?: number;
    }>;

export type RevokeGroupInviteRequest = MutationActorInput;

export type AcceptGroupInviteRequest = MutationActorInput;

export type RotateGroupJoinCodeRequest =
    & MutationActorInput
    & Readonly<{
        joinCode?: string;
        expiresAtEpochMs?: number;
    }>;

export type GroupJoinCodeResponse = Readonly<{
    joinCode: string;
    expiresAtEpochMs: number;
    snapshot: GroupSnapshot;
}>;

export type RemoveGroupMemberRequest = MutationActorInput;

export type BanGroupMemberRequest = MutationActorInput;

export type UnbanGroupMemberRequest = MutationActorInput;

export type SetGroupMemberRoleRequest =
    & MutationActorInput
    & Readonly<{
        role: GroupRole;
    }>;

export type TransferGroupOwnershipRequest =
    & MutationActorInput
    & Readonly<{
        newOwnerPrincipalId: string;
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
        generationId: string;
        connectedAtEpochMs?: number;
        lastHeartbeatAtEpochMs?: number;
        expiresAtEpochMs?: number;
    }>;

export type HeartbeatGroupPresenceSessionRequest =
    & MutationActorInput
    & Readonly<{
        generationId: string;
        principalId?: string;
        lastHeartbeatAtEpochMs?: number;
        expiresAtEpochMs?: number;
    }>;

export type DisconnectGroupPresenceSessionRequest =
    & MutationActorInput
    & Readonly<{
        generationId: string;
        principalId?: string;
        disconnectedAtEpochMs?: number;
        lastHeartbeatAtEpochMs?: number;
        expiresAtEpochMs?: number;
    }>;

export type StateErrorResponse = Readonly<{
    error: string;
    code?: string;
    message?: string;
    details?: ApiJsonObject;
}>;
