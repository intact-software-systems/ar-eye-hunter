import type { ClientSnapshot } from '@shared/api/client-types.ts';
import {
  isGroupActive,
  isSessionInGroup,
  readGroupVersion,
} from '@shared/api/group-client-views.ts';
import { isSameGroupRef, toGroupRefFromScope } from '@shared/api/api-type-utils.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
  RallarOnChangeOptions,
  RallarStateListener,
  RallarUnsubscribe,
} from '@shared-web/browser/rallar-shared-contracts.ts';
import { notifyListener } from '@shared-web/browser/rallar-runtime/subscriptions.ts';

import type { RallarRoomState } from './rallar-room-contracts.ts';
import {
  toRallarRoomState,
  type GroupRef,
  type GroupSnapshot,
  type StateScope,
} from './room-group-state-translation.ts';

export interface RallarRoomStateStorePort {
  state(): RallarRoomState;
  emit(state: RallarRoomState): void;
  onChange(
    listener: RallarStateListener<RallarRoomState>,
    options?: RallarOnChangeOptions,
  ): RallarUnsubscribe;
  onCacheChange(listener: () => void | Promise<void>): RallarUnsubscribe;
  resolveCurrentRoomId(): string | undefined;
  resolveCurrentRoomRef(): GroupRef | undefined;
  readGroupSnapshots(): GroupSnapshot[];
  findGroupSnapshot(room: string | GroupRef | undefined): GroupSnapshot | undefined;
  resolveRoomMinSnapshotVersion(
    room: string | GroupRef | undefined,
    explicitMinSnapshotVersion?: number,
  ): number | undefined;
  setCurrentRoom(snapshot: GroupSnapshot): void;
  clearCurrentRoomIfMatches(room: string | GroupRef, clearCurrent: boolean): void;
  isSameRoomRefOrId(left: GroupRef, right: string | GroupRef): boolean;
  toRoomId(room: string | GroupRef | undefined): string | undefined;
  resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
  resolveGroupRefFromRoomId(roomId: string, scope?: StateScope): GroupRef | undefined;
}

export interface RallarRoomStateRuntimePort {
  currentRoomId(): string | undefined;
  currentRoomRef(): GroupRef | undefined;
  setCurrentRoom(snapshot: GroupSnapshot): void;
  clearCurrentRoomIfMatches(room: string | GroupRef, clearCurrent: boolean): void;
  readDefaultScope(): StateScope | undefined;
  resolveOperationScope(scope?: StateScope): StateScope | undefined;
}

export interface CreateRoomStateStoreInput {
  readonly runtime: RallarRoomStateRuntimePort;
  readonly readSession: () => AuthSession | undefined;
  readonly readCachedGroupSnapshots: () => readonly GroupSnapshot[];
  readonly findCachedGroupSnapshotByRef: (roomRef: GroupRef) => GroupSnapshot | undefined;
  readonly findFirstCachedGroupRefForSession: (sessionId: string) => GroupRef | undefined;
  readonly readCachedClientSnapshots: () => readonly ClientSnapshot[];
  readonly onCacheChange: (listener: () => void | Promise<void>) => RallarUnsubscribe;
}

export function createRoomStateStore(input: CreateRoomStateStoreInput): RallarRoomStateStorePort {
  return new RoomStateStore(input);
}

class RoomStateStore implements RallarRoomStateStorePort {
  readonly #listeners = new Set<RallarStateListener<RallarRoomState>>();
  readonly #input: CreateRoomStateStoreInput;

  constructor(input: CreateRoomStateStoreInput) {
    this.#input = input;
  }

  state(): RallarRoomState {
    const sessionId = this.#input.readSession()?.sessionId;
    const currentRoomRef = this.resolveCurrentRoomRef();
    const currentRoomSnapshot = this.findGroupSnapshot(currentRoomRef);
    return toRallarRoomState({
      snapshots: this.readGroupSnapshots(),
      clients: this.readClientSnapshots(),
      sessionId,
      currentRoomRef,
      currentRoomSnapshot,
    });
  }

  emit(state: RallarRoomState): void {
    for (const listener of this.#listeners) {
      notifyListener(listener, state);
    }
  }

  onChange(
    listener: RallarStateListener<RallarRoomState>,
    options: RallarOnChangeOptions = {},
  ): RallarUnsubscribe {
    this.#listeners.add(listener);
    if (options.emitCurrent ?? true) {
      notifyListener(listener, this.state());
    }
    return () => this.#listeners.delete(listener);
  }

