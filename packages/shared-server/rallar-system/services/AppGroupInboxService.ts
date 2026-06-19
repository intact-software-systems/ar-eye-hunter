import type {
    AcceptGroupInviteRequest,
    AppointGroupDirectorRequest,
    ConnectGroupPresenceSessionRequest,
    CreateGroupInviteRequest,
    CreateGroupRequest,
    DisconnectGroupPresenceSessionRequest,
    HeartbeatGroupPresenceSessionRequest,
    JoinGroupRequest,
    BanGroupMemberRequest,
    RemoveGroupMemberRequest,
    RevokeGroupInviteRequest,
    RotateGroupJoinCodeRequest,
    SetGroupMemberRoleRequest,
    StateScope,
    TransferGroupOwnershipRequest,
    UnbanGroupMemberRequest,
    UpdateGroupRequest,
    UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    ResourceInboxResultsRepository
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type {
    GroupJoinCodeWritten,
    GroupMutationWritten,
    GroupStateService,
    GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import {
    AppInboxEnqueueInput,
    AppInboxService,
    type AppInboxServiceOptions,
    AppInboxType,
    SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { isCompletedOrFailed } from '@shared/queuebox/ResourceEntry.ts';
import type { RallarTimingSink } from './timing.ts';

export {
    AppInboxService,
    AppInboxType,
    type AppInboxEnqueueInput,
    type AppInboxServiceOptions,
} from '@shared-server/rallar-system/services/AppInboxService.ts';

export type GroupCreateAppInboxPayload = Readonly<{
    scope: StateScope;
    request: CreateGroupRequest;
}>;

export type GroupUpdateAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: UpdateGroupRequest;
}>;

export type GroupDirectorAppointAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: AppointGroupDirectorRequest;
}>;

export type GroupJoinAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: JoinGroupRequest;
}>;

export type GroupInviteCreateAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: CreateGroupInviteRequest;
}>;

export type GroupInviteRevokeAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: RevokeGroupInviteRequest;
}>;

export type GroupInviteAcceptAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: AcceptGroupInviteRequest;
}>;

export type GroupJoinCodeRotateAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: RotateGroupJoinCodeRequest;
}>;

export type GroupMemberRemoveAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: RemoveGroupMemberRequest;
}>;

export type GroupMemberBanAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: BanGroupMemberRequest;
}>;

export type GroupMemberUnbanAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: UnbanGroupMemberRequest;
}>;

export type GroupMemberRoleSetAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: SetGroupMemberRoleRequest;
}>;

export type GroupOwnershipTransferAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    request: TransferGroupOwnershipRequest;
}>;

export type GroupMemberUpsertAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: UpsertGroupMemberRequest;
}>;

export type GroupPresenceConnectAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    sessionId: string;
    request: ConnectGroupPresenceSessionRequest;
}>;

export type GroupPresenceHeartbeatAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    sessionId: string;
    request: HeartbeatGroupPresenceSessionRequest;
}>;

export type GroupPresenceDisconnectAppInboxPayload = Readonly<{
    scope: StateScope;
    groupId: string;
    sessionId: string;
    request: DisconnectGroupPresenceSessionRequest;
}>;

export type GroupPresenceDisconnectBySessionIdAppInboxPayload = Readonly<{
    sessionId: string;
    request?: DisconnectGroupPresenceSessionRequest;
}>;

export type GroupExpiredPresenceSessionsAppInboxPayload = Readonly<{
    atEpochMs: number;
}>;

