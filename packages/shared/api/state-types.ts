import type { ApiJsonObject } from './api-json-value.ts';
import type {
    ClientInstanceStatus,
    ClientPlatform,
    ClientPresenceState,
    ClientPrincipalStatus,
    ClientTransport
} from './client-types.ts';
import type { GroupDirectoryListing } from './group-directory/group-directory-listing.ts';
import type { GroupLayoutIdentity } from './group-lifecycle/group-layout-identity.ts';
import type { GroupLifecyclePolicyInput } from './group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRetentionIntent } from './group-retention.ts';
import type {
    Group,
    GroupJoinMode,
    GroupMemberStatus,
    GroupRef,
    GroupRole,
    GroupSnapshot,
    GroupStatus
} from './group-types.ts';

export const DEFAULT_STATE_APPLICATION_ID = 'rallar-server';
export const DEFAULT_STATE_WORKSPACE_ID = 'default';

/** The application/workspace projection of a scoped group identity. */
export type StateScope = Pick<GroupRef, 'applicationId' | 'workspaceId'>;

export interface MutationActorInput {
    readonly actorPrincipalId?: string;
    readonly actorSessionId?: string;
    readonly reason?: string;
    readonly requestId?: string;
}

export interface UpsertClientPrincipalRequest extends MutationActorInput {
    readonly username: string;
    readonly displayName?: string;
    readonly avatarUrl?: string;
    readonly status?: ClientPrincipalStatus;
    readonly authProvider?: string;
    readonly externalSubjectId?: string;
    readonly roles?: readonly string[];
    readonly metadata?: ApiJsonObject;
    readonly lastSeenAtEpochMs?: number;
}

export interface UpsertClientInstanceRequest extends MutationActorInput {
    readonly status?: ClientInstanceStatus;
    readonly platform?: ClientPlatform;
    readonly deviceLabel?: string;
    readonly appVersion?: string;
    readonly userAgent?: string;
    readonly capabilities?: readonly string[];
}

export interface ConnectClientSessionRequest extends MutationActorInput {
    readonly generationId: string;
    readonly presenceState?: ClientPresenceState;
    readonly transport?: ClientTransport;
    readonly connectionId?: string;
    readonly authenticatedAtEpochMs?: number;
    readonly connectedAtEpochMs?: number;
    readonly lastHeartbeatAtEpochMs?: number;
    readonly expiresAtEpochMs?: number;
}

export interface HeartbeatClientSessionRequest extends MutationActorInput {
    readonly generationId: string;
    readonly presenceState?: ClientPresenceState;
    readonly lastHeartbeatAtEpochMs?: number;
    readonly expiresAtEpochMs?: number;
}

export interface DisconnectClientSessionRequest extends MutationActorInput {
    readonly generationId: string;
    readonly disconnectedAtEpochMs?: number;
    readonly lastHeartbeatAtEpochMs?: number;
    readonly expiresAtEpochMs?: number;
}

export interface CreateGroupRequest extends MutationActorInput {
    readonly groupId: string;
    readonly slug?: string;
    readonly displayName: string;
    readonly description?: string;
    readonly kind: Group['kind'];
    readonly joinMode?: GroupJoinMode;
    readonly directoryListing?: GroupDirectoryListing;
    readonly retention?: GroupRetentionIntent;
    readonly maxMembers?: number;
    readonly maxSessionsPerMember?: number;
    readonly metadata?: ApiJsonObject;
    readonly createdByPrincipalId: string;
    readonly expiresAtEpochMs?: number;
    readonly purgeAfterEpochMs?: number;
    readonly lifecyclePolicy?: GroupLifecyclePolicyInput;
}

export interface UpdateGroupRequest extends MutationActorInput {
    readonly slug?: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly kind?: Group['kind'];
    readonly status?: GroupStatus;
    readonly joinMode?: GroupJoinMode;
    readonly directoryListing?: GroupDirectoryListing;
    readonly maxMembers?: number;
    readonly maxSessionsPerMember?: number;
    readonly metadata?: ApiJsonObject;
    readonly expiresAtEpochMs?: number;
    readonly emptySinceEpochMs?: number;
    readonly purgeAfterEpochMs?: number;
}

/** `connect` names the exact planned layout it dials (product decision 32). */
export interface GroupConnectRequest extends MutationActorInput {
    readonly expectedFormationEpoch: number;
    readonly expectedLayout: GroupLayoutIdentity;
}

export interface AppointGroupDirectorRequest extends MutationActorInput {
    readonly heartbeatTtlMs?: number;
}

export interface JoinGroupRequest extends MutationActorInput {
    readonly inviteToken?: string;
    readonly joinCode?: string;
}

export interface CreateGroupInviteRequest extends MutationActorInput {
    readonly invitationExpiresAtEpochMs?: number;
}

export interface RevokeGroupInviteRequest extends MutationActorInput {}

export interface AcceptGroupInviteRequest extends MutationActorInput {}

export interface RotateGroupJoinCodeRequest extends MutationActorInput {
    readonly joinCode?: string;
    readonly expiresAtEpochMs?: number;
}

export interface GroupJoinCodeResponse {
    readonly joinCode: string;
    readonly expiresAtEpochMs: number;
    readonly snapshot: GroupSnapshot;
}

export interface RemoveGroupMemberRequest extends MutationActorInput {}

export interface BanGroupMemberRequest extends MutationActorInput {}

export interface UnbanGroupMemberRequest extends MutationActorInput {}

export interface SetGroupMemberRoleRequest extends MutationActorInput {
    readonly role: GroupRole;
}

export interface TransferGroupOwnershipRequest extends MutationActorInput {
    readonly newOwnerPrincipalId: string;
}

export interface UpsertGroupMemberRequest extends MutationActorInput {
    readonly role?: GroupRole;
    readonly status: GroupMemberStatus;
    readonly invitedByPrincipalId?: string;
    readonly invitationExpiresAtEpochMs?: number;
}

export interface ConnectGroupPresenceSessionRequest extends MutationActorInput {
    readonly principalId: string;
    readonly generationId: string;
    readonly connectionGenerationId: string;
    readonly connectedAtEpochMs?: number;
    readonly lastHeartbeatAtEpochMs?: number;
    readonly expiresAtEpochMs?: number;
}

export interface HeartbeatGroupPresenceSessionRequest extends MutationActorInput {
    readonly generationId: string;
    readonly principalId?: string;
    readonly lastHeartbeatAtEpochMs?: number;
    readonly expiresAtEpochMs?: number;
}

export interface DisconnectGroupPresenceSessionRequest extends MutationActorInput {
    readonly generationId: string;
    readonly principalId?: string;
    readonly disconnectedAtEpochMs?: number;
    readonly lastHeartbeatAtEpochMs?: number;
    readonly expiresAtEpochMs?: number;
}

export interface StateErrorResponse {
    readonly error: string;
    readonly code?: string;
    readonly message?: string;
    readonly details?: ApiJsonObject;
}
