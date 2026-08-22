import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type {
    AuthenticatedGroupMutationEnqueue
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type {
    GroupStateInboxDurableResult
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import type {
    CachedGroupStateService
} from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import type {
    StateSyncCacheHydrationInput,
    StateSyncCacheHydrationResult
} from '@shared-server/rallar-system/state-sync/state-sync-cache-hydration.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupStateSnapshotReadOptions, StateSnapshotReadResult } from '@shared/api/state-snapshot-read.ts';
import type {
    AcceptGroupInviteRequest,
    AppointGroupDirectorRequest,
    BanGroupMemberRequest,
    ConnectGroupPresenceSessionRequest,
    CreateGroupInviteRequest,
    CreateGroupRequest,
    DisconnectGroupPresenceSessionRequest,
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
import type { GroupAdmissionQuota } from '../services/group-admission-rate-limit.ts';

export type GroupStateRouteService = Pick<
    CachedGroupStateService,
    | 'listSnapshots'
    | 'readSnapshot'
    | 'listEvents'
    | 'listRecentEvents'
    | 'listEventPage'
    | 'readCurrentSnapshot'
>;

export type GroupStateRouteAuthSession = Pick<
    IssuedAuthSession,
    | 'clientId'
    | 'sessionId'
    | 'accessToken'
    | 'issuedAtEpochMs'
    | 'expiresAtEpochMs'
    | 'username'
>;

interface GroupStateRouteCommandInputBase {
    readonly authSession: GroupStateRouteAuthSession;
    readonly scope: StateScope;
}

type GroupStateRouteRequestWithId<T> = T & Readonly<{ requestId: string; }>;

export type GroupStateRouteCommandInput =
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'create-group';
            request: GroupStateRouteRequestWithId<CreateGroupRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'update-group';
            groupId: string;
            request: GroupStateRouteRequestWithId<UpdateGroupRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'appoint-group-director';
            groupId: string;
            request: GroupStateRouteRequestWithId<AppointGroupDirectorRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'start-group-establishment';
            groupId: string;
            request: GroupStateRouteRequestWithId<MutationActorInput>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'activate-group';
            groupId: string;
            request: GroupStateRouteRequestWithId<MutationActorInput>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'reopen-group-establishment';
            groupId: string;
            request: GroupStateRouteRequestWithId<MutationActorInput>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'join-group';
            groupId: string;
            request: GroupStateRouteRequestWithId<JoinGroupRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'accept-group-invite';
            groupId: string;
            request: GroupStateRouteRequestWithId<AcceptGroupInviteRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'rotate-group-join-code';
            groupId: string;
            request: GroupStateRouteRequestWithId<RotateGroupJoinCodeRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'create-group-invite';
            groupId: string;
            principalId: string;
            request: GroupStateRouteRequestWithId<CreateGroupInviteRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'revoke-group-invite';
            groupId: string;
            principalId: string;
            request: GroupStateRouteRequestWithId<RevokeGroupInviteRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'grant-group-admission';
            groupId: string;
            principalId: string;
            request: GroupStateRouteRequestWithId<MutationActorInput>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'decline-group-admission';
            groupId: string;
            principalId: string;
            request: GroupStateRouteRequestWithId<MutationActorInput>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'remove-group-member';
            groupId: string;
            principalId: string;
            request: GroupStateRouteRequestWithId<RemoveGroupMemberRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'ban-group-member';
            groupId: string;
            principalId: string;
            request: GroupStateRouteRequestWithId<BanGroupMemberRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'unban-group-member';
            groupId: string;
            principalId: string;
            request: GroupStateRouteRequestWithId<UnbanGroupMemberRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'set-group-member-role';
            groupId: string;
            principalId: string;
            request: GroupStateRouteRequestWithId<SetGroupMemberRoleRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'transfer-group-ownership';
            groupId: string;
            request: GroupStateRouteRequestWithId<TransferGroupOwnershipRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'upsert-group-member';
            groupId: string;
            principalId: string;
            request: GroupStateRouteRequestWithId<UpsertGroupMemberRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'connect-group-presence';
            groupId: string;
            sessionId: string;
            request: GroupStateRouteRequestWithId<ConnectGroupPresenceSessionRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'heartbeat-group-presence';
            groupId: string;
            sessionId: string;
            request: GroupStateRouteRequestWithId<HeartbeatGroupPresenceSessionRequest>;
        }>
    )
    | (
        & GroupStateRouteCommandInputBase
        & Readonly<{
            operation: 'disconnect-group-presence';
            groupId: string;
            sessionId: string;
            request: GroupStateRouteRequestWithId<DisconnectGroupPresenceSessionRequest>;
        }>
    );

export type ProcessGroupAppInbox = (
    authority: GroupStateRouteAuthSession,
    enqueue: AuthenticatedGroupMutationEnqueue
) => Promise<GroupStateInboxDurableResult>;

export interface GroupStateRouteRequest {
    header(name: string): string | undefined;
}

export interface GroupStateRouteScopeRequest {
    param(key: 'applicationId' | 'workspaceId'): string;
}

export interface GroupStateRouteScopeContext {
    readonly req: GroupStateRouteScopeRequest;
}

export interface GroupStateRouteDependencies {
    readonly groupStateService: GroupStateRouteService;
    readonly requireApiAuthSession: (
        request: GroupStateRouteRequest
    ) => Promise<GroupStateRouteAuthSession>;
    readonly processGroupAppInbox: ProcessGroupAppInbox;
    readonly groupAdmissionQuota: GroupAdmissionQuota;
    readonly strictReadAuthorization: boolean;
    readonly hydrateStateSyncSnapshotCaches: (
        input: StateSyncCacheHydrationInput
    ) => Promise<StateSyncCacheHydrationResult>;
    readonly readGroupSnapshot: (
        ref: GroupRef,
        options: GroupStateSnapshotReadOptions & Readonly<{ strictMode?: boolean; }>
    ) => Promise<StateSnapshotReadResult<GroupSnapshot>>;
}

export function toGroupStateRouteScope(
    context: GroupStateRouteScopeContext
): StateScope {
    return {
        applicationId: context.req.param('applicationId'),
        workspaceId: context.req.param('workspaceId')
    };
}
