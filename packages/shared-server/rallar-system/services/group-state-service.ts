import type {
    AuditStamp,
    Group,
    GroupEvent,
    GroupMember,
    GroupPresenceSession,
    GroupRef,
    GroupScope,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import type {
    AcceptGroupInviteRequest,
    AppointGroupDirectorRequest,
    BanGroupMemberRequest,
    ConnectGroupPresenceSessionRequest,
    CreateGroupInviteRequest,
    CreateGroupRequest,
    DisconnectGroupPresenceSessionRequest,
    GroupJoinCodeResponse,
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
    UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { GroupPolicyDenied, GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import {
    createRallarGroupDirectorAppointment,
    mergeRallarGroupDirectorMetadata,
    normalizeRallarGroupDirectorHeartbeatTtlMs,
    readRallarGroupDirectorFromSnapshot,
    resolveRallarGroupDirectorAppointmentEligibility,
} from '@shared/api/group-director.ts';
import { GroupStateRepository } from '../repositories/GroupStateRepository.ts';
import { type GroupStateEventStore } from '../repositories/StateEventStore.ts';
import type { RuntimeStateTransactionalRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import type { StateSyncPublisher } from '../state-sync-publisher.ts';
import { Either } from '@shared/resilience/Either.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { type RallarTimingSink, timeRallarAsync } from './timing.ts';
import type { StateEventListQuery } from '../state-event-listing.ts';
import {
    canActivateGroupMember,
    canConnectGroupPresenceSession,
    canGovernGroupMember,
    canJoinGroup,
    canMutateActiveGroup,
    type GroupGovernanceAction,
    GroupPolicyDeniedError,
} from '../group-policy.ts';

const DEFAULT_GROUP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GROUP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_GROUP_JOIN_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RALLAR_GROUP_JOIN_CODE_METADATA_KEY = 'rallarJoinCode';
const RALLAR_GROUP_JOIN_CODE_VERSION = 1;
const GROUP_PRESENCE_SESSION_LOCK_NAMESPACE = 'group-state:presence-session-locks';

export type GroupWritten = {
    snapshot: GroupSnapshot;
    event: GroupEvent;
};

export type GroupMutationWritten = {
    snapshot: GroupSnapshot;
    event?: GroupEvent;
};

export type GroupStateWritten = {
    status: 'created' | 'ok' | 'error';
    result: Either<string, GroupMutationWritten>;
};

export type GroupJoinCodeMutationWritten =
    & GroupJoinCodeResponse
    & Readonly<{
        event?: GroupEvent;
    }>;

export type GroupJoinCodeWritten = {
    status: 'ok' | 'error';
    result: Either<string, GroupJoinCodeMutationWritten>;
};

export type GroupSnapshotPageOptions = Readonly<{
    afterKey?: string;
    limit: number;
}>;

export type GroupSnapshotPage = Readonly<{
    snapshots: readonly GroupSnapshot[];
    scannedGroupCount: number;
    hasMore: boolean;
    nextGroupKey?: string;
}>;

export type GroupStateService = Readonly<{
    listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]>;
    listSnapshotsPage(
        scope: GroupScope,
        options: GroupSnapshotPageOptions,
    ): Promise<GroupSnapshotPage>;
    readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
    readStateRevision(ref: GroupRef): Promise<number | undefined>;
    listEvents(ref: GroupRef): Promise<readonly GroupEvent[]>;
    listRecentEvents?(
        ref: GroupRef,
        query: StateEventListQuery,
    ): Promise<readonly GroupEvent[]>;
    listEventPage(
        ref: GroupRef,
        query: StateEventListQuery,
    ): Promise<StateEventPage<GroupEvent>>;
    createGroup(
        scope: StateScope,
        request: CreateGroupRequest,
    ): Promise<GroupStateWritten>;
    updateGroup(
        scope: StateScope,
        groupId: string,
        request: UpdateGroupRequest,
    ): Promise<GroupStateWritten>;
    appointDirector(
        scope: StateScope,
        groupId: string,
        request: AppointGroupDirectorRequest,
    ): Promise<GroupStateWritten>;
    joinGroup(
        scope: StateScope,
        groupId: string,
        request: JoinGroupRequest,
    ): Promise<GroupStateWritten>;
    createGroupInvite(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: CreateGroupInviteRequest,
    ): Promise<GroupStateWritten>;
    revokeGroupInvite(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: RevokeGroupInviteRequest,
    ): Promise<GroupStateWritten>;
    acceptGroupInvite(
        scope: StateScope,
        groupId: string,
        request: AcceptGroupInviteRequest,
    ): Promise<GroupStateWritten>;
    rotateGroupJoinCode(
        scope: StateScope,
        groupId: string,
        request: RotateGroupJoinCodeRequest,
    ): Promise<GroupJoinCodeWritten>;
    removeGroupMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: RemoveGroupMemberRequest,
    ): Promise<GroupStateWritten>;
    banGroupMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: BanGroupMemberRequest,
    ): Promise<GroupStateWritten>;
    unbanGroupMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: UnbanGroupMemberRequest,
    ): Promise<GroupStateWritten>;
    setGroupMemberRole(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: SetGroupMemberRoleRequest,
    ): Promise<GroupStateWritten>;
    transferGroupOwnership(
        scope: StateScope,
        groupId: string,
        request: TransferGroupOwnershipRequest,
    ): Promise<GroupStateWritten>;
    upsertMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: UpsertGroupMemberRequest,
    ): Promise<GroupStateWritten>;
    connectPresenceSession(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: ConnectGroupPresenceSessionRequest,
    ): Promise<GroupStateWritten>;
    heartbeatPresenceSession(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: HeartbeatGroupPresenceSessionRequest,
    ): Promise<GroupStateWritten>;
    disconnectPresenceSession(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: DisconnectGroupPresenceSessionRequest,
    ): Promise<GroupStateWritten>;
    disconnectPresenceSessionsBySessionId(
        sessionId: string,
        request?: DisconnectGroupPresenceSessionRequest,
    ): Promise<readonly GroupSnapshot[]>;
    disconnectPresenceSessionsBySessionIdWritten(
        sessionId: string,
        request?: DisconnectGroupPresenceSessionRequest,
    ): Promise<readonly GroupStateWritten[]>;
    expireExpiredPresenceSessions(
        atEpochMs?: number,
    ): Promise<readonly GroupStateWritten[]>;
}>;

export type GroupStateServiceDependencies = Readonly<{
    runtimeRepository: RuntimeStateTransactionalRepositoryLike;
    createGroupStateEventStore?: (
        runtimeRepository: RuntimeStateTransactionalRepositoryLike,
    ) => GroupStateEventStore;
    syncPublisher: StateSyncPublisher;
    now?: () => number;
    serviceId: string;
    timing?: RallarTimingSink;
}>;

