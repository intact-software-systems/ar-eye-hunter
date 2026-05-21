import type {
    ConnectGroupPresenceSessionRequest,
    CreateGroupRequest,
    DisconnectGroupPresenceSessionRequest,
    HeartbeatGroupPresenceSessionRequest,
    StateScope,
    UpdateGroupRequest,
    UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    ResourceInboxResultsRepository
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type {
    GroupMutationWritten,
    GroupStateService,
    GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import {
    AppInboxService,
    AppInboxType,
    SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
} from '@shared-server/rallar-system/services/AppInboxService.ts';

export {
    AppInboxService,
    AppInboxType,
    type AppInboxEnqueueInput,
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

export class AppGroupInboxService extends AppInboxService {
    constructor(
        public override readonly inbox: InboxQueueReader,
        public override readonly resourceInbox: ResourceInboxRepository,
        public override readonly resourceInboxResults: ResourceInboxResultsRepository,
        public readonly groupStateService: GroupStateService,
        public readonly stateSyncPublisher: StateSyncPublisher,
        public override readonly serviceId: string,
    ) {
        super(
            inbox,
            resourceInbox,
            resourceInboxResults,
            serviceId,
            SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
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
    }

    private async publishGroupStateWritten(
        groupStateWritten: GroupStateWritten,
    ): Promise<void> {
        const result = groupStateWritten.result as
            | GroupStateWritten['result']
            | {
            left?: string;
            right?: GroupMutationWritten;
        };

        if ('fold' in result && typeof result.fold === 'function') {
            await result.fold(
                async () => undefined,
                async (written) => await this.publishGroupMutation(written),
            );
            return;
        }

        if (result.right) {
            await this.publishGroupMutation(result.right);
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
}
