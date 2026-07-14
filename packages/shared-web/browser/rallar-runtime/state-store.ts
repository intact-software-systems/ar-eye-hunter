import * as stateCaches from '@shared-web/browser/data-caches.ts';
import type {
    RallarPeopleState,
    RallarPerson,
    RallarRoomMember,
    RallarRoomState,
    RallarStateListener,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar-facade-contract.ts';
import type {
    RallarStatePort,
    RallarStateRuntimePort,
} from '@shared-web/browser/rallar-runtime/contracts.ts';
import { notifyListener } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import {
    isSameGroupRef,
    toGroupRefFromScope,
} from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import {
    isGroupActive,
    isSessionInGroup,
    readActiveClientSessionIds,
    readGroupDisplayName,
    readGroupId,
    readGroupVersion,
} from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    DEFAULT_STATE_WORKSPACE_ID,
    type StateScope,
} from '@shared/api/state-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

export type CreateRallarStateStoreOptions = Readonly<{
    runtime: RallarStateRuntimePort;
    readSession: () => AuthSession | undefined;
    readGroupSnapshots?: () => readonly GroupSnapshot[];
    findGroupSnapshotByRef?: (roomRef: GroupRef) => GroupSnapshot | undefined;
    findFirstGroupRefForSession?: (sessionId: string) => GroupRef | undefined;
    readClientSnapshots?: () => readonly ClientSnapshot[];
    findClientSnapshot?: (principalId: string) => ClientSnapshot | undefined;
}>;