export function createGroupStateService(
    dependencies: GroupStateServiceDependencies,
): GroupStateService {
    const runtimeRepository = dependencies.runtimeRepository;
    const repositoryFor = (
        repository: RuntimeStateTransactionalRepositoryLike,
    ): GroupStateRepository =>
        new GroupStateRepository(repository, {
            events: dependencies.createGroupStateEventStore?.(repository),
        });
    const now = dependencies.now ?? (() => Date.now());
    const serviceId = dependencies.serviceId;

    const service: GroupStateService = {
        listSnapshots: async (scope) => {
            return await repositoryFor(runtimeRepository).listSnapshots(scope);
        },
        listSnapshotsPage: async (scope, options) => {
            return await repositoryFor(runtimeRepository).listSnapshotsPage(
                scope,
                options,
            );
        },
        readSnapshot: async (ref) => {
            return await repositoryFor(runtimeRepository).readSnapshot(
                ref,
            );
        },
        readStateRevision: async (ref) => {
            return await repositoryFor(runtimeRepository).readStateRevision(ref);
        },
        listEvents: async (ref) => {
            return await repositoryFor(runtimeRepository).listEvents(ref);
        },
        listRecentEvents: async (ref, query) => {
            return await repositoryFor(runtimeRepository).listRecentEvents(
                ref,
                query,
            );
        },
        listEventPage: async (ref, query) => {
            return await repositoryFor(runtimeRepository).listEventPage(
                ref,
                query,
            );
        },

        createGroup: async (scope, request): Promise<GroupStateWritten> => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = repositoryFor(transactionRepository);

                const ref: GroupRef = {
                    ...scope,
                    groupId: request.groupId,
                };
                const idempotencyKey = request.requestId ?? request.groupId;

                const existing = await repository.findGroup(ref);

                if (existing) {
                    const written = await repository.findIdempotentGroupStateWritten(
                        ref,
                        idempotencyKey,
                    );

                    if (written) {
                        return written;
                    }

                    return await repository.addIdempotentGroupStateWritten(
                        ref,
                        idempotencyKey,
                        {
                            status: 'error',
                            result: Either.ofLeft(`Group already exists: ${request.groupId}`),
                        },
                    );
                }

                const timestamp = now();
                const created = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.createdByPrincipalId,
                );

                const group: Group = {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId: request.groupId,
                    slug: request.slug,
                    displayName: request.displayName,
                    description: request.description,
                    kind: request.kind,
                    status: 'active',
                    joinMode: request.joinMode ?? 'invite-only',
                    maxMembers: request.maxMembers,
                    maxSessionsPerMember: request.maxSessionsPerMember,
                    metadata: request.metadata ?? {},
                    snapshotVersion: 1,
                    metadataVersion: 1,
                    rosterVersion: 1,
                    presenceVersion: 0,
                    created,
                    updated: created,
                    expiresAtEpochMs: request.expiresAtEpochMs,
                    purgeAfterEpochMs: request.purgeAfterEpochMs,
                };

                const ownerMember: GroupMember = {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId: request.groupId,
                    principalId: request.createdByPrincipalId,
                    role: 'owner',
                    status: 'active',
                    joined: created,
                    updated: created,
                };
                await repository.putGroup(group);
                await repository.putMember(ownerMember);
                const snapshot = await requireGroupSnapshot(repository, ref);

                const event = newGroupEvent(
                    'group-created',
                    group,
                    {
                        ...request,
                        actorPrincipalId: request.actorPrincipalId ?? request.createdByPrincipalId,
                    },
                    timestamp,
                    serviceId,
                );

                await repository.appendEvent(event);

                return await repository.addIdempotentGroupStateWritten(
                    ref,
                    idempotencyKey,
                    {
                        status: 'created',
                        result: Either.ofRight({
                            snapshot,
                            event,
                        }),
                    },
                );
            });
        },
        updateGroup: async (scope, groupId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = repositoryFor(transactionRepository);
                const ref: GroupRef = {
                    ...scope,
                    groupId,
                };
                const idempotentWritten = await findIdempotentGroupMutationWritten(
                    repository,
                    ref,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const existing = await repository.findGroup(ref);
                if (!existing) {
                    throw new NonRetryableException(`Group not found: ${groupId}`);
                }
                const timestamp = now();
                if (shouldRequireActiveGroupForUpdate(existing, request, timestamp)) {
                    assertGroupPolicyAllowed(canMutateActiveGroup({
                        group: existing,
                        nowEpochMs: timestamp,
                    }));
                }

                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.actorPrincipalId,
                );
                const status = request.status ?? existing.status;
                const group: Group = {
                    ...existing,
                    slug: request.slug ?? existing.slug,
                    displayName: request.displayName ?? existing.displayName,
                    description: request.description ?? existing.description,
                    kind: request.kind ?? existing.kind,
                    status,
                    joinMode: request.joinMode ?? existing.joinMode,
                    maxMembers: request.maxMembers ?? existing.maxMembers,
                    maxSessionsPerMember: request.maxSessionsPerMember ?? existing.maxSessionsPerMember,
                    metadata: request.metadata ?? existing.metadata,
                    snapshotVersion: nextGroupSnapshotVersion(existing),
                    metadataVersion: existing.metadataVersion + 1,
                    updated: updatedAudit,
                    archived: status === 'archived' ? updatedAudit : existing.archived,
                    deleted: status === 'deleted' ? updatedAudit : existing.deleted,
                    expiresAtEpochMs: request.expiresAtEpochMs ?? existing.expiresAtEpochMs,
                    emptySinceEpochMs: request.emptySinceEpochMs ?? existing.emptySinceEpochMs,
                    purgeAfterEpochMs: request.purgeAfterEpochMs ?? existing.purgeAfterEpochMs,
                };

                if (isSameGroupMutation(existing, group)) {
                    return await addIdempotentGroupMutationWritten(
                        repository,
                        ref,
                        request.requestId,
                        {
                            snapshot: await requireGroupSnapshot(repository, ref),
                            event: undefined,
                        },
                    );
                }

                await repository.putGroup(group);

                const event = newGroupEvent(
                    status === 'archived'
                        ? 'group-archived'
                        : status === 'deleted'
                        ? 'group-deleted'
                        : 'group-updated',
                    group,
                    request,
                    timestamp,
                    serviceId,
                );
                await repository.appendEvent(event);

                return await addIdempotentGroupMutationWritten(
                    repository,
                    ref,
                    request.requestId,
                    {
                        snapshot: await requireGroupSnapshot(repository, ref),
                        event,
                    },
                );
            });
        },
        appointDirector: async (scope, groupId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = repositoryFor(transactionRepository);
                const ref: GroupRef = {
                    ...scope,
                    groupId,
                };
                const actorPrincipalId = request.actorPrincipalId;
                const actorSessionId = request.actorSessionId;
                if (!actorPrincipalId || !actorSessionId) {
                    throw new NonRetryableException(
                        'Forbidden: Cannot appoint a director without a local session.',
                    );
                }
                const heartbeatTtlMs = toDirectorHeartbeatTtlMs(request);

                const idempotentWritten = await findIdempotentGroupMutationWritten(
                    repository,
                    ref,
                    request.requestId,
                );
                if (idempotentWritten) {
                    assertIdempotentDirectorAppointmentMatchesActor(
                        idempotentWritten,
                        actorPrincipalId,
                        actorSessionId,
                    );
                    return idempotentWritten;
                }

                const snapshot = await requireGroupSnapshot(repository, ref);
                const timestamp = now();
                assertGroupPolicyAllowed(canMutateActiveGroup({
                    group: snapshot.group,
                    nowEpochMs: timestamp,
                }));
                const eligibility = resolveRallarGroupDirectorAppointmentEligibility({
                    snapshot,
                    principalId: actorPrincipalId,
                    sessionId: actorSessionId,
                });
                if (!eligibility.allowed) {
                    throw new NonRetryableException(
                        `Forbidden: ${
                            eligibility.reason ??
                                'Cannot appoint the browser director.'
                        }`,
                    );
                }

                const previous = readRallarGroupDirectorFromSnapshot(snapshot);
                const appointment = createRallarGroupDirectorAppointment({
                    session: {
                        clientId: actorPrincipalId,
                        sessionId: actorSessionId,
                    },
                    previous,
                    now: timestamp,
                    heartbeatTtlMs,
                });
                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    actorPrincipalId,
                );
                const group: Group = {
                    ...snapshot.group,
                    metadata: mergeRallarGroupDirectorMetadata(
                        snapshot.group.metadata,
                        appointment,
                    ),
                    snapshotVersion: nextGroupSnapshotVersion(snapshot.group),
                    metadataVersion: snapshot.group.metadataVersion + 1,
                    updated: updatedAudit,
                };

                await repository.putGroup(group);

                const event = newGroupEvent(
                    'group-updated',
                    group,
                    request,
                    timestamp,
                    serviceId,
                );
                await repository.appendEvent(event);

                return await addIdempotentGroupMutationWritten(
                    repository,
                    ref,
                    request.requestId,
                    {
                        snapshot: await requireGroupSnapshot(repository, group),
                        event,
                    },
                );
            });
        },
        joinGroup: async (scope, groupId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = repositoryFor(transactionRepository);
                const groupRef = {
                    ...scope,
                    groupId,
                };
                const idempotentWritten = await findIdempotentGroupMutationWritten(
                    repository,
                    groupRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const snapshot = await requireGroupSnapshot(repository, groupRef);
                const timestamp = now();
                const storedJoinCode = readRallarGroupJoinCode(snapshot.group.metadata);
                const joinCodeVerifier = request.joinCode
                    ? await toGroupJoinCodeVerifier(request.joinCode)
                    : undefined;
                assertGroupPolicyAllowed(canJoinGroup({
                    snapshot,
                    actor: {
                        principalId: request.actorPrincipalId,
                        sessionId: request.actorSessionId,
                    },
                    nowEpochMs: timestamp,
                    inviteToken: request.inviteToken,
                    joinCode: request.joinCode,
                    joinCodeVerifier,
                    expectedJoinCodeVerifier: snapshot.group.joinMode === 'code'
                        ? storedJoinCode?.verifier ?? ''
                        : undefined,
                    joinCodeExpiresAtEpochMs: storedJoinCode?.expiresAtEpochMs,
                }));

                const principalId = request.actorPrincipalId;
                if (!principalId) {
                    throw new NonRetryableException(
                        'Forbidden: Cannot join a group without a principal.',
                    );
                }

                const ref = {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId,
                };
                const existing = await repository.findMember(ref);
                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    principalId,
                );
                const member: GroupMember = {
                    ...ref,
                    role: existing?.role ?? 'member',
                    status: 'active',
                    joined: existing?.joined ?? updatedAudit,
                    updated: updatedAudit,
                    left: existing?.left,
                    removed: existing?.removed,
                    banned: existing?.banned,
                    invitedByPrincipalId: existing?.invitedByPrincipalId,
                    invitationExpiresAtEpochMs: existing?.invitationExpiresAtEpochMs,
                };

                if (existing && isSameGroupMemberMutation(existing, member)) {
                    return await addIdempotentGroupMutationWritten(
                        repository,
                        snapshot.group,
                        request.requestId,
                        {
                            snapshot,
                            event: undefined,
                        },
                    );
                }

                await repository.putMember(member);
                const snapshotGroup = {
                    ...snapshot.group,
                    snapshotVersion: nextGroupSnapshotVersion(snapshot.group),
                    rosterVersion: snapshot.group.rosterVersion + 1,
                    updated: updatedAudit,
                };
                await repository.putGroup(snapshotGroup);

                const event = newGroupEvent(
                    'member-joined',
                    snapshotGroup,
                    request,
                    timestamp,
                    serviceId,
                );
                await repository.appendEvent(event);

                return await addIdempotentGroupMutationWritten(
                    repository,
                    snapshotGroup,
                    request.requestId,
                    {
                        snapshot: await requireGroupSnapshot(repository, snapshotGroup),
                        event,
                    },
                );
            });
        },
        createGroupInvite: async (scope, groupId, principalId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = repositoryFor(transactionRepository);
                const groupRef = {
                    ...scope,
                    groupId,
                };
                const idempotentWritten = await findIdempotentGroupMutationWritten(
                    repository,
                    groupRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const snapshot = await requireGroupSnapshot(repository, groupRef);
                const timestamp = now();
                assertGroupPolicyAllowed(canMutateActiveGroup({
                    group: snapshot.group,
                    nowEpochMs: timestamp,
                }));
                assertGroupPolicyAllowed(canGovernGroupMember({
                    snapshot,
                    actor: {
                        principalId: request.actorPrincipalId,
                        sessionId: request.actorSessionId,
                    },
                    targetPrincipalId: principalId,
                    action: 'invite',
                }));

                const existing = snapshot.members.find((member) => member.principalId === principalId);
                assertCanInviteMember(existing);
                if (existing?.status === 'active') {
                    return await addIdempotentGroupMutationWritten(
                        repository,
                        snapshot.group,
                        request.requestId,
                        {
                            snapshot,
                            event: undefined,
                        },
                    );
                }

                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.actorPrincipalId,
                );
                const ref = {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId,
                };
                const member: GroupMember = {
                    ...ref,
                    role: existing?.role ?? 'member',
                    status: 'invited',
                    joined: existing?.joined ?? updatedAudit,
                    updated: updatedAudit,
                    left: existing?.left,
                    removed: existing?.removed,
                    banned: existing?.banned,
                    invitedByPrincipalId: request.actorPrincipalId,
                    invitationExpiresAtEpochMs: request.invitationExpiresAtEpochMs ??
                        timestamp + DEFAULT_GROUP_INVITE_TTL_MS,
                };

                if (existing && isSameGroupMemberMutation(existing, member)) {
                    return await addIdempotentGroupMutationWritten(
                        repository,
                        snapshot.group,
                        request.requestId,
                        {
                            snapshot,
                            event: undefined,
                        },
                    );
                }

                await repository.putMember(member);
                const snapshotGroup = {
                    ...snapshot.group,
                    snapshotVersion: nextGroupSnapshotVersion(snapshot.group),
                    rosterVersion: snapshot.group.rosterVersion + 1,
                    updated: updatedAudit,
                };
                await repository.putGroup(snapshotGroup);

                const event = newGroupEvent(
                    'member-invited',
                    snapshotGroup,
                    request,
                    timestamp,
                    serviceId,
                );
                await repository.appendEvent(event);

                return await addIdempotentGroupMutationWritten(
                    repository,
                    snapshotGroup,
                    request.requestId,
                    {
                        snapshot: await requireGroupSnapshot(repository, snapshotGroup),
                        event,
                    },
                );
            });
        },
        revokeGroupInvite: async (scope, groupId, principalId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = repositoryFor(transactionRepository);
                const groupRef = {
                    ...scope,
                    groupId,
                };
                const idempotentWritten = await findIdempotentGroupMutationWritten(
                    repository,
                    groupRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const snapshot = await requireGroupSnapshot(repository, groupRef);
                const timestamp = now();
                assertGroupPolicyAllowed(canMutateActiveGroup({
                    group: snapshot.group,
                    nowEpochMs: timestamp,
                }));
                assertGroupPolicyAllowed(canGovernGroupMember({
                    snapshot,
                    actor: {
                        principalId: request.actorPrincipalId,
                        sessionId: request.actorSessionId,
                    },
                    targetPrincipalId: principalId,
                    action: 'remove',
                }));

                const existing = snapshot.members.find((member) => member.principalId === principalId);
                if (existing?.status !== 'invited') {
                    return await addIdempotentGroupMutationWritten(
                        repository,
                        snapshot.group,
                        request.requestId,
                        {
                            snapshot,
                            event: undefined,
                        },
                    );
                }

                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.actorPrincipalId,
                );
                const member: GroupMember = {
                    ...existing,
                    status: 'left',
                    updated: updatedAudit,
                    left: updatedAudit,
                };
                await repository.putMember(member);
                const snapshotGroup = {
                    ...snapshot.group,
                    snapshotVersion: nextGroupSnapshotVersion(snapshot.group),
                    rosterVersion: snapshot.group.rosterVersion + 1,
                    updated: updatedAudit,
                };
                await repository.putGroup(snapshotGroup);

                const event = newGroupEvent(
                    'member-left',
                    snapshotGroup,
                    request,
                    timestamp,
                    serviceId,
                );
                await repository.appendEvent(event);

                return await addIdempotentGroupMutationWritten(
                    repository,
                    snapshotGroup,
                    request.requestId,
                    {
                        snapshot: await requireGroupSnapshot(repository, snapshotGroup),
                        event,
                    },
                );
            });
        },
        acceptGroupInvite: async (scope, groupId, request) => {
            return await service.joinGroup(scope, groupId, request);
        },
        rotateGroupJoinCode: async (scope, groupId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = repositoryFor(transactionRepository);
                const groupRef = {
                    ...scope,
                    groupId,
                };
                const idempotentWritten = await findIdempotentGroupJoinCodeMutationWritten(
                    repository,
                    groupRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const snapshot = await requireGroupSnapshot(repository, groupRef);
                const timestamp = now();
                assertGroupPolicyAllowed(canMutateActiveGroup({
                    group: snapshot.group,
                    nowEpochMs: timestamp,
                }));
                assertGroupPolicyAllowed(canGovernGroupMember({
                    snapshot,
                    actor: {
                        principalId: request.actorPrincipalId,
                        sessionId: request.actorSessionId,
                    },
                    targetPrincipalId: `${snapshot.group.groupId}:join-code`,
                    action: 'invite',
                }));

                const joinCode = normalizeJoinCode(request.joinCode);
                const expiresAtEpochMs = request.expiresAtEpochMs ??
                    timestamp + DEFAULT_GROUP_JOIN_CODE_TTL_MS;
                const verifier = await toGroupJoinCodeVerifier(joinCode);
                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.actorPrincipalId,
                );
                const group: Group = {
                    ...snapshot.group,
                    metadata: mergeRallarGroupJoinCodeMetadata(
                        snapshot.group.metadata,
                        {
                            version: RALLAR_GROUP_JOIN_CODE_VERSION,
                            verifier,
                            expiresAtEpochMs,
                            rotatedAtEpochMs: timestamp,
                        },
                    ),
                    snapshotVersion: nextGroupSnapshotVersion(snapshot.group),
                    metadataVersion: snapshot.group.metadataVersion + 1,
                    updated: updatedAudit,
                };

                await repository.putGroup(group);

                const event = newGroupEvent(
                    'group-updated',
                    group,
                    request,
                    timestamp,
                    serviceId,
                );
                await repository.appendEvent(event);

                return await addIdempotentGroupJoinCodeMutationWritten(
                    repository,
                    group,
                    request.requestId,
                    {
                        joinCode,
                        expiresAtEpochMs,
                        snapshot: await requireGroupSnapshot(repository, group),
                        event,
                    },
                );
            });
        },
        removeGroupMember: async (scope, groupId, principalId, request) =>
            await writeGovernedGroupMemberMutation({
                runtimeRepository,
                repositoryFor,
                scope,
                groupId,
                principalId,
                request,
                now,
                serviceId,
                action: 'remove',
                status: 'removed',
                eventType: 'member-removed',
                missingMemberBehavior: 'create',
            }),
        banGroupMember: async (scope, groupId, principalId, request) =>
            await writeGovernedGroupMemberMutation({
                runtimeRepository,
                repositoryFor,
                scope,
                groupId,
                principalId,
                request,
                now,
                serviceId,
                action: 'ban',
                status: 'banned',
                eventType: 'member-banned',
                missingMemberBehavior: 'create',
            }),
        unbanGroupMember: async (scope, groupId, principalId, request) =>
            await writeGovernedGroupMemberMutation({
                runtimeRepository,
                repositoryFor,
                scope,
                groupId,
                principalId,
                request,
                now,
                serviceId,
                action: 'unban',
                status: 'left',
                eventType: 'member-unbanned',
                requiredExistingStatus: 'banned',
                missingMemberBehavior: 'noop',
            }),
        setGroupMemberRole: async (scope, groupId, principalId, request) =>
            await writeGovernedGroupMemberMutation({
                runtimeRepository,
                repositoryFor,
                scope,
                groupId,
                principalId,
                request,
                now,
                serviceId,
                action: 'promote',
                role: request.role,
                eventType: 'member-role-changed',
                missingMemberBehavior: 'error',
            }),
        transferGroupOwnership: async (scope, groupId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = repositoryFor(transactionRepository);
                const groupRef = {
                    ...scope,
                    groupId,
                };
                const idempotentWritten = await findIdempotentGroupMutationWritten(
                    repository,
                    groupRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const snapshot = await requireGroupSnapshot(repository, groupRef);
                const timestamp = now();
                assertGroupPolicyAllowed(canMutateActiveGroup({
                    group: snapshot.group,
                    nowEpochMs: timestamp,
                }));
                assertGroupPolicyAllowed(canGovernGroupMember({
                    snapshot,
                    actor: {
                        principalId: request.actorPrincipalId,
                        sessionId: request.actorSessionId,
                    },
                    targetPrincipalId: request.newOwnerPrincipalId,
                    action: 'transfer-ownership',
                }));

                const actorMember = request.actorPrincipalId
                    ? snapshot.members.find((member) => member.principalId === request.actorPrincipalId)
                    : undefined;
                const newOwner = snapshot.members.find((member) =>
                    member.principalId === request.newOwnerPrincipalId
                );
                if (!actorMember || actorMember.status !== 'active') {
                    throwGroupPolicyDenied(
                        'forbidden-role',
                        'Only active group owners can transfer group ownership.',
                    );
                }
                if (!newOwner || newOwner.status !== 'active') {
                    throwGroupPolicyDenied(
                        'member-not-active',
                        'Ownership can only be transferred to an active group member.',
                    );
                }
                if (actorMember.principalId === newOwner.principalId) {
                    return await addIdempotentGroupMutationWritten(
                        repository,
                        snapshot.group,
                        request.requestId,
                        {
                            snapshot,
                            event: undefined,
                        },
                    );
                }

                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.actorPrincipalId,
                );
                const updatedActor: GroupMember = {
                    ...actorMember,
                    role: 'admin',
                    updated: updatedAudit,
                };
                const updatedNewOwner: GroupMember = {
                    ...newOwner,
                    role: 'owner',
                    updated: updatedAudit,
                };
                await repository.putMember(updatedActor);
                await repository.putMember(updatedNewOwner);

                const snapshotGroup = {
                    ...snapshot.group,
                    snapshotVersion: nextGroupSnapshotVersion(snapshot.group),
                    rosterVersion: snapshot.group.rosterVersion + 1,
                    updated: updatedAudit,
                };
                await repository.putGroup(snapshotGroup);

                const event = newGroupEvent(
                    'ownership-transferred',
                    snapshotGroup,
                    request,
                    timestamp,
                    serviceId,
                );
                await repository.appendEvent(event);

                return await addIdempotentGroupMutationWritten(
                    repository,
                    snapshotGroup,
                    request.requestId,
                    {
                        snapshot: await requireGroupSnapshot(repository, snapshotGroup),
                        event,
                    },
                );
            });
        },
        upsertMember: async (scope, groupId, principalId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = repositoryFor(transactionRepository);
                const groupRef = {
                    ...scope,
                    groupId,
                };
                const idempotentWritten = await findIdempotentGroupMutationWritten(
                    repository,
                    groupRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const group = await requireGroup(repository, groupRef);
                const timestamp = now();
                assertGroupPolicyAllowed(canMutateActiveGroup({
                    group,
                    nowEpochMs: timestamp,
                }));
                const snapshot = await requireGroupSnapshot(repository, groupRef);
                if (request.status === 'active') {
                    assertGroupPolicyAllowed(
                        request.actorPrincipalId === principalId
                            ? canJoinGroup({
                                snapshot,
                                actor: {
                                    principalId: request.actorPrincipalId,
                                    sessionId: request.actorSessionId,
                                },
                                nowEpochMs: timestamp,
                            })
                            : canActivateGroupMember({
                                snapshot,
                                targetPrincipalId: principalId,
                                nowEpochMs: timestamp,
                            }),
                    );
                }
                const ref = {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId,
                };
                const existing = snapshot.members.find((member) => member.principalId === principalId);
                assertRawMemberMutationKeepsOwner(snapshot, existing, request);
                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.actorPrincipalId ?? principalId,
                );
                const status = request.status;
                const member: GroupMember = {
                    ...ref,
                    role: request.role ?? existing?.role ?? 'member',
                    status,
                    joined: existing?.joined ?? updatedAudit,
                    updated: updatedAudit,
                    left: status === 'left' ? updatedAudit : existing?.left,
                    removed: status === 'removed' ? updatedAudit : existing?.removed,
                    banned: status === 'banned' ? updatedAudit : existing?.banned,
                    invitedByPrincipalId: request.invitedByPrincipalId ?? existing?.invitedByPrincipalId,
                    invitationExpiresAtEpochMs: request.invitationExpiresAtEpochMs ??
                        existing?.invitationExpiresAtEpochMs,
                };

                if (existing && isSameGroupMemberMutation(existing, member)) {
                    return await addIdempotentGroupMutationWritten(
                        repository,
                        group,
                        request.requestId,
                        {
                            snapshot: await requireGroupSnapshot(repository, group),
                            event: undefined,
                        },
                    );
                }

                await repository.putMember(member);
                const snapshotGroup = {
                    ...group,
                    snapshotVersion: nextGroupSnapshotVersion(group),
                    rosterVersion: group.rosterVersion + 1,
                    updated: updatedAudit,
                };
                await repository.putGroup(snapshotGroup);

                const event = newGroupEvent(
                    toGroupMemberEventType(status),
                    snapshotGroup,
                    request,
                    timestamp,
                    serviceId,
                );
                await repository.appendEvent(event);

                return await addIdempotentGroupMutationWritten(
                    repository,
                    snapshotGroup,
                    request.requestId,
                    {
                        snapshot: await requireGroupSnapshot(repository, snapshotGroup),
                        event,
                    },
                );
            });
        },
        connectPresenceSession: async (scope, groupId, sessionId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = repositoryFor(transactionRepository);
                const groupRef = {
                    ...scope,
                    groupId,
                };
                await lockGroupPresenceSession(transactionRepository, {
                    ...scope,
                    groupId,
                    sessionId,
                });
                const idempotentWritten = await findIdempotentGroupMutationWritten(
                    repository,
                    groupRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const group = await requireGroup(repository, groupRef);
                const timestamp = now();
                assertGroupPolicyAllowed(canMutateActiveGroup({
                    group,
                    nowEpochMs: timestamp,
                }));
                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.actorPrincipalId ?? request.principalId,
                );
                const existing = await repository.findPresenceSession({
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    sessionId,
                });
                const member = await repository.findMember({
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId: request.principalId,
                });
                if (!member) {
                    throw new NonRetryableException(
                        `Forbidden: group member not found for presence session: ${request.principalId}`,
                    );
                }
                if (member.status !== 'active') {
                    throw new NonRetryableException(
                        `Forbidden: group member is not active for presence session: ${request.principalId}`,
                    );
                }
                assertGroupPolicyAllowed(canConnectGroupPresenceSession({
                    snapshot: await requireGroupSnapshot(repository, groupRef),
                    actor: {
                        principalId: request.principalId,
                        sessionId: request.actorSessionId,
                    },
                    sessionId,
                    nowEpochMs: timestamp,
                }));

                const session: GroupPresenceSession = {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    sessionId,
                    principalId: request.principalId,
                    connectedAtEpochMs: request.connectedAtEpochMs ??
                        existing?.connectedAtEpochMs ??
                        timestamp,
                    lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? timestamp,
                    expiresAtEpochMs: request.expiresAtEpochMs ??
                        timestamp + DEFAULT_GROUP_SESSION_TTL_MS,
                    disconnectedAtEpochMs: undefined,
                    disconnectReason: undefined,
                };

                await repository.putPresenceSession(session);

                let event: GroupEvent | undefined;
                let snapshotGroup = group;
                if (
                    !existing ||
                    !isSameConnectedGroupPresenceSession(existing, session) ||
                    group.emptySinceEpochMs !== undefined
                ) {
                    snapshotGroup = {
                        ...group,
                        snapshotVersion: nextGroupSnapshotVersion(group),
                        presenceVersion: group.presenceVersion + 1,
                        emptySinceEpochMs: undefined,
                        updated: updatedAudit,
                    };
                    await repository.putGroup(snapshotGroup);

                    event = newGroupEvent(
                        'session-connected',
                        snapshotGroup,
                        request,
                        timestamp,
                        serviceId,
                    );
                    await repository.appendEvent(event);
                } else {
                    // The session row changed even though the public domain
                    // version did not. Touch the aggregate row so its durable
                    // revision remains a causal revision for the full snapshot.
                    await repository.putGroup(snapshotGroup);
                }

                return await addIdempotentGroupMutationWritten(
                    repository,
                    snapshotGroup,
                    request.requestId,
                    {
                        snapshot: await requireGroupSnapshot(repository, snapshotGroup),
                        event,
                    },
                );
            });
        },
        heartbeatPresenceSession: async (scope, groupId, sessionId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = repositoryFor(transactionRepository);
                const groupRef = {
                    ...scope,
                    groupId,
                };
                await lockGroupPresenceSession(transactionRepository, {
                    ...scope,
                    groupId,
                    sessionId,
                });
                const idempotentWritten = await findIdempotentGroupMutationWritten(
                    repository,
                    groupRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const group = await requireGroup(repository, groupRef);
                const timestamp = request.lastHeartbeatAtEpochMs ?? now();
                assertGroupPolicyAllowed(canMutateActiveGroup({
                    group,
                    nowEpochMs: timestamp,
                }));
                const ref = {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    sessionId,
                };
                const existing = await repository.findPresenceSession(ref);
                if (!existing) {
                    throw new NonRetryableException(`Group presence session not found: ${sessionId}`);
                }

                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.actorPrincipalId ??
                        request.principalId ??
                        existing.principalId,
                );
                const wasActive = existing.disconnectedAtEpochMs === undefined &&
                    existing.disconnectReason === undefined;
                const session: GroupPresenceSession = {
                    ...existing,
                    lastHeartbeatAtEpochMs: timestamp,
                    expiresAtEpochMs: request.expiresAtEpochMs ??
                        existing.expiresAtEpochMs ??
                        timestamp + DEFAULT_GROUP_SESSION_TTL_MS,
                    disconnectedAtEpochMs: undefined,
                    disconnectReason: undefined,
                };

                await repository.putPresenceSession(session);

                let event: GroupEvent | undefined;
                let snapshotGroup = group;
                if (!wasActive || group.emptySinceEpochMs !== undefined) {
                    snapshotGroup = {
                        ...group,
                        snapshotVersion: nextGroupSnapshotVersion(group),
                        presenceVersion: group.presenceVersion + 1,
                        emptySinceEpochMs: undefined,
                        updated: updatedAudit,
                    };
                    await repository.putGroup(snapshotGroup);

                    event = newGroupEvent(
                        'session-heartbeat',
                        snapshotGroup,
                        request,
                        timestamp,
                        serviceId,
                    );
                    await repository.appendEvent(event);
                } else {
                    // Heartbeat/TTL state is part of GroupSnapshot. Advance the
                    // aggregate row revision without changing snapshotVersion.
                    await repository.putGroup(snapshotGroup);
                }

                return await addIdempotentGroupMutationWritten(
                    repository,
                    snapshotGroup,
                    request.requestId,
                    {
                        snapshot: await requireGroupSnapshot(repository, snapshotGroup),
                        event,
                    },
                );
            });
        },
        disconnectPresenceSession: async (scope, groupId, sessionId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = repositoryFor(transactionRepository);
                const groupRef = {
                    ...scope,
                    groupId,
                };
                await lockGroupPresenceSession(transactionRepository, {
                    ...scope,
                    groupId,
                    sessionId,
                });
                const idempotentWritten = await findIdempotentGroupMutationWritten(
                    repository,
                    groupRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const group = await requireGroup(repository, groupRef);
                const ref = {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    sessionId,
                };
                const existing = await repository.findPresenceSession(ref);
                if (!existing) {
                    throw new NonRetryableException(`Group presence session not found: ${sessionId}`);
                }
                if (existing.disconnectedAtEpochMs !== undefined) {
                    return await addIdempotentGroupMutationWritten(
                        repository,
                        groupRef,
                        request.requestId,
                        {
                            snapshot: await requireGroupSnapshot(repository, group),
                            event: undefined,
                        },
                    );
                }

                const timestamp = now();
                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.actorPrincipalId ??
                        request.principalId ??
                        existing.principalId,
                );
                const session: GroupPresenceSession = {
                    ...existing,
                    lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? existing.lastHeartbeatAtEpochMs,
                    expiresAtEpochMs: request.expiresAtEpochMs ?? existing.expiresAtEpochMs,
                    disconnectedAtEpochMs: request.disconnectedAtEpochMs ??
                        existing.disconnectedAtEpochMs ??
                        timestamp,
                    disconnectReason: request.reason ?? existing.disconnectReason ?? 'closed',
                };

                await repository.putPresenceSession(session);
                const groupIsEmpty = !(await hasLiveGroupPresenceSessions(
                    repository,
                    groupRef,
                    session.disconnectedAtEpochMs ?? timestamp,
                ));

                let event: GroupEvent | undefined;
                let snapshotGroup = group;
                if (!isSameDisconnectedGroupPresenceSession(existing, session)) {
                    snapshotGroup = {
                        ...group,
                        snapshotVersion: nextGroupSnapshotVersion(group),
                        presenceVersion: group.presenceVersion + 1,
                        emptySinceEpochMs: groupIsEmpty
                            ? group.emptySinceEpochMs ??
                                (session.disconnectedAtEpochMs ?? timestamp)
                            : undefined,
                        updated: updatedAudit,
                    };
                    await repository.putGroup(snapshotGroup);

                    event = newGroupEvent(
                        'session-disconnected',
                        snapshotGroup,
                        request,
                        timestamp,
                        serviceId,
                    );
                    await repository.appendEvent(event);
                }

                return await addIdempotentGroupMutationWritten(
                    repository,
                    snapshotGroup,
                    request.requestId,
                    {
                        snapshot: await requireGroupSnapshot(repository, snapshotGroup),
                        event,
                    },
                );
            });
        },
        disconnectPresenceSessionsBySessionId: async (sessionId, request = {}) => {
            const writtenResults = await service.disconnectPresenceSessionsBySessionIdWritten(
                sessionId,
                request,
            );

            return writtenResults.map(requireGroupStateWrittenSnapshot);
        },
        disconnectPresenceSessionsBySessionIdWritten: async (sessionId, request = {}) => {
            const repository = repositoryFor(runtimeRepository);
            const sessions = (await repository.listAllPresenceSessions()).filter(
                (session) =>
                    session.sessionId === sessionId &&
                    session.disconnectedAtEpochMs === undefined,
            );
            const writtenResults: GroupStateWritten[] = [];

            for (const session of sessions) {
                try {
                    const written = await service.disconnectPresenceSession(
                        {
                            applicationId: session.applicationId,
                            workspaceId: session.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
                        },
                        session.groupId,
                        session.sessionId,
                        {
                            ...request,
                            principalId: request.principalId ?? session.principalId,
                            actorPrincipalId: request.actorPrincipalId ?? session.principalId,
                            actorSessionId: request.actorSessionId ?? session.sessionId,
                        },
                    );
                    writtenResults.push(written);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (!message.includes('not found')) {
                        throw error;
                    }
                }
            }

            return writtenResults;
        },
        expireExpiredPresenceSessions: async (atEpochMs = now()) => {
            const repository = repositoryFor(runtimeRepository);
            const sessions = (await repository.listAllPresenceSessions()).filter(
                (session) =>
                    session.disconnectedAtEpochMs === undefined &&
                    session.expiresAtEpochMs <= atEpochMs,
            );
            const writtenResults: GroupStateWritten[] = [];

            for (const session of sessions) {
                try {
                    const written = await service.disconnectPresenceSession(
                        {
                            applicationId: session.applicationId,
                            workspaceId: session.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
                        },
                        session.groupId,
                        session.sessionId,
                        {
                            principalId: session.principalId,
                            reason: 'expired',
                            disconnectedAtEpochMs: atEpochMs,
                            lastHeartbeatAtEpochMs: session.lastHeartbeatAtEpochMs,
                            expiresAtEpochMs: session.expiresAtEpochMs,
                            actorPrincipalId: session.principalId,
                            actorSessionId: session.sessionId,
                            requestId: toExpiredGroupPresenceRequestId(session),
                        },
                    );
                    writtenResults.push(written);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (!message.includes('not found')) {
                        throw error;
                    }
                }
            }

            return writtenResults;
        },
    };

    return withGroupStateServiceTiming(service, dependencies.timing, serviceId);
}

