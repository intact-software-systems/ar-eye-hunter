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
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    ResourceInboxResultsRepository
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type {
    GroupMutationDescriptor,
    GroupMutationPreparation,
    GroupStateMutationCommand,
    GroupStateService,
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
import type { RallarTimingSink } from './timing.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { IssuedAuthSession } from '../repositories/AuthSessionRepository.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
    createTransactionBoundGroupStateRepository,
    type GroupStateRepository,
} from '../repositories/GroupStateRepository.ts';
import type {
    GroupMutationComputed,
    GroupMutationReceipt,
} from './group-state-mutations.ts';

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

export class AppGroupInboxService extends AppInboxService {
    public async processExpiredPresenceSessionsNoWaiting(
        atEpochMs: number,
    ): Promise<number> {
        const preparations = await this.groupStateService
            .prepareExpiredPresenceMutations(atEpochMs);
        for (const preparation of preparations) {
            this.enqueueInternalMutation(
                AppInboxType.GROUP_PRESENCE_EXPIRE,
                preparation,
            );
        }
        return preparations.length;
    }

    public async processDisconnectedPresenceSessionsNoWaiting(
        sessionId: string,
        disconnectedAtEpochMs: number,
    ): Promise<number> {
        const preparations = await this.groupStateService
            .prepareSessionCleanupMutations(sessionId, disconnectedAtEpochMs);
        for (const preparation of preparations) {
            this.enqueueInternalMutation(
                AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
                preparation,
            );
        }
        return preparations.length;
    }

    public override processEntryNoWaiting<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
    ): void {
        void enqueue;
        throw new GroupMutationAuthorizationError(
            'Authenticated group mutation authority is required.',
        );
    }

    public override processEntryNoWaitingIf<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: ResourceEntry) => boolean,
    ): void {
        void enqueue;
        void enqueueIf;
        throw new GroupMutationAuthorizationError(
            'Authenticated group mutation authority is required.',
        );
    }

    public override async processEntryUntilCompletion<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
    ): Promise<Either<string, R>> {
        void enqueue;
        throw new GroupMutationAuthorizationError(
            'Authenticated group mutation authority is required.',
        );
    }

    public override async processEntryUntilCompletionIf<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: ResourceEntry) => boolean,
    ): Promise<Either<string, R>> {
        void enqueue;
        void enqueueIf;
        throw new GroupMutationAuthorizationError(
            'Authenticated group mutation authority is required.',
        );
    }

    public async processAuthenticatedEntryUntilCompletion<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        authority: IssuedAuthSession,
    ): Promise<Either<string, R>> {
        if (!isAuthenticatedGroupInboxType(enqueue.type)) {
            throw new GroupMutationAuthorizationError(
                'App inbox type is not an authenticated group mutation.',
            );
        }
        const preparation = await this.groupStateService.prepareMutation(
            toGroupMutationDescriptor(enqueue),
            authority,
        );
        return await super.processEntryUntilCompletion<V, R>({
            ...enqueue,
            resourceId: preparation.queueResourceId,
            authority: preparation,
        });
    }

    constructor(
        public override readonly inbox: InboxQueueReader,
        public override readonly resourceInbox: ResourceInboxRepository,
        public override readonly resourceInboxResults: ResourceInboxResultsRepository,
        database: PSqlSql,
        public readonly groupStateService: GroupStateService,
        public override readonly serviceId: string,
        timing?: RallarTimingSink,
        options?: AppInboxServiceOptions,
        private readonly wakeQueue?: () => void,
    ) {
        super(
            inbox,
            resourceInbox,
            resourceInboxResults,
            database,
            serviceId,
            SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
            timing,
            options,
        );

        const processMutation = async (_payload: unknown, context: AppInboxMessageContext) =>
            await this.processMutation(context);
        for (const type of GROUP_MUTATION_INBOX_TYPES) {
            this.onStateMessage(type, processMutation);
        }
    }

    private enqueueInternalMutation(
        type: AppInboxType.GROUP_PRESENCE_EXPIRE |
            AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
        preparation: GroupMutationPreparation,
    ): void {
        super.processEntryNoWaiting({
            type,
            resourceId: preparation.queueResourceId,
            authority: preparation,
            data: { commandId: preparation.command.commandId },
        });
    }

    private async processMutation(
        context: AppInboxMessageContext,
    ): Promise<unknown> {
        const prepared = readGroupMutationPreparation(context.enqueue.authority);
        const command: GroupStateMutationCommand = {
            authorityProof: prepared.authorityProof,
            descriptor: prepared.descriptor,
            command: prepared.command,
            facts: {
                ...prepared.facts,
                attemptCount: context.entry.dequeueAudit.attempts,
            },
        };
        const read = await this.groupStateService.read(command);
        const computed = this.groupStateService.compute(command, read);
        this.groupStateService.validate(command, read, computed);
        return await this.commitMutation(context, command, computed);
    }

    private async commitMutation(
        context: AppInboxMessageContext,
        command: GroupStateMutationCommand,
        computed: GroupMutationComputed,
    ): Promise<unknown> {
        const result = await this.writeMutation(context, async (transaction) => {
            if (computed.outcome === 'idempotency-conflict') {
                throw new TypeError('Validated group idempotency conflict is unreachable');
            }
            const receipt = computed.receipt;
            if (computed.outcome === 'write') {
                await this.groupStateService.write(transaction, computed);
            }
            if (isPresenceOperation(command.command.operation)) {
                return receipt;
            }
            const repository = createTransactionBoundGroupStateRepository(transaction);
            const snapshot = await repository.readSnapshot(command.command.aggregateRef);
            if (!snapshot) {
                throw new TypeError(
                    `Group snapshot not found after ${command.command.operation}`,
                );
            }
            const event = await readReceiptEvent(
                repository,
                command.command.aggregateRef,
                receipt,
            );
            if (command.command.operation === 'rotateGroupJoinCode') {
                if (receipt.outcome === 'rejected') {
                    return {
                        status: 'error',
                        result: Either.ofLeft(
                            receipt.rejection ?? 'Join-code rotation rejected',
                        ),
                    };
                }
                if (receipt.joinCode === null || receipt.joinCodeExpiresAtEpochMs === null) {
                    throw new TypeError('Join-code mutation result is incomplete');
                }
                return {
                    status: 'ok',
                    result: Either.ofRight({
                        joinCode: receipt.joinCode,
                        expiresAtEpochMs: receipt.joinCodeExpiresAtEpochMs,
                        snapshot,
                        event,
                    }),
                };
            }
            if (receipt.outcome === 'rejected') {
                return {
                    status: 'error',
                    result: Either.ofLeft(
                        receipt.rejection ?? 'Group mutation rejected',
                    ),
                };
            }
            return {
                status: command.command.operation === 'createGroup' ? 'created' : 'ok',
                result: Either.ofRight({ snapshot, event }),
            };
        });
        this.wakeQueue?.();
        return result;
    }
}

