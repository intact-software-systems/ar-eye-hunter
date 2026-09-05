import type {
    AcceptGroupInviteRequest,
    AppointGroupDirectorRequest,
    BanGroupMemberRequest,
    ConnectGroupPresenceSessionRequest,
    CreateGroupInviteRequest,
    CreateGroupRequest,
    DisconnectGroupPresenceSessionRequest,
    GroupConnectRequest,
    HeartbeatGroupPresenceSessionRequest,
    JoinGroupRequest,
    MutationActorInput,
    RemoveGroupMemberRequest,
    RevokeGroupInviteRequest,
    RotateGroupJoinCodeRequest,
    SetGroupMemberRoleRequest,
    StateScope,
    TransferGroupOwnershipRequest,
    UnbanGroupMemberRequest,
    UpdateGroupRequest,
    UpsertGroupMemberRequest
} from '@shared/api/state-types.ts';

import type { GroupTopologyReconfigureLanding } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

import { AppInboxType, type AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';

export interface GroupCreateAppInboxPayload {
    readonly scope: StateScope;
    readonly request: CreateGroupRequest;
}

export interface GroupUpdateAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly request: UpdateGroupRequest;
}

export interface GroupDirectorAppointAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly request: AppointGroupDirectorRequest;
}

/**
 * `connect` names the exact planned layout it means to dial (product
 * decision 32), so its causal fence rides inside `request` (I16) — the
 * payload cannot reuse the bare lifecycle shape.
 */
export interface GroupConnectAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly request: GroupConnectRequest;
}

export interface GroupLifecycleTransitionAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly request: MutationActorInput;
}

export interface GroupReconfigureAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly request:
        & MutationActorInput
        & Readonly<{
            expectedFormationEpoch: number | null;
            landing: GroupTopologyReconfigureLanding | null;
        }>;
}

export interface GroupJoinAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly request: JoinGroupRequest;
}

export interface GroupInviteCreateAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly principalId: string;
    readonly request: CreateGroupInviteRequest;
}

export interface GroupInviteRevokeAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly principalId: string;
    readonly request: RevokeGroupInviteRequest;
}

export interface GroupInviteAcceptAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly request: AcceptGroupInviteRequest;
}

export interface GroupAdmissionGrantAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly principalId: string;
    readonly request: MutationActorInput;
}

export interface GroupAdmissionDeclineAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly principalId: string;
    readonly request: MutationActorInput;
}

export interface GroupJoinCodeRotateAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly request: RotateGroupJoinCodeRequest;
}

export interface GroupMemberRemoveAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly principalId: string;
    readonly request: RemoveGroupMemberRequest;
}

export interface GroupMemberBanAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly principalId: string;
    readonly request: BanGroupMemberRequest;
}

export interface GroupMemberUnbanAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly principalId: string;
    readonly request: UnbanGroupMemberRequest;
}

export interface GroupMemberRoleSetAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly principalId: string;
    readonly request: SetGroupMemberRoleRequest;
}

export interface GroupOwnershipTransferAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly request: TransferGroupOwnershipRequest;
}

export interface GroupMemberUpsertAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly principalId: string;
    readonly request: UpsertGroupMemberRequest;
}

export interface GroupPresenceConnectAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly sessionId: string;
    readonly request: ConnectGroupPresenceSessionRequest;
}

export interface GroupPresenceHeartbeatAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly sessionId: string;
    readonly request: HeartbeatGroupPresenceSessionRequest;
}

/**
 * The transport valve's payload (product decision 25). It carries no
 * operation field: the caller names only the decision and itself — the
 * command's direction is the AppInbox type.
 */
export interface GroupTransportCommandAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly request: MutationActorInput;
}

export interface GroupPresenceDisconnectAppInboxPayload {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly sessionId: string;
    readonly request: DisconnectGroupPresenceSessionRequest;
}