function withGroupStateServiceTiming(
    service: GroupStateService,
    timing: RallarTimingSink | undefined,
    serviceId: string,
): GroupStateService {
    if (!timing) {
        return service;
    }

    return {
        listSnapshots: async (scope) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'listSnapshots',
                    serviceId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                },
                () => service.listSnapshots(scope),
            ),
        listSnapshotsPage: async (scope, options) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'listSnapshotsPage',
                    serviceId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    details: { limit: options.limit },
                },
                () => service.listSnapshotsPage(scope, options),
            ),
        readSnapshot: async (ref) =>
            await timeRallarAsync(
                timing,
                toGroupTimingInput(serviceId, 'readSnapshot', ref),
                () => service.readSnapshot(ref),
            ),
        readStateRevision: async (ref) =>
            await timeRallarAsync(
                timing,
                toGroupTimingInput(serviceId, 'readStateRevision', ref),
                () => service.readStateRevision(ref),
            ),
        listEvents: async (ref) =>
            await timeRallarAsync(
                timing,
                toGroupTimingInput(serviceId, 'listEvents', ref),
                () => service.listEvents(ref),
            ),
        listRecentEvents: async (ref, query) =>
            await timeRallarAsync(
                timing,
                toGroupTimingInput(serviceId, 'listRecentEvents', ref),
                () => service.listRecentEvents!(ref, query),
            ),
        listEventPage: async (ref, query) =>
            await timeRallarAsync(
                timing,
                toGroupTimingInput(serviceId, 'listEventPage', ref),
                () => service.listEventPage(ref, query),
            ),
        createGroup: async (scope, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'createGroup',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId: request.groupId,
                    principalId: request.createdByPrincipalId,
                },
                () => service.createGroup(scope, request),
            ),
        updateGroup: async (scope, groupId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'updateGroup',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId: request.actorPrincipalId,
                    sessionId: request.actorSessionId,
                },
                () => service.updateGroup(scope, groupId, request),
            ),
        appointDirector: async (scope, groupId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'appointDirector',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId: request.actorPrincipalId,
                    sessionId: request.actorSessionId,
                },
                () => service.appointDirector(scope, groupId, request),
            ),
        joinGroup: async (scope, groupId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'joinGroup',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId: request.actorPrincipalId,
                    sessionId: request.actorSessionId,
                },
                () => service.joinGroup(scope, groupId, request),
            ),
        createGroupInvite: async (scope, groupId, principalId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'createGroupInvite',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId,
                    sessionId: request.actorSessionId,
                },
                () => service.createGroupInvite(scope, groupId, principalId, request),
            ),
        revokeGroupInvite: async (scope, groupId, principalId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'revokeGroupInvite',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId,
                    sessionId: request.actorSessionId,
                },
                () => service.revokeGroupInvite(scope, groupId, principalId, request),
            ),
        acceptGroupInvite: async (scope, groupId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'acceptGroupInvite',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId: request.actorPrincipalId,
                    sessionId: request.actorSessionId,
                },
                () => service.acceptGroupInvite(scope, groupId, request),
            ),
        rotateGroupJoinCode: async (scope, groupId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'rotateGroupJoinCode',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId: request.actorPrincipalId,
                    sessionId: request.actorSessionId,
                },
                () => service.rotateGroupJoinCode(scope, groupId, request),
            ),
        removeGroupMember: async (scope, groupId, principalId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'removeGroupMember',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId,
                    sessionId: request.actorSessionId,
                },
                () => service.removeGroupMember(scope, groupId, principalId, request),
            ),
        banGroupMember: async (scope, groupId, principalId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'banGroupMember',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId,
                    sessionId: request.actorSessionId,
                },
                () => service.banGroupMember(scope, groupId, principalId, request),
            ),
        unbanGroupMember: async (scope, groupId, principalId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'unbanGroupMember',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId,
                    sessionId: request.actorSessionId,
                },
                () => service.unbanGroupMember(scope, groupId, principalId, request),
            ),
        setGroupMemberRole: async (scope, groupId, principalId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'setGroupMemberRole',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId,
                    sessionId: request.actorSessionId,
                },
                () => service.setGroupMemberRole(scope, groupId, principalId, request),
            ),
        transferGroupOwnership: async (scope, groupId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'transferGroupOwnership',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId: request.newOwnerPrincipalId,
                    sessionId: request.actorSessionId,
                },
                () => service.transferGroupOwnership(scope, groupId, request),
            ),
        upsertMember: async (scope, groupId, principalId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'upsertMember',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId,
                    sessionId: request.actorSessionId,
                },
                () => service.upsertMember(scope, groupId, principalId, request),
            ),
        connectPresenceSession: async (scope, groupId, sessionId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'connectPresenceSession',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId: request.principalId,
                    sessionId,
                },
                () => service.connectPresenceSession(scope, groupId, sessionId, request),
            ),
        heartbeatPresenceSession: async (scope, groupId, sessionId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'heartbeatPresenceSession',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId: request.principalId,
                    sessionId,
                },
                () => service.heartbeatPresenceSession(scope, groupId, sessionId, request),
            ),
        disconnectPresenceSession: async (scope, groupId, sessionId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'disconnectPresenceSession',
                    serviceId,
                    requestId: request.requestId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId: request.principalId,
                    sessionId,
                },
                () => service.disconnectPresenceSession(scope, groupId, sessionId, request),
            ),
        disconnectPresenceSessionsBySessionId: async (sessionId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'disconnectPresenceSessionsBySessionId',
                    serviceId,
                    requestId: request?.requestId,
                    principalId: request?.principalId,
                    sessionId,
                },
                () => service.disconnectPresenceSessionsBySessionId(sessionId, request),
            ),
        disconnectPresenceSessionsBySessionIdWritten: async (sessionId, request) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'disconnectPresenceSessionsBySessionIdWritten',
                    serviceId,
                    requestId: request?.requestId,
                    principalId: request?.principalId,
                    sessionId,
                },
                () => service.disconnectPresenceSessionsBySessionIdWritten(sessionId, request),
            ),
        expireExpiredPresenceSessions: async (atEpochMs) =>
            await timeRallarAsync(
                timing,
                {
                    component: 'group-state-service',
                    operation: 'expireExpiredPresenceSessions',
                    serviceId,
                    details: {
                        atEpochMs,
                    },
                },
                () => service.expireExpiredPresenceSessions(atEpochMs),
            ),
    };
}

