import type {
    RallarOnChangeOptions,
    RallarStateListener,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupScope, toGroupRefFromScope } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { isGroupActive, isSessionInGroup, readGroupVersion } from '@shared/api/group-client-views.ts';
import { readConfiguredValue } from '@shared/cache/RepositoryManager.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';

import type { StateCacheChangeListener } from '../state-cache/browser-state-cache-lifecycle.ts';
import type { RallarStateCacheReadPort } from '../state-cache/rallar-state-store.ts';
import type { RallarRoomState } from './rallar-room-contracts.ts';
import {
    toRallarRoomState,
    type GroupRef,
    type GroupSnapshot,
    type StateScope
} from './room-group-state-translation.ts';

/**
 * What a room send is stamped with from the sender's cached room snapshot: its version, raised to a floor the send
 * states, and its roster. Both are absent when no room snapshot is cached, except a stated floor, which stands alone.
 */
export interface RoomSendFence {
    readonly minSnapshotVersion: number | undefined;
    readonly rosterVersion: number | undefined;
}

export interface RallarRoomStateStorePort {
    state(): RallarRoomState;
    /** False means a nested publication superseded this state; stop its dependent notifications. */
    emit(state: RallarRoomState): boolean;
    onChange(
        listener: RallarStateListener<RallarRoomState>,
        options?: RallarOnChangeOptions
    ): RallarUnsubscribe;
    onCacheChange(listener: StateCacheChangeListener): RallarUnsubscribe;
    resolveCurrentRoomRef(): GroupRef | undefined;
    readGroupSnapshots(): GroupSnapshot[];
    findGroupSnapshot(room: string | GroupRef | undefined): GroupSnapshot | undefined;
    /** Whether the cache ever held the room; an expired snapshot reads as absent but stays observed. */
    wasGroupSnapshotObserved(room: string | GroupRef | undefined): boolean;
    resolveRoomSendFence(room: string | GroupRef | undefined, explicitMinSnapshotVersion?: number): RoomSendFence;
    setCurrentRoom(snapshot: GroupSnapshot): void;
    clearCurrentRoomIfMatches(room: string | GroupRef, clearCurrent: boolean): void;
    toRoomId(room: string | GroupRef | undefined): string | undefined;
    resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
    resolveGroupRefFromRoomId(roomId: string, scope?: StateScope): GroupRef | undefined;
}

export interface RallarRoomStateRuntimePort {
    currentRoomRef(): GroupRef | undefined;
    setCurrentRoom(snapshot: GroupSnapshot): void;
    clearCurrentRoomIfMatches(room: string | GroupRef, clearCurrent: boolean): void;
    readDefaultScope(): StateScope | undefined;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
}

export namespace RoomStateStore {
    export interface Input {
        readonly runtime: RallarRoomStateRuntimePort;
        readonly readSession: () => AuthSession | undefined;
        readonly stateCache: RallarStateCacheReadPort;
    }
}

/** Owns room projection and live subscriptions for one browser facade. */
export class RoomStateStore implements RallarRoomStateStorePort {
    private readonly notifications = new SynchronousNotifications<RallarRoomState>((error) => {
        console.error('Error notifying Rallar room state listener', error);
    });
    private readonly input: RoomStateStore.Input;

    constructor(input: RoomStateStore.Input) {
        this.input = input;
    }

    state(): RallarRoomState {
        const sessionId = this.input.readSession()?.sessionId;
        const currentRoomRef = this.resolveCurrentRoomRef();
        const currentRoom = this.findGroupSnapshot(currentRoomRef);
        return toRallarRoomState({
            groupSnapshots: this.readGroupSnapshots(),
            clientSnapshots: this.readCurrentRoomClientSnapshots(currentRoom),
            sessionId,
            currentRoomRef,
            currentRoom
        });
    }

    emit(state: RallarRoomState): boolean {
        return this.notifications.publishLatest(state);
    }

    onChange(
        listener: RallarStateListener<RallarRoomState>,
        options: RallarOnChangeOptions = {}
    ): RallarUnsubscribe {
        // Subscribing before a first connect is ordinary; the caches it would
        // read do not exist yet, and this delivery is a notification.
        const current = (options.emitCurrent ?? true)
            ? readConfiguredValue(() => this.state())
            : undefined;
        const subscription = current
            ? this.notifications.subscribeAndNotify(listener, current)
            : this.notifications.subscribe(listener);
        return () => subscription.unsubscribe();
    }

    onCacheChange(listener: StateCacheChangeListener): RallarUnsubscribe {
        return this.input.stateCache.onCacheChange(listener);
    }

