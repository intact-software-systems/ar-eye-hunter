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
    ConnectGroupPresenceSessionRequest,
    CreateGroupRequest,
    DisconnectGroupPresenceSessionRequest,
    HeartbeatGroupPresenceSessionRequest,
    MutationActorInput,
    StateScope,
    UpdateGroupRequest,
    UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { GroupStateRepository } from '../repositories/GroupStateRepository.ts';
import type { RuntimeStateTransactionalRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import type { StateSyncPublisher } from '../state-sync-publisher.ts';
import { Either } from '@shared/resilience/Either.ts';
import { isDefined, jsonEquals } from '@shared/repository/state-utils.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';

const DEFAULT_GROUP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const GROUP_PRESENCE_SESSION_LOCK_NAMESPACE =
    'group-state:presence-session-locks';

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

export type GroupStateService = Readonly<{
    listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]>;
    readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
    listEvents(ref: GroupRef): Promise<readonly GroupEvent[]>;
    createGroup(
        scope: StateScope,
        request: CreateGroupRequest,
    ): Promise<GroupStateWritten>;
    updateGroup(
        scope: StateScope,
        groupId: string,
        request: UpdateGroupRequest,
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
    syncPublisher: StateSyncPublisher;
    now?: () => number;
    serviceId: string;
}>;

export function createGroupStateService(
    dependencies: GroupStateServiceDependencies,
): GroupStateService {
    const runtimeRepository = dependencies.runtimeRepository;
    const now = dependencies.now ?? (() => Date.now());
    const serviceId = dependencies.serviceId;

    const service: GroupStateService = {
        listSnapshots: async (scope) => {
            const repository = new GroupStateRepository(runtimeRepository);
            const groups = await repository.listGroups(scope);
            const snapshots = await Promise.all(
                groups.map(async (group) => await repository.readSnapshot(group)),
            );

            return snapshots.filter(isDefined);
        },
        readSnapshot: async (ref) => {
            return await new GroupStateRepository(runtimeRepository).readSnapshot(
                ref,
            );
        },
        listEvents: async (ref) => {
            return await new GroupStateRepository(runtimeRepository).listEvents(ref);
        },

        createGroup: async (scope, request): Promise<GroupStateWritten> => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new GroupStateRepository(transactionRepository);

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

                await repository.putGroup(group);
                await repository.putMember({
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId: request.groupId,
                    principalId: request.createdByPrincipalId,
                    role: 'owner',
                    status: 'active',
                    joined: created,
                    updated: created,
                });

                const event = newGroupEvent(
                    'group-created',
                    group,
                    {
                        ...request,
                        actorPrincipalId:
                            request.actorPrincipalId ?? request.createdByPrincipalId,
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
                            snapshot: await requireGroupSnapshot(repository, ref),
                            event,
                        }),
                    },
                );
            });
        },
        updateGroup: async (scope, groupId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new GroupStateRepository(transactionRepository);
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
                    maxSessionsPerMember:
                        request.maxSessionsPerMember ?? existing.maxSessionsPerMember,
                    metadata: request.metadata ?? existing.metadata,
                    snapshotVersion: nextGroupSnapshotVersion(existing),
                    metadataVersion: existing.metadataVersion + 1,
                    updated: updatedAudit,
                    archived: status === 'archived' ? updatedAudit : existing.archived,
                    deleted: status === 'deleted' ? updatedAudit : existing.deleted,
                    expiresAtEpochMs:
                        request.expiresAtEpochMs ?? existing.expiresAtEpochMs,
                    emptySinceEpochMs:
                        request.emptySinceEpochMs ?? existing.emptySinceEpochMs,
                    purgeAfterEpochMs:
                        request.purgeAfterEpochMs ?? existing.purgeAfterEpochMs,
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
        upsertMember: async (scope, groupId, principalId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new GroupStateRepository(transactionRepository);
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
                const ref = {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    principalId,
                };
                const existing = await repository.findMember(ref);
                const timestamp = now();
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
                    invitedByPrincipalId:
                        request.invitedByPrincipalId ?? existing?.invitedByPrincipalId,
                    invitationExpiresAtEpochMs:
                        request.invitationExpiresAtEpochMs ??
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
                const repository = new GroupStateRepository(transactionRepository);
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

                const session: GroupPresenceSession = {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    sessionId,
                    principalId: request.principalId,
                    connectedAtEpochMs:
                        request.connectedAtEpochMs ??
                        existing?.connectedAtEpochMs ??
                        timestamp,
                    lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? timestamp,
                    expiresAtEpochMs:
                        request.expiresAtEpochMs ??
                        timestamp + DEFAULT_GROUP_SESSION_TTL_MS,
                    disconnectedAtEpochMs: undefined,
                    disconnectReason: undefined,
                };

                await repository.putPresenceSession(session);

                let event: GroupEvent | undefined;
                let snapshotGroup = group;
                if (
                    !existing ||
                    !isSameConnectedGroupPresenceSession(existing, session)
                ) {
                    snapshotGroup = {
                        ...group,
                        snapshotVersion: nextGroupSnapshotVersion(group),
                        presenceVersion: group.presenceVersion + 1,
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
                const repository = new GroupStateRepository(transactionRepository);
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

                const timestamp = request.lastHeartbeatAtEpochMs ?? now();
                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.actorPrincipalId ??
                    request.principalId ??
                    existing.principalId,
                );
                const wasActive =
                    existing.disconnectedAtEpochMs === undefined &&
                    existing.disconnectReason === undefined;
                const session: GroupPresenceSession = {
                    ...existing,
                    lastHeartbeatAtEpochMs: timestamp,
                    expiresAtEpochMs:
                        request.expiresAtEpochMs ??
                        existing.expiresAtEpochMs ??
                        timestamp + DEFAULT_GROUP_SESSION_TTL_MS,
                    disconnectedAtEpochMs: undefined,
                    disconnectReason: undefined,
                };

                await repository.putPresenceSession(session);

                let event: GroupEvent | undefined;
                let snapshotGroup = group;
                if (!wasActive) {
                    snapshotGroup = {
                        ...group,
                        snapshotVersion: nextGroupSnapshotVersion(group),
                        presenceVersion: group.presenceVersion + 1,
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
                const repository = new GroupStateRepository(transactionRepository);
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
                    lastHeartbeatAtEpochMs:
                        request.lastHeartbeatAtEpochMs ?? existing.lastHeartbeatAtEpochMs,
                    expiresAtEpochMs:
                        request.expiresAtEpochMs ?? existing.expiresAtEpochMs,
                    disconnectedAtEpochMs:
                        request.disconnectedAtEpochMs ??
                        existing.disconnectedAtEpochMs ??
                        timestamp,
                    disconnectReason:
                        request.reason ?? existing.disconnectReason ?? 'closed',
                };

                await repository.putPresenceSession(session);

                let event: GroupEvent | undefined;
                let snapshotGroup = group;
                if (!isSameDisconnectedGroupPresenceSession(existing, session)) {
                    snapshotGroup = {
                        ...group,
                        snapshotVersion: nextGroupSnapshotVersion(group),
                        presenceVersion: group.presenceVersion + 1,
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
            const repository = new GroupStateRepository(runtimeRepository);
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
                    const message =
                        error instanceof Error ? error.message : String(error);
                    if (!message.includes('not found')) {
                        throw error;
                    }
                }
            }

            return writtenResults;
        },
        expireExpiredPresenceSessions: async (atEpochMs = now()) => {
            const repository = new GroupStateRepository(runtimeRepository);
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
                    const message =
                        error instanceof Error ? error.message : String(error);
                    if (!message.includes('not found')) {
                        throw error;
                    }
                }
            }

            return writtenResults;
        },
    };

    return service;
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

function requireGroupStateWrittenSnapshot(
    written: GroupStateWritten,
): GroupSnapshot {
    const snapshot = written.result.right?.snapshot;
    if (!snapshot) {
        throw new Error(written.result.left ?? 'Group mutation failed');
    }

    return snapshot;
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