function toGroupTimingInput(
    serviceId: string,
    operation: string,
    ref: GroupRef,
) {
    return {
        component: 'group-state-service',
        operation,
        serviceId,
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
    };
}

async function lockGroupPresenceSession(
    repository: RuntimeStateTransactionalRepositoryLike,
    ref: GroupRef & Readonly<{ sessionId: string }>,
): Promise<void> {
    await repository.lockKey(
        GROUP_PRESENCE_SESSION_LOCK_NAMESPACE,
        toGroupPresenceSessionLockKey(ref),
    );
}

function toGroupPresenceSessionLockKey(
    ref: GroupRef & Readonly<{ sessionId: string }>,
): string {
    return [
        ref.applicationId,
        ref.workspaceId ?? '_',
        ref.groupId,
        ref.sessionId,
    ].join(':');
}

function toDirectorHeartbeatTtlMs(
    request: AppointGroupDirectorRequest,
): number | undefined {
    if (request.heartbeatTtlMs === undefined) {
        return undefined;
    }

    try {
        return normalizeRallarGroupDirectorHeartbeatTtlMs(request.heartbeatTtlMs);
    } catch {
        throw new NonRetryableException('Invalid director heartbeat TTL.');
    }
}

type RallarGroupJoinCodeMetadata = Readonly<{
    version: typeof RALLAR_GROUP_JOIN_CODE_VERSION;
    verifier: string;
    expiresAtEpochMs?: number;
    rotatedAtEpochMs: number;
}>;

