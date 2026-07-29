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
import type {
    RallarListRoomEventsInput,
    RallarRoomEventListener,
    RallarRoomEventOptions,
    RallarRoomState,
    RallarReplayRoomEventsInput,
} from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type { RallarBrowserFacadeRuntimeContext } from '@shared-web/browser/rallar-runtime-context.ts';
import type {
    RallarOnChangeOptions,
    RallarReplayEventsResult,
    RallarStateListener,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
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
    onCacheChange(listener: () => void): RallarUnsubscribe;
    acceptSnapshots(
        ctx: ApiMiddleware,
        clients: readonly ClientSnapshot[],
        groups: readonly GroupSnapshot[],
        scope?: StateScope,
    ): Promise<void>;
    emit(): void;
    onAfterEmit(listener: () => void): RallarUnsubscribe;
    roomState(): RallarRoomState;
    peopleState(): RallarPeopleState;
    person(principalId: string): RallarPerson | undefined;
    onRoomChange(
        listener: RallarStateListener<RallarRoomState>,
        options?: RallarOnChangeOptions,
    ): RallarUnsubscribe;
    onPeopleChange(
        listener: RallarStateListener<RallarPeopleState>,
        options?: RallarOnChangeOptions,
    ): RallarUnsubscribe;
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
    readClientSnapshots(): ClientSnapshot[];
    findClientSnapshot(principalId: string): ClientSnapshot | undefined;
}>;

export type RallarStateEventsPort = Readonly<{
    listRoomEvents(input: RallarListRoomEventsInput): Promise<readonly GroupEvent[]>;
    listRoomEventPage(input: RallarListRoomEventsInput): Promise<StateEventPage<GroupEvent>>;
    replayRoomEventsInput(
        input: RallarReplayRoomEventsInput,
        listener?: RallarRoomEventListener,
    ): Promise<RallarReplayEventsResult<GroupEvent>>;
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
    onRoomEvent(
        listener: RallarRoomEventListener,
        options: RallarRoomEventOptions,
    ): RallarUnsubscribe;
    onPeopleEvent(
        listener: RallarPeopleEventListener,
        options: RallarPeopleEventOptions,
    ): RallarUnsubscribe;
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