export function createRallarStateStore(
    options: CreateRallarStateStoreOptions,
): RallarStatePort {
    const roomStateListeners = new Set<RallarStateListener<RallarRoomState>>();
    const peopleStateListeners = new Set<RallarStateListener<RallarPeopleState>>();
    const afterEmitListeners = new Set<() => void>();
    const readAllGroups = options.readGroupSnapshots ?? (() =>
        readRallarCacheOrDefault(
            () => groupStateSnapshotsRepository.getAllGroupStateSnapshots(),
            [],
        ));
    const findGroupByRef = options.findGroupSnapshotByRef ?? ((roomRef) =>
        readRallarCacheOrDefault(
            () => groupStateSnapshotsRepository.findGroupStateSnapshotByRef(roomRef),
            undefined,
        ));
    const findFirstGroupRef = options.findFirstGroupRefForSession ?? ((sessionId) =>
        readRallarCacheOrDefault(
            () => groupStateSnapshotsRepository
                .findFirstGroupStateSnapshotRefSessionIdIsIn(sessionId),
            undefined,
        ));
    const readAllClients = options.readClientSnapshots ?? (() =>
        readRallarCacheOrDefault(
            () => clientStateSnapshotsRepository.getAllClientStateSnapshots(),
            [],
        ));
    const findClientByPrincipalId = options.findClientSnapshot ?? ((principalId) =>
        readRallarCacheOrDefault(
            () => clientStateSnapshotsRepository
                .findClientStateSnapshotByPrincipalId(principalId),
            undefined,
        ));

    let store!: RallarStatePort;

    const isInDefaultScope = (
        value: Pick<StateScope, 'applicationId'> & { workspaceId?: string },
    ): boolean => isSameStateScopeValue(value, options.runtime.readDefaultScope());

    const readGroupSnapshots = (): GroupSnapshot[] =>
        [...readAllGroups()].filter((snapshot) => isInDefaultScope(snapshot.group));

    const resolveGroupRefFromRoomId = (
        roomId: string,
        scope?: StateScope,
    ): GroupRef | undefined =>
        toGroupRefFromScope(
            roomId,
            options.runtime.resolveOperationScope(scope),
        );

    const findGroupSnapshot = (
        room: string | GroupRef | undefined,
    ): GroupSnapshot | undefined => {
        if (!room) {
            return undefined;
        }
        if (typeof room !== 'string') {
            return findGroupByRef(room);
        }

        const scopedRef = resolveGroupRefFromRoomId(room);
        if (scopedRef) {
            const scopedSnapshot = findGroupByRef(scopedRef);
            if (scopedSnapshot) {
                return scopedSnapshot;
            }
        }

        return readGroupSnapshots()
            .filter((snapshot) => snapshot.group.groupId === room)
            .sort((left, right) => readGroupVersion(right) - readGroupVersion(left))
            .at(0);
    };

    const findFirstGroupSnapshotRefForSession = (
        sessionId: string,
    ): GroupRef | undefined => {
        const fromRepository = findFirstGroupRef(sessionId);
        if (fromRepository && isInDefaultScope(fromRepository)) {
            return fromRepository;
        }

        return readGroupSnapshots()
            .find((snapshot) => snapshot.activeSessions.some((activeSession) =>
                activeSession.sessionId === sessionId
            ))
            ?.group;
    };

    const resolveCurrentRoomRef = (): GroupRef | undefined => {
        const session = options.readSession();
        if (!session) {
            return undefined;
        }

        const currentRoomRef = options.runtime.currentRoomRef();
        if (currentRoomRef) {
            const current = findGroupSnapshot(currentRoomRef);
            if (current && isGroupActive(current) &&
                isSessionInGroup(current, session.sessionId)) {
                return current.group;
            }
        }

        const currentRoomId = options.runtime.currentRoomId();
        if (currentRoomId) {
            const current = findGroupSnapshot(currentRoomId);
            if (current && isGroupActive(current) &&
                isSessionInGroup(current, session.sessionId)) {
                return current.group;
            }
        }

        return findFirstGroupSnapshotRefForSession(session.sessionId);
    };

    const readClientSnapshots = (): ClientSnapshot[] =>
        [...readAllClients()].filter((snapshot) =>
            isInDefaultScope(snapshot.principal)
        );

    const findClientSnapshot = (
        principalId: string,
    ): ClientSnapshot | undefined => {
        const snapshot = findClientByPrincipalId(principalId);
        return snapshot && isInDefaultScope(snapshot.principal)
            ? snapshot
            : undefined;
    };

    const toRoomMembers = (
        currentRoom: GroupSnapshot | undefined,
    ): readonly RallarRoomMember[] => {
        if (!currentRoom) {
            return [];
        }

        const sessionIdsByPrincipalId = new Map<string, string[]>();
        for (const session of currentRoom.activeSessions) {
            const existing = sessionIdsByPrincipalId.get(session.principalId) ?? [];
            existing.push(session.sessionId);
            sessionIdsByPrincipalId.set(session.principalId, existing);
        }

        return currentRoom.members
            .map((member) => {
                const client = findClientSnapshot(member.principalId);
                const sessionIds = sessionIdsByPrincipalId.get(member.principalId) ?? [];
                return {
                    principalId: member.principalId,
                    username: client?.principal.username ?? member.principalId,
                    displayName: client?.principal.displayName,
                    role: member.role,
                    status: member.status,
                    isOwner: member.role === 'owner',
                    isOnline: sessionIds.length > 0,
                    sessionIds,
                    client,
                };
            })
            .sort((left, right) =>
                (left.displayName ?? left.username).localeCompare(
                    right.displayName ?? right.username,
                )
            );
    };

    const roomState = (): RallarRoomState => {
        const sessionId = options.readSession()?.sessionId;
        const rooms = readGroupSnapshots()
            .filter(isGroupActive)
            .sort((left, right) =>
                readGroupDisplayName(left).localeCompare(readGroupDisplayName(right))
            );
        const currentRoomRef = resolveCurrentRoomRef();
        const currentRoom = currentRoomRef
            ? findGroupSnapshot(currentRoomRef)
            : undefined;

        return {
            rooms: rooms.map((snapshot) => ({
                roomId: readGroupId(snapshot),
                roomRef: snapshot.group,
                name: readGroupDisplayName(snapshot),
                status: snapshot.group.status,
                kind: snapshot.group.kind,
                joinMode: snapshot.group.joinMode,
                memberCount: snapshot.memberCount,
                onlineMemberCount: snapshot.onlineMemberCount,
                isJoined: sessionId ? isSessionInGroup(snapshot, sessionId) : false,
                isCurrent: currentRoomRef
                    ? isSameGroupRef(snapshot.group, currentRoomRef)
                    : false,
                snapshot,
            })),
            currentRoomId: currentRoomRef?.groupId,
            currentRoomRef,
            currentRoom,
            members: toRoomMembers(currentRoom),
        };
    };

    const peopleState = (): RallarPeopleState => {
        const clients = readClientSnapshots().sort((left, right) =>
            toPersonName(left).localeCompare(toPersonName(right))
        );
        return { people: clients.map(toPerson), clients };
    };

    const emit = (): void => {
        const rooms = roomState();
        const people = peopleState();
        for (const listener of roomStateListeners) {
            notifyListener(listener, rooms);
        }
        for (const listener of peopleStateListeners) {
            notifyListener(listener, people);
        }
        for (const listener of afterEmitListeners) {
            listener();
        }
    };

    store = {
        attachCache: (): void => {
            if (!options.runtime.readStateCacheUnsubscribe()) {
                options.runtime.setStateCacheUnsubscribe(
                    stateCaches.onStateCacheChange(emit),
                );
            }
        },
        detachCache: (): void => {
            options.runtime.readStateCacheUnsubscribe()?.();
            options.runtime.setStateCacheUnsubscribe(undefined);
        },
        acceptSnapshots: async (ctx, clients, groups, scope): Promise<void> => {
            await stateCaches.hydrateStateCaches(
                ctx.middleware.webRtcGroupManager,
                toClientInfo(ctx.session),
                clients,
                groups,
                { scope },
            );
            emit();
        },
        emit,
        onAfterEmit: (listener): RallarUnsubscribe => {
            afterEmitListeners.add(listener);
            return () => afterEmitListeners.delete(listener);
        },
        roomState,
        peopleState,
        person: (principalId): RallarPerson | undefined => {
            const snapshot = findClientSnapshot(principalId);
            return snapshot ? toPerson(snapshot) : undefined;
        },
        onRoomChange: (listener, changeOptions = {}): RallarUnsubscribe => {
            roomStateListeners.add(listener);
            if (changeOptions.emitCurrent ?? true) {
                notifyListener(listener, roomState());
            }
            return () => roomStateListeners.delete(listener);
        },
        onPeopleChange: (listener, changeOptions = {}): RallarUnsubscribe => {
            peopleStateListeners.add(listener);
            if (changeOptions.emitCurrent ?? true) {
                notifyListener(listener, peopleState());
            }
            return () => peopleStateListeners.delete(listener);
        },
        resolveCurrentRoomId: () => resolveCurrentRoomRef()?.groupId,
        resolveCurrentRoomRef,
        readGroupSnapshots,
        findGroupSnapshot,
        resolveRoomMinSnapshotVersion: (room, explicitMinSnapshotVersion) => {
            const cached = findGroupSnapshot(room);
            const cachedVersion = cached ? readGroupVersion(cached) : undefined;
            if (explicitMinSnapshotVersion === undefined) {
                return cachedVersion;
            }
            return cachedVersion === undefined
                ? explicitMinSnapshotVersion
                : Math.max(explicitMinSnapshotVersion, cachedVersion);
        },
        setCurrentRoom: (snapshot): void => options.runtime.setCurrentRoom(snapshot),
        clearCurrentRoomIfMatches: (room, clearCurrent): void =>
            options.runtime.clearCurrentRoomIfMatches(room, clearCurrent),
        isSameRoomRefOrId: (left, right): boolean =>
            typeof right === 'string'
                ? left.groupId === right
                : isSameGroupRef(left, right),
        toRoomId: (room): string | undefined =>
            typeof room === 'string' ? room : room?.groupId,
        resolveRoomRef: (room): GroupRef | undefined => {
            if (!room) {
                return undefined;
            }
            if (typeof room !== 'string') {
                return room;
            }
            return resolveGroupRefFromRoomId(room) ?? findGroupSnapshot(room)?.group;
        },
        resolveGroupRefFromRoomId,
        readClientSnapshots,
        findClientSnapshot,
    };

    return store;
}