function readRallarGroupJoinCode(
    metadata: Readonly<Record<string, unknown>> | undefined,
): RallarGroupJoinCodeMetadata | undefined {
    const value = metadata?.[RALLAR_GROUP_JOIN_CODE_METADATA_KEY];
    if (!isRecord(value)) {
        return undefined;
    }

    if (
        value.version !== RALLAR_GROUP_JOIN_CODE_VERSION ||
        typeof value.verifier !== 'string' ||
        typeof value.rotatedAtEpochMs !== 'number' ||
        (
            value.expiresAtEpochMs !== undefined &&
            typeof value.expiresAtEpochMs !== 'number'
        )
    ) {
        return undefined;
    }

    return {
        version: RALLAR_GROUP_JOIN_CODE_VERSION,
        verifier: value.verifier,
        expiresAtEpochMs: value.expiresAtEpochMs,
        rotatedAtEpochMs: value.rotatedAtEpochMs,
    };
}

function mergeRallarGroupJoinCodeMetadata(
    metadata: Readonly<Record<string, unknown>> | undefined,
    joinCode: RallarGroupJoinCodeMetadata,
): Record<string, unknown> {
    return {
        ...(metadata ?? {}),
        [RALLAR_GROUP_JOIN_CODE_METADATA_KEY]: joinCode,
    };
}

