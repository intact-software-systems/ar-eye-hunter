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
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import type { RuntimeStateTransactionalRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { myServerId } from '../config-repo.ts';
import { createRuntimeStateRepository } from '../repository/createStateRepositories.ts';
import { getWsStateSyncPublisher, type StateSyncPublisher } from './state-sync-service.ts';

const DEFAULT_GROUP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type GroupStateService = Readonly<{
    listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]>;
    readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
    listEvents(ref: GroupRef): Promise<readonly GroupEvent[]>;
    createGroup(scope: StateScope, request: CreateGroupRequest): Promise<GroupSnapshot>;
    updateGroup(
        scope: StateScope,
        groupId: string,
        request: UpdateGroupRequest,
    ): Promise<GroupSnapshot>;
    upsertMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: UpsertGroupMemberRequest,
    ): Promise<GroupSnapshot>;
    connectPresenceSession(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: ConnectGroupPresenceSessionRequest,
    ): Promise<GroupSnapshot>;
    heartbeatPresenceSession(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: HeartbeatGroupPresenceSessionRequest,
    ): Promise<GroupSnapshot>;
    disconnectPresenceSession(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: DisconnectGroupPresenceSessionRequest,
    ): Promise<GroupSnapshot>;
    disconnectPresenceSessionsBySessionId(
        sessionId: string,
        request?: DisconnectGroupPresenceSessionRequest,
    ): Promise<readonly GroupSnapshot[]>;
}>;

type GroupStateServiceDependencies = Readonly<{
    runtimeRepository: RuntimeStateTransactionalRepositoryLike;
    syncPublisher: StateSyncPublisher;
    now?: () => number;
    serviceId?: string;
}>;