function isPresenceOperation(
    operation: GroupStateMutationCommand['command']['operation'],
): boolean {
    return operation === 'connectPresence' ||
        operation === 'heartbeatPresence' ||
        operation === 'disconnectPresence';
}

async function readReceiptEvent(
    repository: GroupStateRepository,
    ref: GroupRef,
    receipt: GroupMutationReceipt,
): Promise<GroupEvent | null> {
    if (receipt.eventId === null) return null;
    const event = (await repository.listEvents(ref))
        .find((candidate) => candidate.eventId === receipt.eventId);
    if (!event) {
        throw new TypeError(`Group mutation event not found: ${receipt.eventId}`);
    }
    return event;
}

function readGroupMutationPreparation(
    value: unknown,
): GroupMutationPreparation {
    const expectedKeys = [
        'authorityProof',
        'descriptor',
        'command',
        'facts',
        'causalToken',
        'queueResourceId',
    ].toSorted();
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(expectedKeys) ||
        !('authorityProof' in value) ||
        !isAuthorityProofOrNull(value.authorityProof) ||
        !('descriptor' in value) ||
        !isRecordOrNull(value.descriptor) ||
        !('command' in value) ||
        !value.command ||
        typeof value.command !== 'object' ||
        !('facts' in value) ||
        !value.facts ||
        typeof value.facts !== 'object' ||
        !('causalToken' in value) ||
        typeof value.causalToken !== 'string' ||
        !('queueResourceId' in value) ||
        typeof value.queueResourceId !== 'string'
    ) {
        throw new GroupMutationAuthorizationError(
            'App inbox durable group mutation facts are malformed.',
        );
    }
    return value as GroupMutationPreparation;
}

const AUTHENTICATED_GROUP_INBOX_TYPES = [
    AppInboxType.GROUP_CREATE,
    AppInboxType.GROUP_UPDATE,
    AppInboxType.GROUP_DIRECTOR_APPOINT,
    AppInboxType.GROUP_JOIN,
    AppInboxType.GROUP_INVITE_CREATE,
    AppInboxType.GROUP_INVITE_REVOKE,
    AppInboxType.GROUP_INVITE_ACCEPT,
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
] as const;

const GROUP_MUTATION_INBOX_TYPES = [
    ...AUTHENTICATED_GROUP_INBOX_TYPES,
    AppInboxType.GROUP_PRESENCE_EXPIRE,
    AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
] as const;

function isAuthorityProofOrNull(value: unknown): boolean {
    return value === null || (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        value !== null &&
        'version' in value &&
        value.version === 1
    );
}

function isRecordOrNull(value: unknown): boolean {
    return value === null || (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        value !== null
    );
}

function isAuthenticatedGroupInboxType(type: AppInboxType): boolean {
    return (AUTHENTICATED_GROUP_INBOX_TYPES as readonly AppInboxType[]).includes(type);
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