function normalizeJoinCode(joinCode: string | undefined): string {
    const trimmed = joinCode?.trim();
    if (trimmed) {
        return trimmed;
    }

    return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

async function toGroupJoinCodeVerifier(joinCode: string): Promise<string> {
    const payload = new TextEncoder().encode(
        `rallar-group-join-code:v${RALLAR_GROUP_JOIN_CODE_VERSION}:${joinCode}`,
    );
    const digest = await crypto.subtle.digest('SHA-256', payload);
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertIdempotentDirectorAppointmentMatchesActor(
    written: GroupStateWritten,
    actorPrincipalId: string,
    actorSessionId: string,
): void {
    const appointment = readRallarGroupDirectorFromSnapshot(
        written.result.right?.snapshot,
    );
    if (
        appointment?.principalId === actorPrincipalId &&
        appointment.sessionId === actorSessionId
    ) {
        return;
    }

    throw new NonRetryableException(
        'Forbidden: Idempotent director appointment request belongs to a different session.',
    );
}

async function findIdempotentGroupMutationWritten(
    repository: GroupStateRepository,
    ref: GroupRef,
    requestId: string | undefined,
): Promise<GroupStateWritten | undefined> {
    if (!requestId) {
        return undefined;
    }

    return await repository.findIdempotentGroupStateWritten(ref, requestId);
}

async function addIdempotentGroupMutationWritten(
    repository: GroupStateRepository,
    ref: GroupRef,
    requestId: string | undefined,
    written: GroupMutationWritten,
): Promise<GroupStateWritten> {
    const groupStateWritten: GroupStateWritten = {
        status: 'ok',
        result: Either.ofRight(written),
    };

    if (!requestId) {
        return groupStateWritten;
    }

    return await repository.addIdempotentGroupStateWritten(
        ref,
        requestId,
        groupStateWritten,
    );
}

async function findIdempotentGroupJoinCodeMutationWritten(
    repository: GroupStateRepository,
    ref: GroupRef,
    requestId: string | undefined,
): Promise<GroupJoinCodeWritten | undefined> {
    if (!requestId) {
        return undefined;
    }

    return await repository.findIdempotentGroupJoinCodeWritten(ref, requestId);
}

async function addIdempotentGroupJoinCodeMutationWritten(
    repository: GroupStateRepository,
    ref: GroupRef,
    requestId: string | undefined,
    written: GroupJoinCodeMutationWritten,
): Promise<GroupJoinCodeWritten> {
    const groupJoinCodeWritten: GroupJoinCodeWritten = {
        status: 'ok',
        result: Either.ofRight(written),
    };

    if (!requestId) {
        return groupJoinCodeWritten;
    }

    return await repository.addIdempotentGroupJoinCodeWritten(
        ref,
        requestId,
        groupJoinCodeWritten,
    );
}

function requireGroupStateWrittenSnapshot(
    written: GroupStateWritten,
): GroupSnapshot {
    const snapshot = written.result.right?.snapshot;
    if (!snapshot) {
        throw new Error(written.result.left ?? 'Group mutation failed');
    }

    return snapshot;
}

type GovernedGroupMemberMutationInput = Readonly<{
    runtimeRepository: RuntimeStateTransactionalRepositoryLike;
    repositoryFor: (
        repository: RuntimeStateTransactionalRepositoryLike,
    ) => GroupStateRepository;
    scope: StateScope;
    groupId: string;
    principalId: string;
    request: MutationActorInput;
    now: () => number;
    serviceId: string;
    action: GroupGovernanceAction;
    status?: GroupMember['status'];
    role?: GroupMember['role'];
    eventType: GroupEvent['eventType'];
    requiredExistingStatus?: GroupMember['status'];
    missingMemberBehavior: 'create' | 'noop' | 'error';
}>;

async function writeGovernedGroupMemberMutation(
    input: GovernedGroupMemberMutationInput,
): Promise<GroupStateWritten> {
    return await input.runtimeRepository.begin(async (transactionRepository) => {
        const repository = input.repositoryFor(transactionRepository);
        const groupRef = {
            ...input.scope,
            groupId: input.groupId,
        };
        const idempotentWritten = await findIdempotentGroupMutationWritten(
            repository,
            groupRef,
            input.request.requestId,
        );
        if (idempotentWritten) {
            return idempotentWritten;
        }

        const snapshot = await requireGroupSnapshot(repository, groupRef);
        const timestamp = input.now();
        assertGroupPolicyAllowed(canMutateActiveGroup({
            group: snapshot.group,
            nowEpochMs: timestamp,
        }));

        const existing = snapshot.members.find((member) => member.principalId === input.principalId);
        if (input.role === 'owner') {
            throwGroupPolicyDenied(
                'forbidden-role',
                'Use ownership transfer to assign the owner role.',
            );
        }
        assertGroupPolicyAllowed(canGovernGroupMember({
            snapshot,
            actor: {
                principalId: input.request.actorPrincipalId,
                sessionId: input.request.actorSessionId,
            },
            targetPrincipalId: input.principalId,
            action: input.role ? toRoleGovernanceAction(existing, input.role) : input.action,
        }));

        if (!existing && input.missingMemberBehavior === 'noop') {
            return await addIdempotentGroupMutationWritten(
                repository,
                snapshot.group,
                input.request.requestId,
                {
                    snapshot,
                    event: undefined,
                },
            );
        }
        if (!existing && input.missingMemberBehavior === 'error') {
            throw new NonRetryableException(
                `Group member not found: ${input.principalId}`,
            );
        }
        if (
            existing &&
            input.requiredExistingStatus !== undefined &&
            existing.status !== input.requiredExistingStatus
        ) {
            return await addIdempotentGroupMutationWritten(
                repository,
                snapshot.group,
                input.request.requestId,
                {
                    snapshot,
                    event: undefined,
                },
            );
        }

        const updatedAudit = toGroupAuditStamp(
            input.request,
            timestamp,
            input.serviceId,
            input.request.actorPrincipalId,
        );
        const status = input.status ?? existing?.status ?? 'left';
        const member: GroupMember = {
            applicationId: input.scope.applicationId,
            workspaceId: input.scope.workspaceId,
            groupId: input.groupId,
            principalId: input.principalId,
            role: input.role ?? existing?.role ?? 'member',
            status,
            joined: existing?.joined ?? updatedAudit,
            updated: updatedAudit,
            left: status === 'left' ? updatedAudit : existing?.left,
            removed: status === 'removed' ? updatedAudit : existing?.removed,
            banned: status === 'banned' ? updatedAudit : existing?.banned,
            invitedByPrincipalId: existing?.invitedByPrincipalId,
            invitationExpiresAtEpochMs: existing?.invitationExpiresAtEpochMs,
        };

        if (existing && isSameGroupMemberMutation(existing, member)) {
            return await addIdempotentGroupMutationWritten(
                repository,
                snapshot.group,
                input.request.requestId,
                {
                    snapshot,
                    event: undefined,
                },
            );
        }

        await repository.putMember(member);
        const snapshotGroup = {
            ...snapshot.group,
            snapshotVersion: nextGroupSnapshotVersion(snapshot.group),
            rosterVersion: snapshot.group.rosterVersion + 1,
            updated: updatedAudit,
        };
        await repository.putGroup(snapshotGroup);

        const event = newGroupEvent(
            input.eventType,
            snapshotGroup,
            input.request,
            timestamp,
            input.serviceId,
        );
        await repository.appendEvent(event);

        return await addIdempotentGroupMutationWritten(
            repository,
            snapshotGroup,
            input.request.requestId,
            {
                snapshot: await requireGroupSnapshot(repository, snapshotGroup),
                event,
            },
        );
    });
}

function assertGroupPolicyAllowed(result: GroupPolicyResult): void {
    if (!result.allowed) {
        throw new GroupPolicyDeniedError(result);
    }
}

function assertRawMemberMutationKeepsOwner(
    snapshot: GroupSnapshot,
    existing: GroupMember | undefined,
    request: UpsertGroupMemberRequest,
): void {
    if (!existing || !isLastActiveOwnerInSnapshot(snapshot, existing)) {
        return;
    }

    if (
        request.status === 'left' ||
        request.status === 'removed' ||
        request.status === 'banned' ||
        (request.role !== undefined && request.role !== 'owner')
    ) {
        throwGroupPolicyDenied(
            'last-owner',
            'Cannot leave an active group without an owner.',
        );
    }
}

function toRoleGovernanceAction(
    existing: GroupMember | undefined,
    role: GroupMember['role'],
): GroupGovernanceAction {
    if (existing?.role === 'owner' && role !== 'owner') {
        return 'demote';
    }

    return role === 'member' ? 'demote' : 'promote';
}

function isLastActiveOwnerInSnapshot(
    snapshot: GroupSnapshot,
    member: GroupMember,
): boolean {
    if (member.role !== 'owner' || member.status !== 'active') {
        return false;
    }

    return snapshot.members.filter((entry) => entry.role === 'owner' && entry.status === 'active')
        .length === 1;
}

function assertCanInviteMember(member: GroupMember | undefined): void {
    if (member?.status === 'removed') {
        throwGroupPolicyDenied(
            'member-removed',
            'Group member has been removed.',
        );
    }
    if (member?.status === 'banned') {
        throwGroupPolicyDenied(
            'member-banned',
            'Group member has been banned.',
        );
    }
}

function throwGroupPolicyDenied(
    code: GroupPolicyDenied['code'],
    message: string,
): never {
    throw new GroupPolicyDeniedError({
        allowed: false,
        code,
        message,
    });
}

function shouldRequireActiveGroupForUpdate(
    existing: Group,
    request: UpdateGroupRequest,
    nowEpochMs: number,
): boolean {
    if (existing.status === 'active' && !isGroupExpired(existing, nowEpochMs)) {
        return false;
    }

    return request.status === undefined || hasNonLifecycleGroupUpdateFields(request);
}

function isGroupExpired(group: Group, nowEpochMs: number): boolean {
    return group.expiresAtEpochMs !== undefined &&
        group.expiresAtEpochMs <= nowEpochMs;
}

function hasNonLifecycleGroupUpdateFields(request: UpdateGroupRequest): boolean {
    return request.slug !== undefined ||
        request.displayName !== undefined ||
        request.description !== undefined ||
        request.kind !== undefined ||
        request.joinMode !== undefined ||
        request.maxMembers !== undefined ||
        request.maxSessionsPerMember !== undefined ||
        request.metadata !== undefined ||
        request.expiresAtEpochMs !== undefined ||
        request.emptySinceEpochMs !== undefined ||
        request.purgeAfterEpochMs !== undefined;
}

async function requireGroup(
    repository: GroupStateRepository,
    ref: GroupRef,
): Promise<Group> {
    const group = await repository.findGroup(ref);
    if (!group) {
        throw new NonRetryableException(`Group not found: ${ref.groupId}`);
    }

    return group;
}

async function hasLiveGroupPresenceSessions(
    repository: GroupStateRepository,
    ref: GroupRef,
    atEpochMs: number,
): Promise<boolean> {
    const sessions = await repository.listPresenceSessions(ref);
    return sessions.some((session) =>
        session.disconnectedAtEpochMs === undefined &&
        session.expiresAtEpochMs > atEpochMs
    );
}

function nextGroupSnapshotVersion(group: Group): number {
    return group.snapshotVersion + 1;
}

async function requireGroupSnapshot(
    repository: GroupStateRepository,
    ref: GroupRef,
): Promise<GroupSnapshot> {
    const snapshot = await repository.readSnapshot(ref);
    if (!snapshot) {
        throw new Error(`Group snapshot not found: ${ref.groupId}`);
    }

    return snapshot;
}

function isSameGroupMutation(current: Group, next: Group): boolean {
    return (
        current.slug === next.slug &&
        current.displayName === next.displayName &&
        current.description === next.description &&
        current.kind === next.kind &&
        current.status === next.status &&
        current.joinMode === next.joinMode &&
        current.maxMembers === next.maxMembers &&
        current.maxSessionsPerMember === next.maxSessionsPerMember &&
        jsonEquals(current.metadata, next.metadata) &&
        current.expiresAtEpochMs === next.expiresAtEpochMs &&
        current.emptySinceEpochMs === next.emptySinceEpochMs &&
        current.purgeAfterEpochMs === next.purgeAfterEpochMs
    );
}

function isSameGroupMemberMutation(
    current: GroupMember,
    next: GroupMember,
): boolean {
    return (
        current.role === next.role &&
        current.status === next.status &&
        current.invitedByPrincipalId === next.invitedByPrincipalId &&
        current.invitationExpiresAtEpochMs === next.invitationExpiresAtEpochMs
    );
}

function isSameConnectedGroupPresenceSession(
    current: GroupPresenceSession,
    next: GroupPresenceSession,
): boolean {
    return (
        current.principalId === next.principalId &&
        current.connectedAtEpochMs === next.connectedAtEpochMs &&
        current.disconnectedAtEpochMs === undefined &&
        next.disconnectedAtEpochMs === undefined &&
        current.disconnectReason === undefined &&
        next.disconnectReason === undefined
    );
}

function isSameDisconnectedGroupPresenceSession(
    current: GroupPresenceSession,
    next: GroupPresenceSession,
): boolean {
    return (
        current.principalId === next.principalId &&
        current.connectedAtEpochMs === next.connectedAtEpochMs &&
        current.disconnectReason === next.disconnectReason &&
        current.disconnectedAtEpochMs !== undefined &&
        next.disconnectedAtEpochMs !== undefined
    );
}

function newGroupEvent(
    eventType: GroupEvent['eventType'],
    group: Group,
    request: MutationActorInput,
    timestamp: number,
    serviceId: string,
): GroupEvent {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
        eventId: crypto.randomUUID(),
        eventType,
        snapshotVersion: group.snapshotVersion,
        occurredAtEpochMs: timestamp,
        actor: {
            principalId: request.actorPrincipalId,
            sessionId: request.actorSessionId,
            serviceId,
        },
        reason: request.reason,
        traceId: request.traceId,
        requestId: request.requestId,
    };
}

function toExpiredGroupPresenceRequestId(session: GroupPresenceSession): string {
    return `expire-group-presence:${session.groupId}:${session.sessionId}:${session.expiresAtEpochMs}`;
}

function toGroupMemberEventType(
    status: GroupMember['status'],
): GroupEvent['eventType'] {
    switch (status) {
        case 'invited':
            return 'member-invited';
        case 'active':
            return 'member-joined';
        case 'left':
            return 'member-left';
        case 'removed':
            return 'member-removed';
        case 'banned':
            return 'member-banned';
    }
}

function toGroupAuditStamp(
    request: MutationActorInput,
    timestamp: number,
    serviceId: string,
    defaultPrincipalId?: string,
): AuditStamp {
    return {
        atEpochMs: timestamp,
        byPrincipalId: request.actorPrincipalId ?? defaultPrincipalId,
        bySessionId: request.actorSessionId,
        byServiceId: serviceId,
        reason: request.reason,
        traceId: request.traceId,
        requestId: request.requestId,
    };
}
