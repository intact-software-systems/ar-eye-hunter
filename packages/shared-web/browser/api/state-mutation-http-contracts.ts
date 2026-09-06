import type {
    PutGroupTopologyConfigRequest,
    PutGroupTopologyOverrideRequest,
    ReconfigureGroupTopologyRequest
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupTopologyReconfigureLanding } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type {
    AcceptGroupInviteRequest,
    AppointGroupDirectorRequest,
    BanGroupMemberRequest,
    ConnectClientSessionRequest,
    ConnectGroupPresenceSessionRequest,
    CreateGroupInviteRequest,
    CreateGroupRequest,
    DisconnectGroupPresenceSessionRequest,
    GroupConnectRequest,
    HeartbeatClientSessionRequest,
    HeartbeatGroupPresenceSessionRequest,
    JoinGroupRequest,
    MutationActorInput,
    RemoveGroupMemberRequest,
    RevokeGroupInviteRequest,
    RotateGroupJoinCodeRequest,
    SetGroupMemberRoleRequest,
    TransferGroupOwnershipRequest,
    UnbanGroupMemberRequest,
    UpdateGroupRequest,
    UpsertGroupMemberRequest
} from '@shared/api/state-types.ts';

export type PutStateGroupTopologyConfigBody = Omit<PutGroupTopologyConfigRequest, 'requestId'>;
export type PutStateGroupTopologyOverrideBody = Omit<PutGroupTopologyOverrideRequest, 'requestId'>;
export type ReconfigureStateGroupTopologyBody = Omit<ReconfigureGroupTopologyRequest, 'requestId'>;

export type CreateStateGroupBody = Omit<CreateGroupRequest, 'requestId'>;
export type UpdateStateGroupBody = Omit<UpdateGroupRequest, 'requestId'>;
export type AppointStateGroupDirectorBody = Omit<AppointGroupDirectorRequest, 'requestId'>;
export type JoinStateGroupBody = Omit<JoinGroupRequest, 'requestId'>;
export type CreateStateGroupInviteBody = Omit<CreateGroupInviteRequest, 'requestId'>;
export type RevokeStateGroupInviteBody = Omit<RevokeGroupInviteRequest, 'requestId'>;
export type AcceptStateGroupInviteBody = Omit<AcceptGroupInviteRequest, 'requestId'>;
export type RotateStateGroupJoinCodeBody = Omit<RotateGroupJoinCodeRequest, 'requestId'>;
export type RemoveStateGroupMemberBody = Omit<RemoveGroupMemberRequest, 'requestId'>;
export type BanStateGroupMemberBody = Omit<BanGroupMemberRequest, 'requestId'>;
export type UnbanStateGroupMemberBody = Omit<UnbanGroupMemberRequest, 'requestId'>;
export type SetStateGroupMemberRoleBody = Omit<SetGroupMemberRoleRequest, 'requestId'>;
export type TransferStateGroupOwnershipBody = Omit<TransferGroupOwnershipRequest, 'requestId'>;
export type UpsertStateGroupMemberBody = Omit<UpsertGroupMemberRequest, 'requestId'>;
export type ConnectStateGroupPresenceSessionBody = Omit<ConnectGroupPresenceSessionRequest, 'requestId'>;
export type HeartbeatStateGroupPresenceSessionBody = Omit<HeartbeatGroupPresenceSessionRequest, 'requestId'>;
export type DisconnectStateGroupPresenceSessionBody = Omit<DisconnectGroupPresenceSessionRequest, 'requestId'>;

/**
 * The lifecycle routes take the actor from authentication and declare
 * `additionalProperties: false`, so their bodies carry only the audit fields
 * beside a command's own arguments.
 */
type GroupLifecycleActorFields = 'requestId' | 'actorPrincipalId' | 'actorSessionId';
export type TransitionStateGroupLifecycleBody = Omit<MutationActorInput, GroupLifecycleActorFields>;
export type ConnectStateGroupLifecycleBody = Omit<GroupConnectRequest, GroupLifecycleActorFields>;
export type ReconfigureStateGroupLifecycleBody =
    & TransitionStateGroupLifecycleBody
    & Readonly<{ landing?: GroupTopologyReconfigureLanding; }>;

export type ConnectStateClientSessionBody = Omit<ConnectClientSessionRequest, 'requestId'>;
export type HeartbeatStateClientSessionBody = Omit<HeartbeatClientSessionRequest, 'requestId'>;