export class AppGroupInboxService extends AppInboxService {
    constructor(
        public override readonly inbox: InboxQueueReader,
        public override readonly resourceInbox: ResourceInboxRepository,
        public override readonly resourceInboxResults: ResourceInboxResultsRepository,
        public readonly groupStateService: GroupStateService,
        public readonly stateSyncPublisher: StateSyncPublisher,
        public override readonly serviceId: string,
        timing?: RallarTimingSink,
        options?: AppInboxServiceOptions,
    ) {
        super(
            inbox,
            resourceInbox,
            resourceInboxResults,
            serviceId,
            SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
            timing,
            options,
        );

        this.onStateMessage<GroupCreateAppInboxPayload>(
            AppInboxType.GROUP_CREATE,
            async (groupCreate) => {
                const groupStateWritten = await this.groupStateService.createGroup(
                    groupCreate.scope,
                    groupCreate.request,
                );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupUpdateAppInboxPayload>(
            AppInboxType.GROUP_UPDATE,
            async (update) => {
                const groupStateWritten = await this.groupStateService.updateGroup(
                    update.scope,
                    update.groupId,
                    update.request,
                );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupDirectorAppointAppInboxPayload>(
            AppInboxType.GROUP_DIRECTOR_APPOINT,
            async (appointment) => {
                const groupStateWritten =
                    await this.groupStateService.appointDirector(
                        appointment.scope,
                        appointment.groupId,
                        appointment.request,
                    );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupJoinAppInboxPayload>(
            AppInboxType.GROUP_JOIN,
            async (join) => {
                const groupStateWritten = await this.groupStateService.joinGroup(
                    join.scope,
                    join.groupId,
                    join.request,
                );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupInviteCreateAppInboxPayload>(
            AppInboxType.GROUP_INVITE_CREATE,
            async (invite) => {
                const groupStateWritten =
                    await this.groupStateService.createGroupInvite(
                        invite.scope,
                        invite.groupId,
                        invite.principalId,
                        invite.request,
                    );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupInviteRevokeAppInboxPayload>(
            AppInboxType.GROUP_INVITE_REVOKE,
            async (invite) => {
                const groupStateWritten =
                    await this.groupStateService.revokeGroupInvite(
                        invite.scope,
                        invite.groupId,
                        invite.principalId,
                        invite.request,
                    );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupInviteAcceptAppInboxPayload>(
            AppInboxType.GROUP_INVITE_ACCEPT,
            async (invite) => {
                const groupStateWritten =
                    await this.groupStateService.acceptGroupInvite(
                        invite.scope,
                        invite.groupId,
                        invite.request,
                    );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupJoinCodeRotateAppInboxPayload>(
            AppInboxType.GROUP_JOIN_CODE_ROTATE,
            async (joinCode) => {
                const written = await this.groupStateService.rotateGroupJoinCode(
                    joinCode.scope,
                    joinCode.groupId,
                    joinCode.request,
                );

                await this.publishGroupJoinCodeWritten(written);

                return written;
            },
        );
        this.onStateMessage<GroupMemberRemoveAppInboxPayload>(
            AppInboxType.GROUP_MEMBER_REMOVE,
            async (member) => {
                const groupStateWritten = await this.groupStateService.removeGroupMember(
                    member.scope,
                    member.groupId,
                    member.principalId,
                    member.request,
                );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupMemberBanAppInboxPayload>(
            AppInboxType.GROUP_MEMBER_BAN,
            async (member) => {
                const groupStateWritten = await this.groupStateService.banGroupMember(
                    member.scope,
                    member.groupId,
                    member.principalId,
                    member.request,
                );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupMemberUnbanAppInboxPayload>(
            AppInboxType.GROUP_MEMBER_UNBAN,
            async (member) => {
                const groupStateWritten = await this.groupStateService.unbanGroupMember(
                    member.scope,
                    member.groupId,
                    member.principalId,
                    member.request,
                );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupMemberRoleSetAppInboxPayload>(
            AppInboxType.GROUP_MEMBER_ROLE_SET,
            async (member) => {
                const groupStateWritten = await this.groupStateService.setGroupMemberRole(
                    member.scope,
                    member.groupId,
                    member.principalId,
                    member.request,
                );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupOwnershipTransferAppInboxPayload>(
            AppInboxType.GROUP_OWNERSHIP_TRANSFER,
            async (transfer) => {
                const groupStateWritten =
                    await this.groupStateService.transferGroupOwnership(
                        transfer.scope,
                        transfer.groupId,
                        transfer.request,
                    );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupMemberUpsertAppInboxPayload>(
            AppInboxType.GROUP_MEMBER_UPSERT,
            async (member) => {
                const groupStateWritten = await this.groupStateService.upsertMember(
                    member.scope,
                    member.groupId,
                    member.principalId,
                    member.request,
                );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupPresenceConnectAppInboxPayload>(
            AppInboxType.GROUP_PRESENCE_CONNECT,
            async (presence) => {
                const groupStateWritten =
                    await this.groupStateService.connectPresenceSession(
                        presence.scope,
                        presence.groupId,
                        presence.sessionId,
                        presence.request,
                    );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupPresenceHeartbeatAppInboxPayload>(
            AppInboxType.GROUP_PRESENCE_HEARTBEAT,
            async (presence) => {
                const groupStateWritten =
                    await this.groupStateService.heartbeatPresenceSession(
                        presence.scope,
                        presence.groupId,
                        presence.sessionId,
                        presence.request,
                    );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupPresenceDisconnectAppInboxPayload>(
            AppInboxType.GROUP_PRESENCE_DISCONNECT,
            async (presence) => {
                const groupStateWritten =
                    await this.groupStateService.disconnectPresenceSession(
                        presence.scope,
                        presence.groupId,
                        presence.sessionId,
                        presence.request,
                    );

                await this.publishGroupStateWritten(groupStateWritten);

                return groupStateWritten;
            },
        );
        this.onStateMessage<GroupPresenceDisconnectBySessionIdAppInboxPayload>(
            AppInboxType.GROUP_PRESENCE_DISCONNECT_BY_SESSION_ID,
            async (presence) => {
                const groupStateWrittenResults =
                    await this.groupStateService.disconnectPresenceSessionsBySessionIdWritten(
                        presence.sessionId,
                        presence.request,
                    );

                for (const groupStateWritten of groupStateWrittenResults) {
                    await this.publishGroupStateWritten(groupStateWritten);
                }

                return groupStateWrittenResults;
            },
        );
        this.onStateMessage<GroupExpiredPresenceSessionsAppInboxPayload>(
            AppInboxType.GROUP_EXPIRED_PRESENCE_SESSIONS,
            async (input) => {
                const groupStateWrittenResults =
                    await this.groupStateService.expireExpiredPresenceSessions(
                        input.atEpochMs,
                    );

                for (const groupStateWritten of groupStateWrittenResults) {
                    await this.publishGroupStateWritten(groupStateWritten);
                }

                return groupStateWrittenResults;
            },
        );
    }

    public async processPresenceDisconnectsBySessionId(
        sessionId: string,
        request?: DisconnectGroupPresenceSessionRequest,
    ) {
        return await this.processEntryUntilCompletion<
            GroupPresenceDisconnectBySessionIdAppInboxPayload,
            readonly GroupStateWritten[]
        >({
            type: AppInboxType.GROUP_PRESENCE_DISCONNECT_BY_SESSION_ID,
            resourceId: `disconnect-presence-${sessionId}`,
            contextId: sessionId,
            senderId: request?.actorPrincipalId ?? request?.actorSessionId ?? sessionId,
            data: {
                sessionId,
                request,
            },
        });
    }

    public async processExpiredPresenceSessions(atEpochMs: number = Date.now()) {
        return await this.processEntryUntilCompletionIf<
            GroupExpiredPresenceSessionsAppInboxPayload,
            readonly GroupStateWritten[]
        >(
            this.toExpiredPresenceSessionsEnqueue(atEpochMs),
            entry => isCompletedOrFailed(entry.status),
        );
    }

    public processExpiredPresenceSessionsNoWaiting(
        atEpochMs: number = Date.now(),
    ): void {
        this.processEntryNoWaitingIf<GroupExpiredPresenceSessionsAppInboxPayload>(
            this.toExpiredPresenceSessionsEnqueue(atEpochMs),
            entry => isCompletedOrFailed(entry.status),
        );
    }

    private async publishGroupStateWritten(
        groupStateWritten: GroupStateWritten,
    ): Promise<void> {
        if (groupStateWritten.result.right) {
            await this.publishGroupMutation(groupStateWritten.result.right);
        }
    }

    private async publishGroupJoinCodeWritten(
        written: GroupJoinCodeWritten,
    ): Promise<void> {
        if (written.result.right) {
            await this.publishGroupMutation(written.result.right);
        }
    }

    private async publishGroupMutation(
        written: GroupMutationWritten,
    ): Promise<void> {
        if (!written.event) {
            return;
        }

        await this.stateSyncPublisher.publishGroupSnapshot(
            written.snapshot,
            this.serviceId,
        );

        await this.stateSyncPublisher.publishGroupEvent(
            written.event,
            this.serviceId,
        );
    }

    private toExpiredPresenceSessionsEnqueue(
        atEpochMs: number,
    ): AppInboxEnqueueInput<GroupExpiredPresenceSessionsAppInboxPayload> {
        return {
            type: AppInboxType.GROUP_EXPIRED_PRESENCE_SESSIONS,
            topicId: AppInboxType.GROUP_EXPIRED_PRESENCE_SESSIONS,
            resourceId: `expire-group-presence`,
            contextId: 'expire-group-presence',
            senderId: this.serviceId,
            data: {
                atEpochMs,
            },
        };
    }
}
