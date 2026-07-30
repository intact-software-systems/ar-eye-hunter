import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type {
  CreateRallarMediaFacadeOptions,
  RallarMediaSourceKind,
  RallarMediaSourceStatus,
} from '@shared-web/browser/rallar-media-facade.ts';
import type {
  RallarListPeopleEventsOptions,
  RallarPeopleEventListener,
  RallarPeopleEventOptions,
  RallarPeopleState,
  RallarPerson,
  RallarReplayPeopleEventsOptions,
} from '@shared-web/browser/rallar-people-facade.ts';
import type { RallarRoomStateStorePort } from '@shared-web/browser/rooms/room-state-store.ts';
import type { RallarBrowserFacadeRuntimeContext } from '@shared-web/browser/rallar-runtime-context.ts';
import type {
  RallarOnChangeOptions,
  RallarReplayEventsResult,
  RallarStateListener,
  RallarUnsubscribe,
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export type RallarConnectionRuntimePort = Pick<
  RallarBrowserFacadeRuntimeContext,
  | 'readConnectState'
  | 'setConnectState'
  | 'readMiddleware'
  | 'setMiddleware'
  | 'requireMiddleware'
  | 'clearMiddleware'
  | 'readConnectPromise'
  | 'setConnectPromise'
  | 'setDefaults'
  | 'defaults'
  | 'readDefaults'
  | 'readDefaultScope'
  | 'resolveOperationScope'
  | 'resolveOperationOptions'
>;

export type RallarStateRuntimePort = Pick<
  RallarBrowserFacadeRuntimeContext,
  | 'readStateCacheUnsubscribe'
  | 'setStateCacheUnsubscribe'
  | 'currentRoomId'
  | 'currentRoomRef'
  | 'setCurrentRoom'
  | 'clearCurrentRoom'
  | 'clearCurrentRoomIfMatches'
  | 'readDefaultScope'
  | 'resolveOperationScope'
>;

export type RallarAuthRuntimePort = Pick<
  RallarBrowserFacadeRuntimeContext,
  | 'readAuthExpiryTimer'
  | 'setAuthExpiryTimer'
  | 'clearAuthExpiryTimer'
  | 'readAuthEndPromise'
  | 'setAuthEndPromise'
  | 'endedAuthSessionKeys'
>;

export type RallarStatePort = Readonly<{
  attachCache(): void;
  detachCache(): void;
  onCacheChange(listener: () => void | Promise<void>): RallarUnsubscribe;
  acceptSnapshots(
    ctx: ApiMiddleware,
    clients: readonly ClientSnapshot[],
    groups: readonly GroupSnapshot[],
    scope?: StateScope,
  ): Promise<void>;
  emit(): void;
  onAfterEmit(listener: () => void): RallarUnsubscribe;
  roomState: RallarRoomStateStorePort['state'];
  peopleState(): RallarPeopleState;
  person(principalId: string): RallarPerson | undefined;
  onRoomChange: RallarRoomStateStorePort['onChange'];
  onPeopleChange(
    listener: RallarStateListener<RallarPeopleState>,
    options?: RallarOnChangeOptions,
  ): RallarUnsubscribe;
  readCachedGroupSnapshots(): readonly GroupSnapshot[];
  findCachedGroupSnapshotByRef(roomRef: GroupRef): GroupSnapshot | undefined;
  findFirstCachedGroupRefForSession(sessionId: string): GroupRef | undefined;
  readCachedClientSnapshots(): readonly ClientSnapshot[];
  findCachedClientSnapshot(principalId: string): ClientSnapshot | undefined;
}> &
  Pick<
    RallarRoomStateStorePort,
    | 'resolveCurrentRoomRef'
    | 'readGroupSnapshots'
    | 'findGroupSnapshot'
    | 'resolveRoomMinSnapshotVersion'
    | 'setCurrentRoom'
    | 'clearCurrentRoomIfMatches'
    | 'toRoomId'
    | 'resolveRoomRef'
    | 'resolveGroupRefFromRoomId'
  >;

export type RallarStateEventsPort = Readonly<{
  listPeopleEvents(
    principalId: string,
    options?: RallarListPeopleEventsOptions,
  ): Promise<readonly ClientEvent[]>;
  listPeopleEventPage(
    principalId: string,
    options?: RallarListPeopleEventsOptions,
  ): Promise<StateEventPage<ClientEvent>>;
  replayPeopleEventsFromFacade(
    principalId: string,
    options?: RallarReplayPeopleEventsOptions,
    listener?: RallarPeopleEventListener,
  ): Promise<RallarReplayEventsResult<ClientEvent>>;
  onPeopleEvent(
    listener: RallarPeopleEventListener,
    options: RallarPeopleEventOptions,
  ): RallarUnsubscribe;
  retainRoomEventSubscription(): RallarUnsubscribe;
}>;

export type RallarMediaPort = Readonly<{
  operations: CreateRallarMediaFacadeOptions;
  readSourceStatus(kind: RallarMediaSourceKind): RallarMediaSourceStatus | undefined;
  readSourceStatuses(): readonly RallarMediaSourceStatus[];
  attachRemoteStreamCallback(): void;
  detachRemoteStreamCallback(ctx?: ApiMiddleware): void;
  stopForDisconnect(ctx?: ApiMiddleware): void;
}>;

export type RallarLifecycleParticipant = Readonly<{
  id: string;
  order: number;
  attach?(ctx: ApiMiddleware): void;
  connected?(): void;
  detach?(ctx?: ApiMiddleware): void;
  disconnected?(): void;
}>;

export type RallarLifecycleCoordinator = Readonly<{
  register(participant: RallarLifecycleParticipant): void;
  attach(ctx: ApiMiddleware): void;
  connected(): void;
  detach(ctx?: ApiMiddleware): void;
  disconnected(): void;
}>;
