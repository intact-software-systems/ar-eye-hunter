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
    GroupMutationAuthorityProof,
    GroupMutationDescriptor,
    GroupStateService,
    GroupStateWritten,
    DisconnectPresenceBySessionRequest,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupMutationAuthorizationError } from '@shared-server/rallar-system/services/group-state-service.ts';
import {
    AppInboxEnqueueInput,
    type AppInboxMessageContext,
    AppInboxService,
    type AppInboxServiceOptions,
    AppInboxType,
    SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { isCompletedOrFailed } from '@shared/queuebox/ResourceEntry.ts';
import type { RallarTimingSink } from './timing.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type { IssuedAuthSession } from '../repositories/AuthSessionRepository.ts';

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
    request?: DisconnectPresenceBySessionRequest;
}>;

export type GroupExpiredPresenceSessionsAppInboxPayload = Readonly<{
    atEpochMs: number;
}>;

export class AppGroupInboxService extends AppInboxService {
    public override async processEntryUntilCompletion<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        authority?: IssuedAuthSession,
    ): Promise<Either<string, R>> {
        if (!this.groupStateService.prepareMutation || isInternalGroupInboxType(enqueue.type)) {
            return await super.processEntryUntilCompletion<V, R>(enqueue);
        }
        if (!authority) {
            throw new GroupMutationAuthorizationError(
                'Authenticated group mutation authority is required.',
            );
        }
        const preparation = await this.groupStateService.prepareMutation(
            toGroupMutationDescriptor(enqueue),
            authority,
        );
        return await super.processEntryUntilCompletion<V, R>({
            ...enqueue,
            resourceId: preparation.queueResourceId,
            authority: preparation.authorityProof,
        });
    }

    constructor(
        public override readonly inbox: InboxQueueReader,
        public override readonly resourceInbox: ResourceInboxRepository,
        public override readonly resourceInboxResults: ResourceInboxResultsRepository,
        public readonly groupStateService: GroupStateService,
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
            async (groupCreate, context) => await callGroupMutation(
                context,
                this.groupStateService.createGroup,
                [groupCreate.scope, groupCreate.request],
            ),
        );
        this.onStateMessage<GroupUpdateAppInboxPayload>(
            AppInboxType.GROUP_UPDATE,
            async (update, context) => await callGroupMutation(
                context,
                this.groupStateService.updateGroup,
                [update.scope, update.groupId, update.request],
            ),
        );
        this.onStateMessage<GroupDirectorAppointAppInboxPayload>(
            AppInboxType.GROUP_DIRECTOR_APPOINT,
            async (appointment, context) => await callGroupMutation(
                context,
                this.groupStateService.appointDirector,
                [appointment.scope, appointment.groupId, appointment.request],
            ),
        );
        this.onStateMessage<GroupJoinAppInboxPayload>(
            AppInboxType.GROUP_JOIN,
            async (join, context) => await callGroupMutation(
                context,
                this.groupStateService.joinGroup,
                [join.scope, join.groupId, join.request],
            ),
        );
        this.onStateMessage<GroupInviteCreateAppInboxPayload>(
            AppInboxType.GROUP_INVITE_CREATE,
            async (invite, context) => await callGroupMutation(
                context,
                this.groupStateService.createGroupInvite,
                [invite.scope, invite.groupId, invite.principalId, invite.request],
            ),
        );
        this.onStateMessage<GroupInviteRevokeAppInboxPayload>(
            AppInboxType.GROUP_INVITE_REVOKE,
            async (invite, context) => await callGroupMutation(
                context,
                this.groupStateService.revokeGroupInvite,
                [invite.scope, invite.groupId, invite.principalId, invite.request],
            ),
        );
        this.onStateMessage<GroupInviteAcceptAppInboxPayload>(
            AppInboxType.GROUP_INVITE_ACCEPT,
            async (invite, context) => await callGroupMutation(
                context,
                this.groupStateService.acceptGroupInvite,
                [invite.scope, invite.groupId, invite.request],
            ),
        );
        this.onStateMessage<GroupJoinCodeRotateAppInboxPayload>(
            AppInboxType.GROUP_JOIN_CODE_ROTATE,
            async (joinCode, context) => await callGroupMutation(
                context,
                this.groupStateService.rotateGroupJoinCode,
                [joinCode.scope, joinCode.groupId, joinCode.request],
            ),
        );
        this.onStateMessage<GroupMemberRemoveAppInboxPayload>(
            AppInboxType.GROUP_MEMBER_REMOVE,
            async (member, context) => await callGroupMutation(
                context,
                this.groupStateService.removeGroupMember,
                [member.scope, member.groupId, member.principalId, member.request],
            ),
        );
        this.onStateMessage<GroupMemberBanAppInboxPayload>(
            AppInboxType.GROUP_MEMBER_BAN,
            async (member, context) => await callGroupMutation(
                context,
                this.groupStateService.banGroupMember,
                [member.scope, member.groupId, member.principalId, member.request],
            ),
        );
        this.onStateMessage<GroupMemberUnbanAppInboxPayload>(
            AppInboxType.GROUP_MEMBER_UNBAN,
            async (member, context) => await callGroupMutation(
                context,
                this.groupStateService.unbanGroupMember,
                [member.scope, member.groupId, member.principalId, member.request],
            ),
        );
        this.onStateMessage<GroupMemberRoleSetAppInboxPayload>(
            AppInboxType.GROUP_MEMBER_ROLE_SET,
            async (member, context) => await callGroupMutation(
                context,
                this.groupStateService.setGroupMemberRole,
                [member.scope, member.groupId, member.principalId, member.request],
            ),
        );
        this.onStateMessage<GroupOwnershipTransferAppInboxPayload>(
            AppInboxType.GROUP_OWNERSHIP_TRANSFER,
            async (transfer, context) => await callGroupMutation(
                context,
                this.groupStateService.transferGroupOwnership,
                [transfer.scope, transfer.groupId, transfer.request],
            ),
        );
        this.onStateMessage<GroupMemberUpsertAppInboxPayload>(
            AppInboxType.GROUP_MEMBER_UPSERT,
            async (member, context) => await callGroupMutation(
                context,
                this.groupStateService.upsertMember,
                [member.scope, member.groupId, member.principalId, member.request],
            ),
        );
        this.onStateMessage<GroupPresenceConnectAppInboxPayload>(
            AppInboxType.GROUP_PRESENCE_CONNECT,
            async (presence, context) => await callGroupMutation(
                context,
                this.groupStateService.connectPresenceSessionReceipt,
                [presence.scope, presence.groupId, presence.sessionId, presence.request],
            ),
        );
        this.onStateMessage<GroupPresenceHeartbeatAppInboxPayload>(
            AppInboxType.GROUP_PRESENCE_HEARTBEAT,
            async (presence, context) => await callGroupMutation(
                context,
                this.groupStateService.heartbeatPresenceSessionReceipt,
                [presence.scope, presence.groupId, presence.sessionId, presence.request],
            ),
        );
        this.onStateMessage<GroupPresenceDisconnectAppInboxPayload>(
            AppInboxType.GROUP_PRESENCE_DISCONNECT,
            async (presence, context) => await callGroupMutation(
                context,
                this.groupStateService.disconnectPresenceSessionReceipt,
                [presence.scope, presence.groupId, presence.sessionId, presence.request],
            ),
        );
        this.onStateMessage<GroupPresenceDisconnectBySessionIdAppInboxPayload>(
            AppInboxType.GROUP_PRESENCE_DISCONNECT_BY_SESSION_ID,
            async (presence) => {
                const groupStateWrittenResults =
                    await this.groupStateService.disconnectPresenceSessionsBySessionIdWritten(
                        presence.sessionId,
                        presence.request,
                    );

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

                return groupStateWrittenResults;
            },
        );
    }

    public async processPresenceDisconnectsBySessionId(
        sessionId: string,
        request?: DisconnectPresenceBySessionRequest,
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

async function callGroupMutation<T>(
    context: AppInboxMessageContext,
    method: unknown,
    args: readonly unknown[],
): Promise<T> {
    if (typeof method !== 'function') {
        throw new TypeError('Group mutation handler is unavailable');
    }
    const authority = readGroupMutationAuthorityProof(context.enqueue.authority);
    return await Reflect.apply(
        method,
        undefined,
        authority ? [...args, authority] : args,
    ) as T;
}

function readGroupMutationAuthorityProof(
    value: unknown,
): GroupMutationAuthorityProof | undefined {
    if (value === undefined) return undefined;
    if (
        !value ||
        typeof value !== 'object' ||
        !('version' in value) ||
        value.version !== 1 ||
        !('principalId' in value) ||
        typeof value.principalId !== 'string' ||
        !('sessionId' in value) ||
        typeof value.sessionId !== 'string' ||
        !('sessionIssuedAtEpochMs' in value) ||
        !Number.isSafeInteger(value.sessionIssuedAtEpochMs) ||
        !('sessionExpiresAtEpochMs' in value) ||
        !Number.isSafeInteger(value.sessionExpiresAtEpochMs) ||
        !('commandMac' in value) ||
        typeof value.commandMac !== 'string'
    ) {
        throw new GroupMutationAuthorizationError(
            'App inbox mutation authority proof is malformed.',
        );
    }
    return value as GroupMutationAuthorityProof;
}

function isInternalGroupInboxType(type: AppInboxType): boolean {
    return type === AppInboxType.GROUP_PRESENCE_DISCONNECT_BY_SESSION_ID ||
        type === AppInboxType.GROUP_EXPIRED_PRESENCE_SESSIONS;
}

function toGroupMutationDescriptor<V>(
    enqueue: AppInboxEnqueueInput<V>,
): GroupMutationDescriptor {
    switch (enqueue.type) {
        case AppInboxType.GROUP_CREATE: {
            const payload = enqueue.data as GroupCreateAppInboxPayload;
            return descriptor(
                'createGroup', payload.scope, payload.request.groupId, payload.request,
            );
        }
        case AppInboxType.GROUP_UPDATE: {
            const payload = enqueue.data as GroupUpdateAppInboxPayload;
            return descriptor('updateGroup', payload.scope, payload.groupId, payload.request);
        }
        case AppInboxType.GROUP_DIRECTOR_APPOINT: {
            const payload = enqueue.data as GroupDirectorAppointAppInboxPayload;
            return descriptor(
                'appointDirector', payload.scope, payload.groupId, payload.request,
            );
        }
        case AppInboxType.GROUP_JOIN: {
            const payload = enqueue.data as GroupJoinAppInboxPayload;
            return descriptor('joinGroup', payload.scope, payload.groupId, payload.request);
        }
        case AppInboxType.GROUP_INVITE_CREATE: {
            const payload = enqueue.data as GroupInviteCreateAppInboxPayload;
            return descriptor(
                'createGroupInvite', payload.scope, payload.groupId, payload.request,
                payload.principalId,
            );
        }
        case AppInboxType.GROUP_INVITE_REVOKE: {
            const payload = enqueue.data as GroupInviteRevokeAppInboxPayload;
            return descriptor(
                'revokeGroupInvite', payload.scope, payload.groupId, payload.request,
                payload.principalId,
            );
        }
        case AppInboxType.GROUP_INVITE_ACCEPT: {
            const payload = enqueue.data as GroupInviteAcceptAppInboxPayload;
            return descriptor(
                'acceptGroupInvite', payload.scope, payload.groupId, payload.request,
            );
        }
        case AppInboxType.GROUP_JOIN_CODE_ROTATE: {
            const payload = enqueue.data as GroupJoinCodeRotateAppInboxPayload;
            return descriptor(
                'rotateGroupJoinCode', payload.scope, payload.groupId, payload.request,
            );
        }
        case AppInboxType.GROUP_MEMBER_REMOVE:
        case AppInboxType.GROUP_MEMBER_BAN:
        case AppInboxType.GROUP_MEMBER_UNBAN: {
            const payload = enqueue.data as GroupMemberRemoveAppInboxPayload;
            const operation = enqueue.type === AppInboxType.GROUP_MEMBER_REMOVE
                ? 'removeGroupMember'
                : enqueue.type === AppInboxType.GROUP_MEMBER_BAN
                ? 'banGroupMember'
                : 'unbanGroupMember';
            return descriptor(
                operation, payload.scope, payload.groupId, payload.request,
                payload.principalId,
            );
        }
        case AppInboxType.GROUP_MEMBER_ROLE_SET: {
            const payload = enqueue.data as GroupMemberRoleSetAppInboxPayload;
            return descriptor(
                'setGroupMemberRole', payload.scope, payload.groupId, payload.request,
                payload.principalId,
            );
        }
        case AppInboxType.GROUP_OWNERSHIP_TRANSFER: {
            const payload = enqueue.data as GroupOwnershipTransferAppInboxPayload;
            return descriptor(
                'transferGroupOwnership', payload.scope, payload.groupId, payload.request,
                payload.request.newOwnerPrincipalId,
            );
        }
        case AppInboxType.GROUP_MEMBER_UPSERT: {
            const payload = enqueue.data as GroupMemberUpsertAppInboxPayload;
            return descriptor(
                'upsertMember', payload.scope, payload.groupId, payload.request,
                payload.principalId,
            );
        }
        case AppInboxType.GROUP_PRESENCE_CONNECT: {
            const payload = enqueue.data as GroupPresenceConnectAppInboxPayload;
            return descriptor(
                'connectPresence', payload.scope, payload.groupId, payload.request,
                payload.request.principalId, payload.sessionId,
            );
        }
        case AppInboxType.GROUP_PRESENCE_HEARTBEAT: {
            const payload = enqueue.data as GroupPresenceHeartbeatAppInboxPayload;
            return descriptor(
                'heartbeatPresence', payload.scope, payload.groupId, payload.request,
                payload.request.principalId ?? null, payload.sessionId,
            );
        }
        case AppInboxType.GROUP_PRESENCE_DISCONNECT: {
            const payload = enqueue.data as GroupPresenceDisconnectAppInboxPayload;
            return descriptor(
                'disconnectPresence', payload.scope, payload.groupId, payload.request,
                payload.request.principalId ?? null, payload.sessionId,
            );
        }
        default:
            throw new GroupMutationAuthorizationError(
                'App inbox type is not an authenticated group mutation.',
            );
    }
}

function descriptor(
    operation: GroupMutationDescriptor['operation'],
    scope: StateScope,
    groupId: string,
    request: GroupMutationDescriptor['request'],
    targetPrincipalId: string | null = null,
    sessionId: string | null = null,
): GroupMutationDescriptor {
    return { operation, scope, groupId, targetPrincipalId, sessionId, request };
}