function toClientInfo(session: AuthSession): ClientInfo {
    return {
        clientId: session.clientId,
        sessionId: session.sessionId,
        isOnline: true,
    };
}

function toPerson(snapshot: ClientSnapshot): RallarPerson {
    const activeSessionIds = readActiveClientSessionIds(snapshot);

    return {
        principalId: snapshot.principal.principalId,
        username: snapshot.principal.username,
        displayName: snapshot.principal.displayName,
        isOnline: snapshot.isOnline,
        activeSessionCount: snapshot.activeSessionCount,
        activeSessionIds,
        snapshot,
    };
}

function toPersonName(snapshot: ClientSnapshot): string {
    return snapshot.principal.displayName ??
        snapshot.principal.username ??
        snapshot.principal.principalId;
}

function readRallarCacheOrDefault<T>(supplier: () => T, fallback: T): T {
    try {
        return supplier();
    } catch (error) {
        if (isUnconfiguredRallarCacheError(error)) {
            return fallback;
        }
        throw error;
    }
}

function isUnconfiguredRallarCacheError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('Repository not found: shared.repository.') ||
        message.includes('snapshot repository is not configured');
}

function isSameStateScopeValue(
    value: Pick<StateScope, 'applicationId'> & { workspaceId?: string },
    scope?: StateScope,
): boolean {
    if (!scope) {
        return true;
    }
    return value.applicationId === scope.applicationId &&
        normalizeStateWorkspaceId(value.workspaceId) ===
            normalizeStateWorkspaceId(scope.workspaceId);
}

function normalizeStateWorkspaceId(workspaceId?: string): string {
    return workspaceId ?? DEFAULT_STATE_WORKSPACE_ID;
}