  onCacheChange(listener: () => void | Promise<void>): RallarUnsubscribe {
    return this.#input.onCacheChange(listener);
  }

  resolveCurrentRoomId(): string | undefined {
    return this.resolveCurrentRoomRef()?.groupId;
  }

  resolveCurrentRoomRef(): GroupRef | undefined {
    const session = this.#input.readSession();
    if (!session) {
      return undefined;
    }

    const currentRoomRef = this.#input.runtime.currentRoomRef();
    const currentRoomSnapshot = this.findGroupSnapshot(currentRoomRef);
    if (
      currentRoomSnapshot &&
      isGroupActive(currentRoomSnapshot) &&
      isSessionInGroup(currentRoomSnapshot, session.sessionId)
    ) {
      return currentRoomSnapshot.group;
    }

    const currentRoomId = this.#input.runtime.currentRoomId();
    const legacyCurrentRoomSnapshot = this.findGroupSnapshot(currentRoomId);
    if (
      legacyCurrentRoomSnapshot &&
      isGroupActive(legacyCurrentRoomSnapshot) &&
      isSessionInGroup(legacyCurrentRoomSnapshot, session.sessionId)
    ) {
      return legacyCurrentRoomSnapshot.group;
    }

    return this.findFirstGroupSnapshotRefForSession(session.sessionId);
  }

  readGroupSnapshots(): GroupSnapshot[] {
    return [...this.#input.readCachedGroupSnapshots()].filter((snapshot) =>
      this.isInDefaultScope(snapshot.group),
    );
  }

  findGroupSnapshot(room: string | GroupRef | undefined): GroupSnapshot | undefined {
    if (!room) {
      return undefined;
    }
    if (typeof room !== 'string') {
      return this.#input.findCachedGroupSnapshotByRef(room);
    }

    const scopedRef = this.resolveGroupRefFromRoomId(room);
    const scopedSnapshot = scopedRef
      ? this.#input.findCachedGroupSnapshotByRef(scopedRef)
      : undefined;
    if (scopedSnapshot) {
      return scopedSnapshot;
    }

    return this.readGroupSnapshots()
      .filter((snapshot) => snapshot.group.groupId === room)
      .sort((left, right) => readGroupVersion(right) - readGroupVersion(left))
      .at(0);
  }

  resolveRoomMinSnapshotVersion(
    room: string | GroupRef | undefined,
    explicitMinSnapshotVersion?: number,
  ): number | undefined {
    const cached = this.findGroupSnapshot(room);
    const cachedVersion = cached ? readGroupVersion(cached) : undefined;
    if (explicitMinSnapshotVersion === undefined) {
      return cachedVersion;
    }
    return cachedVersion === undefined
      ? explicitMinSnapshotVersion
      : Math.max(explicitMinSnapshotVersion, cachedVersion);
  }

  setCurrentRoom(snapshot: GroupSnapshot): void {
    this.#input.runtime.setCurrentRoom(snapshot);
  }

  clearCurrentRoomIfMatches(room: string | GroupRef, clearCurrent: boolean): void {
    this.#input.runtime.clearCurrentRoomIfMatches(room, clearCurrent);
  }

  isSameRoomRefOrId(left: GroupRef, right: string | GroupRef): boolean {
    return typeof right === 'string' ? left.groupId === right : isSameGroupRef(left, right);
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
    return toGroupRefFromScope(roomId, this.#input.runtime.resolveOperationScope(scope));
  }

  private readClientSnapshots(): ClientSnapshot[] {
    return [...this.#input.readCachedClientSnapshots()].filter((snapshot) =>
      this.isInDefaultScope(snapshot.principal),
    );
  }

  private findFirstGroupSnapshotRefForSession(sessionId: string): GroupRef | undefined {
    const fromRepository = this.#input.findFirstCachedGroupRefForSession(sessionId);
    if (fromRepository && this.isInDefaultScope(fromRepository)) {
      return fromRepository;
    }
    return this.readGroupSnapshots().find((snapshot) =>
      snapshot.activeSessions.some((activeSession) => activeSession.sessionId === sessionId),
    )?.group;
  }

  private isInDefaultScope(
    value: Pick<StateScope, 'applicationId'> & { workspaceId?: string },
  ): boolean {
    return isSameStateScopeValue(value, this.#input.runtime.readDefaultScope());
  }
}

function isSameStateScopeValue(
  value: Pick<StateScope, 'applicationId'> & { workspaceId?: string },
  scope?: StateScope,
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