export interface AuthenticatedGroupMutationPayloadByType {
    [AppInboxType.GROUP_CREATE]: GroupCreateAppInboxPayload;
    [AppInboxType.GROUP_UPDATE]: GroupUpdateAppInboxPayload;
    [AppInboxType.GROUP_DIRECTOR_APPOINT]: GroupDirectorAppointAppInboxPayload;
    [AppInboxType.GROUP_PLAN]: GroupLifecycleTransitionAppInboxPayload;
    [AppInboxType.GROUP_CONNECT]: GroupConnectAppInboxPayload;
    [AppInboxType.GROUP_ACTIVATE]: GroupLifecycleTransitionAppInboxPayload;
    [AppInboxType.GROUP_RECONFIGURE]: GroupReconfigureAppInboxPayload;
    [AppInboxType.GROUP_JOIN]: GroupJoinAppInboxPayload;
    [AppInboxType.GROUP_INVITE_CREATE]: GroupInviteCreateAppInboxPayload;
    [AppInboxType.GROUP_INVITE_REVOKE]: GroupInviteRevokeAppInboxPayload;
    [AppInboxType.GROUP_INVITE_ACCEPT]: GroupInviteAcceptAppInboxPayload;
    [AppInboxType.GROUP_ADMISSION_GRANT]: GroupAdmissionGrantAppInboxPayload;
    [AppInboxType.GROUP_ADMISSION_DECLINE]: GroupAdmissionDeclineAppInboxPayload;
    [AppInboxType.GROUP_JOIN_CODE_ROTATE]: GroupJoinCodeRotateAppInboxPayload;
    [AppInboxType.GROUP_MEMBER_REMOVE]: GroupMemberRemoveAppInboxPayload;
    [AppInboxType.GROUP_MEMBER_BAN]: GroupMemberBanAppInboxPayload;
    [AppInboxType.GROUP_MEMBER_UNBAN]: GroupMemberUnbanAppInboxPayload;
    [AppInboxType.GROUP_MEMBER_ROLE_SET]: GroupMemberRoleSetAppInboxPayload;
    [AppInboxType.GROUP_OWNERSHIP_TRANSFER]: GroupOwnershipTransferAppInboxPayload;
    [AppInboxType.GROUP_MEMBER_UPSERT]: GroupMemberUpsertAppInboxPayload;
    [AppInboxType.GROUP_PRESENCE_CONNECT]: GroupPresenceConnectAppInboxPayload;
    [AppInboxType.GROUP_PRESENCE_HEARTBEAT]: GroupPresenceHeartbeatAppInboxPayload;
    [AppInboxType.GROUP_PRESENCE_DISCONNECT]: GroupPresenceDisconnectAppInboxPayload;
    [AppInboxType.GROUP_TRANSPORT_PAUSE]: GroupTransportCommandAppInboxPayload;
    [AppInboxType.GROUP_TRANSPORT_RESUME]: GroupTransportCommandAppInboxPayload;
    [AppInboxType.GROUP_FORMATION_START]: GroupLifecycleTransitionAppInboxPayload;
    [AppInboxType.GROUP_FORMATION_RESET]: GroupLifecycleTransitionAppInboxPayload;
}

export type AuthenticatedGroupMutationInboxType = keyof AuthenticatedGroupMutationPayloadByType;

export type AuthenticatedGroupMutationEnqueue = Readonly<
    {
        [Type in AuthenticatedGroupMutationInboxType]:
            & Omit<AppInboxEnqueueInput, 'type' | 'data'>
            & Readonly<{
                type: Type;
                data: AuthenticatedGroupMutationPayloadByType[Type];
            }>;
    }
>[AuthenticatedGroupMutationInboxType];

interface AuthenticatedGroupMutationEnqueueCandidate {
    readonly type: AppInboxType;
}

export const AUTHENTICATED_GROUP_INBOX_TYPES = [
    AppInboxType.GROUP_CREATE,
    AppInboxType.GROUP_UPDATE,
    AppInboxType.GROUP_DIRECTOR_APPOINT,
    AppInboxType.GROUP_PLAN,
    AppInboxType.GROUP_CONNECT,
    AppInboxType.GROUP_ACTIVATE,
    AppInboxType.GROUP_RECONFIGURE,
    AppInboxType.GROUP_JOIN,
    AppInboxType.GROUP_INVITE_CREATE,
    AppInboxType.GROUP_INVITE_REVOKE,
    AppInboxType.GROUP_INVITE_ACCEPT,
    AppInboxType.GROUP_ADMISSION_GRANT,
    AppInboxType.GROUP_ADMISSION_DECLINE,
    AppInboxType.GROUP_JOIN_CODE_ROTATE,
    AppInboxType.GROUP_MEMBER_REMOVE,
    AppInboxType.GROUP_MEMBER_BAN,
    AppInboxType.GROUP_MEMBER_UNBAN,
    AppInboxType.GROUP_MEMBER_ROLE_SET,
    AppInboxType.GROUP_OWNERSHIP_TRANSFER,
    AppInboxType.GROUP_MEMBER_UPSERT,
    AppInboxType.GROUP_PRESENCE_CONNECT,
    AppInboxType.GROUP_PRESENCE_HEARTBEAT,
    AppInboxType.GROUP_PRESENCE_DISCONNECT,
    AppInboxType.GROUP_TRANSPORT_PAUSE,
    AppInboxType.GROUP_TRANSPORT_RESUME,
    AppInboxType.GROUP_FORMATION_START,
    AppInboxType.GROUP_FORMATION_RESET
] as const;

export const GROUP_MUTATION_INBOX_TYPES = [
    ...AUTHENTICATED_GROUP_INBOX_TYPES,
    AppInboxType.GROUP_PRESENCE_EXPIRE,
    AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
    AppInboxType.GROUP_FORMATION_AUTOMATION,
    AppInboxType.GROUP_FORMATION_CRITERION,
    AppInboxType.GROUP_TOPOLOGY_PUBLICATION,
    AppInboxType.GROUP_ACTIVATION_STATUS
] as const;

export function isAuthenticatedGroupMutationEnqueue(
    enqueue: AuthenticatedGroupMutationEnqueueCandidate
): enqueue is AuthenticatedGroupMutationEnqueue {
    return (AUTHENTICATED_GROUP_INBOX_TYPES as readonly AppInboxType[]).includes(enqueue.type);
}