export function createGroupStateService(
    dependencies: GroupStateServiceDependencies,
): GroupStateService {
    const runtimeRepository = dependencies.runtimeRepository;
    const syncPublisher = dependencies.syncPublisher;
    const now = dependencies.now ?? (() => Date.now());
    const serviceId = dependencies.serviceId ?? myServerId;

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
            return await new GroupStateRepository(runtimeRepository).readSnapshot(ref);
        },
        listEvents: async (ref) => {
            return await new GroupStateRepository(runtimeRepository).listEvents(ref);
        },
        createGroup: async (scope, request) => {
            const result = await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new GroupStateRepository(transactionRepository);
                const ref: GroupRef = {
                    ...scope,
                    groupId: request.groupId,
                };
                const existing = await repository.findGroup(ref);
                if (existing) {
                    throw new Error(`Group already exists: ${request.groupId}`);
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
                        actorPrincipalId: request.actorPrincipalId ?? request.createdByPrincipalId,
                    },
                    timestamp,
                    serviceId,
                );
                await repository.appendEvent(event);

                return {
                    snapshot: await requireGroupSnapshot(repository, ref),
                    event,
                };
            });

            await publishGroupMutation(syncPublisher, result.snapshot, result.event, serviceId);
            return result.snapshot;
        },
        updateGroup: async (scope, groupId, request) => {
            const result = await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new GroupStateRepository(transactionRepository);
                const ref: GroupRef = {
                    ...scope,
                    groupId,
                };
                const existing = await repository.findGroup(ref);
                if (!existing) {
                    throw new Error(`Group not found: ${groupId}`);
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
                    metadataVersion: existing.metadataVersion + 1,
                    updated: updatedAudit,
                    archived: status === 'archived' ? updatedAudit : existing.archived,
                    deleted: status === 'deleted' ? updatedAudit : existing.deleted,
                    expiresAtEpochMs: request.expiresAtEpochMs ?? existing.expiresAtEpochMs,
                    emptySinceEpochMs: request.emptySinceEpochMs ?? existing.emptySinceEpochMs,
                    purgeAfterEpochMs: request.purgeAfterEpochMs ?? existing.purgeAfterEpochMs,
                };

                if (isSameGroupMutation(existing, group)) {
                    return {
                        snapshot: await requireGroupSnapshot(repository, ref),
                        event: undefined,
                    };
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

                return {
                    snapshot: await requireGroupSnapshot(repository, ref),
                    event,
                };
            });

            if (result.event) {
                await publishGroupMutation(syncPublisher, result.snapshot, result.event, serviceId);
            }
            return result.snapshot;
        },
        upsertMember: async (scope, groupId, principalId, request) => {
            const result = await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new GroupStateRepository(transactionRepository);
                const group = await requireGroup(repository, {
                    ...scope,
                    groupId,
                });
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
                        request.invitationExpiresAtEpochMs ?? existing?.invitationExpiresAtEpochMs,
                };

                if (existing && isSameGroupMemberMutation(existing, member)) {
                    return {
                        snapshot: await requireGroupSnapshot(repository, group),
                        event: undefined,
                    };
                }

                await repository.putMember(member);
                await repository.putGroup({
                    ...group,
                    rosterVersion: group.rosterVersion + 1,
                    updated: updatedAudit,
                });

                const event = newGroupEvent(
                    toGroupMemberEventType(status),
                    group,
                    request,
                    timestamp,
                    serviceId,
                );
                await repository.appendEvent(event);

                return {
                    snapshot: await requireGroupSnapshot(repository, group),
                    event,
                };
            });

            if (result.event) {
                await publishGroupMutation(syncPublisher, result.snapshot, result.event, serviceId);
            }
            return result.snapshot;
        },
        connectPresenceSession: async (scope, groupId, sessionId, request) => {
            const result = await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new GroupStateRepository(transactionRepository);
                const group = await requireGroup(repository, {
                    ...scope,
                    groupId,
                });
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
                    throw new Error(
                        `Forbidden: group member not found for presence session: ${request.principalId}`,
                    );
                }
                if (member.status !== 'active') {
                    throw new Error(
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
                        request.connectedAtEpochMs ?? existing?.connectedAtEpochMs ?? timestamp,
                    lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? timestamp,
                    expiresAtEpochMs:
                        request.expiresAtEpochMs ?? timestamp + DEFAULT_GROUP_SESSION_TTL_MS,
                    disconnectedAtEpochMs: undefined,
                    disconnectReason: undefined,
                };

                await repository.putPresenceSession(session);

                let event: GroupEvent | undefined;
                let snapshotGroup = group;
                if (!existing || !isSameConnectedGroupPresenceSession(existing, session)) {
                    snapshotGroup = {
                        ...group,
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

                return {
                    snapshot: await requireGroupSnapshot(repository, snapshotGroup),
                    event,
                };
            });

            if (result.event) {
                await publishGroupMutation(syncPublisher, result.snapshot, result.event, serviceId);
            }
            return result.snapshot;
        },
        heartbeatPresenceSession: async (scope, groupId, sessionId, request) => {
            const result = await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new GroupStateRepository(transactionRepository);
                const group = await requireGroup(repository, {
                    ...scope,
                    groupId,
                });
                const ref = {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    sessionId,
                };
                const existing = await repository.findPresenceSession(ref);
                if (!existing) {
                    throw new Error(`Group presence session not found: ${sessionId}`);
                }

                const timestamp = request.lastHeartbeatAtEpochMs ?? now();
                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.actorPrincipalId ?? request.principalId ?? existing.principalId,
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
                if (!wasActive) {
                    await repository.putGroup({
                        ...group,
                        presenceVersion: group.presenceVersion + 1,
                        updated: updatedAudit,
                    });

                    event = newGroupEvent(
                        'session-heartbeat',
                        group,
                        request,
                        timestamp,
                        serviceId,
                    );
                    await repository.appendEvent(event);
                }

                return {
                    snapshot: await requireGroupSnapshot(repository, group),
                    event,
                };
            });

            if (result.event) {
                await publishGroupMutation(syncPublisher, result.snapshot, result.event, serviceId);
            }
            return result.snapshot;
        },
        disconnectPresenceSession: async (scope, groupId, sessionId, request) => {
            const result = await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new GroupStateRepository(transactionRepository);
                const group = await requireGroup(repository, {
                    ...scope,
                    groupId,
                });
                const ref = {
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    groupId,
                    sessionId,
                };
                const existing = await repository.findPresenceSession(ref);
                if (!existing) {
                    throw new Error(`Group presence session not found: ${sessionId}`);
                }

                const timestamp = now();
                const updatedAudit = toGroupAuditStamp(
                    request,
                    timestamp,
                    serviceId,
                    request.actorPrincipalId ?? request.principalId ?? existing.principalId,
                );
                const session: GroupPresenceSession = {
                    ...existing,
                    lastHeartbeatAtEpochMs:
                        request.lastHeartbeatAtEpochMs ?? existing.lastHeartbeatAtEpochMs,
                    expiresAtEpochMs: request.expiresAtEpochMs ?? existing.expiresAtEpochMs,
                    disconnectedAtEpochMs: request.disconnectedAtEpochMs ?? timestamp,
                    disconnectReason: request.reason ?? existing.disconnectReason ?? 'closed',
                };

                await repository.putPresenceSession(session);

                let event: GroupEvent | undefined;
                let snapshotGroup = group;
                if (!isSameDisconnectedGroupPresenceSession(existing, session)) {
                    snapshotGroup = {
                        ...group,
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

                return {
                    snapshot: await requireGroupSnapshot(repository, snapshotGroup),
                    event,
                };
            });

            if (result.event) {
                await publishGroupMutation(syncPublisher, result.snapshot, result.event, serviceId);
            }
            return result.snapshot;
        },
        disconnectPresenceSessionsBySessionId: async (sessionId, request = {}) => {
            const repository = new GroupStateRepository(runtimeRepository);
            const sessions = (await repository.listAllPresenceSessions()).filter(
                (session) =>
                    session.sessionId === sessionId && session.disconnectedAtEpochMs === undefined,
            );
            const snapshots: GroupSnapshot[] = [];

            for (const session of sessions) {
                try {
                    snapshots.push(
                        await service.disconnectPresenceSession(
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
                        ),
                    );
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (!message.includes('not found')) {
                        throw error;
                    }
                }
            }

            return snapshots;
        },
    };

    return service;
}

export function getGroupStateService(): GroupStateService {
    return createGroupStateService({
        runtimeRepository: createRuntimeStateRepository(),
        syncPublisher: getWsStateSyncPublisher(),
        serviceId: myServerId,
    });
}

async function publishGroupMutation(
    syncPublisher: StateSyncPublisher,
    snapshot: GroupSnapshot,
    event: GroupEvent,
    serviceId: string,
): Promise<void> {
    await syncPublisher.publishGroupSnapshot(snapshot, serviceId);
    await syncPublisher.publishGroupEvent(event, serviceId);
}

async function requireGroup(repository: GroupStateRepository, ref: GroupRef): Promise<Group> {
    const group = await repository.findGroup(ref);
    if (!group) {
        throw new Error(`Group not found: ${ref.groupId}`);
    }

    return group;
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

function isSameGroupMemberMutation(current: GroupMember, next: GroupMember): boolean {
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

function toGroupMemberEventType(status: GroupMember['status']): GroupEvent['eventType'] {
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

function jsonEquals(left: unknown, right: unknown): boolean {
    return stableJsonStringify(left) === stableJsonStringify(right);
}

function stableJsonStringify(value: unknown): string {
    return JSON.stringify(toStableJson(value));
}

function toStableJson(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(toStableJson);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => [key, toStableJson(entryValue)]),
    );
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}