    wasGroupSnapshotObserved(room: string | GroupRef | undefined): boolean {
        const roomRef = typeof room === 'string' ? this.resolveGroupRefFromRoomId(room) : room;
        if (!roomRef) {
            return false;
        }
        return readConfiguredValue(() => this.input.stateCache.wasGroupSnapshotObserved(roomRef)) ?? false;
    }

    resolveCurrentRoomRef(): GroupRef | undefined {
        const session = this.input.readSession();
        if (!session) {
            return undefined;
        }

        const currentRoomRef = this.input.runtime.currentRoomRef();
        const currentRoomSnapshot = this.findGroupSnapshot(currentRoomRef);
        if (
            currentRoomSnapshot &&
            isGroupActive(currentRoomSnapshot) &&
            isSessionInGroup(currentRoomSnapshot, session.sessionId)
        ) {
            return currentRoomSnapshot.group;
        }

        return this.findFirstGroupSnapshotRefForSession(session.sessionId);
    }

    readGroupSnapshots(): GroupSnapshot[] {
        return [...this.input.stateCache.readGroupSnapshots()].filter((snapshot) =>
            this.isInDefaultScope(snapshot.group)
        );
    }

    findGroupSnapshot(room: string | GroupRef | undefined): GroupSnapshot | undefined {
        if (!room) {
            return undefined;
        }
        // Reading before a first connect is ordinary; the snapshot cache does
        // not exist yet, and an absent snapshot is the honest answer.
        return readConfiguredValue(() => this.findCachedGroupSnapshot(room));
    }

    private findCachedGroupSnapshot(room: string | GroupRef): GroupSnapshot | undefined {
        if (typeof room !== 'string') {
            return this.input.stateCache.findGroupSnapshotByRef(room);
        }

        const scopedRef = this.resolveGroupRefFromRoomId(room);
        const scopedSnapshot = scopedRef
            ? this.input.stateCache.findGroupSnapshotByRef(scopedRef)
            : undefined;
        if (scopedSnapshot) {
            return scopedSnapshot;
        }

        return this.readGroupSnapshots()
            .filter((snapshot) => snapshot.group.groupId === room)
            .sort((left, right) => readGroupVersion(right) - readGroupVersion(left))
            .at(0);
    }

    resolveRoomSendFence(room: string | GroupRef | undefined, explicitMinSnapshotVersion?: number): RoomSendFence {
        const cached = this.findGroupSnapshot(room);
        const cachedVersion = cached ? readGroupVersion(cached) : undefined;
        return {
            minSnapshotVersion: cachedVersion === undefined || explicitMinSnapshotVersion === undefined
                ? cachedVersion ?? explicitMinSnapshotVersion
                : Math.max(explicitMinSnapshotVersion, cachedVersion),
            rosterVersion: cached?.group.rosterVersion
        };
    }

    setCurrentRoom(snapshot: GroupSnapshot): void {
        this.input.runtime.setCurrentRoom(snapshot);
    }

    clearCurrentRoomIfMatches(room: string | GroupRef, clearCurrent: boolean): void {
        this.input.runtime.clearCurrentRoomIfMatches(room, clearCurrent);
    }

    toRoomId(room: string | GroupRef | undefined): string | undefined {
        return typeof room === 'string' ? room : room?.groupId;
    }

    resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined {
        if (!room) {
            return undefined;
        }
        if (typeof room !== 'string') {
            return room;
        }
        return this.resolveGroupRefFromRoomId(room) ?? this.findGroupSnapshot(room)?.group;
    }

    resolveGroupRefFromRoomId(roomId: string, scope?: StateScope): GroupRef | undefined {
        return toGroupRefFromScope(roomId, this.input.runtime.resolveOperationScope(scope));
    }

    private readCurrentRoomClientSnapshots(currentRoom: GroupSnapshot | undefined): ClientSnapshot[] {
        if (!currentRoom) {
            return [];
        }
        return currentRoom.members.flatMap((member) => {
            const snapshot = this.input.stateCache.findClientSnapshot(member.principalId);
            return snapshot && this.isInDefaultScope(snapshot.principal) ? [snapshot] : [];
        });
    }

    private findFirstGroupSnapshotRefForSession(sessionId: string): GroupRef | undefined {
        const fromRepository = this.input.stateCache.findFirstGroupRefForSession(sessionId);
        if (fromRepository && this.isInDefaultScope(fromRepository)) {
            return fromRepository;
        }
        return this.readGroupSnapshots().find((snapshot) =>
            snapshot.activeSessions.some((activeSession) => activeSession.sessionId === sessionId)
        )?.group;
    }

    private isInDefaultScope(value: StateScope): boolean {
        const scope = this.input.runtime.readDefaultScope();
        return !scope || isSameGroupScope(value, scope);
    }
}
