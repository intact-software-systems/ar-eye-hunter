import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import * as stateCaches from '@shared-web/browser/data-caches.ts';
import type { RallarPeopleState, RallarPerson } from '@shared-web/browser/rallar-people-facade.ts';
import type { RallarStatePort, RallarStateRuntimePort } from '@shared-web/browser/rallar-runtime/contracts.ts';
import { notifyListener } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import type { RallarStateListener, RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { RallarRoomStateStorePort } from '@shared-web/browser/rooms/room-state-store.ts';
import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { readActiveClientSessionIds } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

export interface CreateRallarStateStoreInput {
    readonly runtime: RallarStateRuntimePort;
    readonly roomStateStore: RallarRoomStateStorePort;
    readonly readSession: () => AuthSession | undefined;
    readonly stateCache: RallarStateCacheReadPort;
}

export interface RallarStateCacheReadPort {
    onCacheChange(listener: () => void | Promise<void>): RallarUnsubscribe;
    readGroupSnapshots(): readonly GroupSnapshot[];
    findGroupSnapshotByRef(roomRef: GroupRef): GroupSnapshot | undefined;
    findFirstGroupRefForSession(sessionId: string): GroupRef | undefined;
    readClientSnapshots(): readonly ClientSnapshot[];
    findClientSnapshot(principalId: string): ClientSnapshot | undefined;
}

export function createRallarStateCacheReadPort(): RallarStateCacheReadPort {
    return {
        onCacheChange: (listener) => stateCaches.onStateCacheChange(listener),
        readGroupSnapshots: () => groupStateSnapshotsRepository.getAllGroupStateSnapshots(),
        findGroupSnapshotByRef: (roomRef) => groupStateSnapshotsRepository.findGroupStateSnapshotByRef(roomRef),
        findFirstGroupRefForSession: (sessionId) =>
            groupStateSnapshotsRepository.findFirstGroupStateSnapshotRefSessionIdIsIn(sessionId),
        readClientSnapshots: () => clientStateSnapshotsRepository.getAllClientStateSnapshots(),
        findClientSnapshot: (principalId) =>
            clientStateSnapshotsRepository.findClientStateSnapshotByPrincipalId(principalId)
    };
}

export function createRallarStateStore(input: CreateRallarStateStoreInput): RallarStatePort {
    return new RallarStateStore(input);
}

class RallarStateStore implements RallarStatePort {
    readonly #peopleStateListeners = new Set<RallarStateListener<RallarPeopleState>>();
    readonly #afterEmitListeners = new Set<() => void>();
    readonly #input: CreateRallarStateStoreInput;

    constructor(input: CreateRallarStateStoreInput) {
        this.#input = input;
    }

    attachCache(): void {
        if (!this.#input.runtime.readStateCacheUnsubscribe()) {
            this.#input.runtime.setStateCacheUnsubscribe(
                stateCaches.onStateCacheChange(() => this.emit())
            );
        }
    }

    detachCache(): void {
        this.#input.runtime.readStateCacheUnsubscribe()?.();
        this.#input.runtime.setStateCacheUnsubscribe(undefined);
    }

    onCacheChange(listener: () => void | Promise<void>): RallarUnsubscribe {
        return this.#input.stateCache.onCacheChange(listener);
    }

    async acceptSnapshots(
        context: ApiMiddleware,
        clients: readonly ClientSnapshot[],
        groups: readonly GroupSnapshot[],
        scope?: StateScope
    ): Promise<void> {
        await stateCaches.hydrateStateCaches(
            context.middleware.webRtcGroupManager,
            toClientInfo(context.session),
            clients,
            groups,
            { scope }
        );
        this.emit();
    }

    emit(): void {
        const roomState = this.#input.roomStateStore.state();
        const peopleState = this.peopleState();
        this.#input.roomStateStore.emit(roomState);
        for (const listener of this.#peopleStateListeners) {
            notifyListener(listener, peopleState);
        }
        for (const listener of this.#afterEmitListeners) {
            listener();
        }
    }

    onAfterEmit(listener: () => void): RallarUnsubscribe {
        this.#afterEmitListeners.add(listener);
        return () => this.#afterEmitListeners.delete(listener);
    }

    roomState = (): ReturnType<RallarRoomStateStorePort['state']> => this.#input.roomStateStore.state();

    peopleState(): RallarPeopleState {
        const clients = this.readClientSnapshots().sort((left, right) =>
            toPersonName(left).localeCompare(toPersonName(right))
        );
        return { people: clients.map(toPerson), clients };
    }

    person(principalId: string): RallarPerson | undefined {
        const snapshot = this.findClientSnapshot(principalId);
        return snapshot ? toPerson(snapshot) : undefined;
    }

    onRoomChange = (...args: Parameters<RallarRoomStateStorePort['onChange']>): RallarUnsubscribe =>
        this.#input.roomStateStore.onChange(...args);

    onPeopleChange(
        listener: RallarStateListener<RallarPeopleState>,
        options: Readonly<{ emitCurrent?: boolean; }> = {}
    ): RallarUnsubscribe {
        this.#peopleStateListeners.add(listener);
        if (options.emitCurrent ?? true) {
            notifyListener(listener, this.peopleState());
        }
        return () => this.#peopleStateListeners.delete(listener);
    }

    resolveCurrentRoomRef = (): GroupRef | undefined => this.#input.roomStateStore.resolveCurrentRoomRef();

    readGroupSnapshots = (): GroupSnapshot[] => this.#input.roomStateStore.readGroupSnapshots();

    findGroupSnapshot = (room: string | GroupRef | undefined): GroupSnapshot | undefined =>
        this.#input.roomStateStore.findGroupSnapshot(room);

    resolveRoomMinSnapshotVersion = (
        room: string | GroupRef | undefined,
        explicitMinSnapshotVersion?: number
    ): number | undefined => this.#input.roomStateStore.resolveRoomMinSnapshotVersion(room, explicitMinSnapshotVersion);

    setCurrentRoom = (snapshot: GroupSnapshot): void => this.#input.roomStateStore.setCurrentRoom(snapshot);

    clearCurrentRoomIfMatches = (room: string | GroupRef, clearCurrent: boolean): void =>
        this.#input.roomStateStore.clearCurrentRoomIfMatches(room, clearCurrent);

    toRoomId = (room: string | GroupRef | undefined): string | undefined => this.#input.roomStateStore.toRoomId(room);

    resolveRoomRef = (room: string | GroupRef | undefined): GroupRef | undefined =>
        this.#input.roomStateStore.resolveRoomRef(room);

    resolveGroupRefFromRoomId = (roomId: string, scope?: StateScope): GroupRef | undefined =>
        this.#input.roomStateStore.resolveGroupRefFromRoomId(roomId, scope);

    readCachedGroupSnapshots(): readonly GroupSnapshot[] {
        return this.#input.stateCache.readGroupSnapshots();
    }

    findCachedGroupSnapshotByRef(roomRef: GroupRef): GroupSnapshot | undefined {
        return this.#input.stateCache.findGroupSnapshotByRef(roomRef);
    }

    findFirstCachedGroupRefForSession(sessionId: string): GroupRef | undefined {
        return this.#input.stateCache.findFirstGroupRefForSession(sessionId);
    }

    readCachedClientSnapshots(): readonly ClientSnapshot[] {
        return this.#input.stateCache.readClientSnapshots();
    }

    findCachedClientSnapshot(principalId: string): ClientSnapshot | undefined {
        return this.#input.stateCache.findClientSnapshot(principalId);
    }

    private readClientSnapshots(): ClientSnapshot[] {
        return [...this.readCachedClientSnapshots()].filter((snapshot) => this.isInDefaultScope(snapshot.principal));
    }

    private findClientSnapshot(principalId: string): ClientSnapshot | undefined {
        const snapshot = this.findCachedClientSnapshot(principalId);
        return snapshot && this.isInDefaultScope(snapshot.principal) ? snapshot : undefined;
    }

    private isInDefaultScope(
        value: Pick<StateScope, 'applicationId'> & { workspaceId?: string; }
    ): boolean {
        return isSameStateScopeValue(value, this.#input.runtime.readDefaultScope());
    }
}

function toClientInfo(session: AuthSession): ClientInfo {
    return {
        clientId: session.clientId,
        sessionId: session.sessionId,
        isOnline: true
    };
}

function toPerson(snapshot: ClientSnapshot): RallarPerson {
    return {
        principalId: snapshot.principal.principalId,
        username: snapshot.principal.username,
        displayName: snapshot.principal.displayName ?? undefined,
        isOnline: snapshot.isOnline,
        activeSessionCount: snapshot.activeSessionCount,
        activeSessionIds: readActiveClientSessionIds(snapshot),
        snapshot
    };
}

function toPersonName(snapshot: ClientSnapshot): string {
    return (
        snapshot.principal.displayName ?? snapshot.principal.username ?? snapshot.principal.principalId
    );
}

function isSameStateScopeValue(
    value: Pick<StateScope, 'applicationId'> & { workspaceId?: string; },
    scope?: StateScope
): boolean {
    if (!scope) {
        return true;
    }
    return (
        value.applicationId === scope.applicationId &&
        normalizeStateWorkspaceId(value.workspaceId) === normalizeStateWorkspaceId(scope.workspaceId)
    );
}

function normalizeStateWorkspaceId(workspaceId?: string): string {
    return workspaceId ?? DEFAULT_STATE_WORKSPACE_ID;
}
