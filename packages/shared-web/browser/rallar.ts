import {
    type ALAckMode,
    type ALMessage,
    newALBroadcastMessage,
    newALMulticastMessage,
    newALRoute,
    newALUnicastMessage,
    toALGroupTargetKey,
} from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueResult, ALOutboundEnqueueStatus, } from '@shared/alm/ALOutboundMessageRuntime.ts';
import {
    type AuthSession,
    type ClientInfo,
    type LoginRequest,
    type LoginResponse,
    type RegisterRequest,
    type RegisterResponse,
    AppTopics,
} from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { clearSession, isLoggedIn, readSession, writeSession, } from '@shared/api/auth.ts';
import type {
    ClientEvent,
    ClientEventType,
    ClientSnapshot,
} from '@shared/api/client-types.ts';
import {
    isGroupActive,
    isSessionInGroup,
    readActiveClientSessionIds,
    readGroupDisplayName,
    readGroupId,
    readGroupVersion,
} from '@shared/api/group-client-views.ts';
import {
    createRallarGroupDirectorAppointment,
    DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS,
    isRallarGroupDirectorForSession,
    isRallarGroupDirectorSessionActive,
    mergeRallarGroupDirectorMetadata,
    readRallarGroupDirectorFreshness,
    readRallarGroupDirectorFromSnapshot,
    type RallarGroupDirectorAppointment,
    type RallarGroupDirectorFreshness,
} from '@shared/api/group-director.ts';
import type {
    ApplicationId,
    GroupJoinMode,
    GroupMemberStatus,
    GroupEvent,
    GroupEventType,
    GroupRef,
    GroupRole,
    GroupSnapshot,
    GroupStatus,
    WorkspaceId,
} from '@shared/api/group-types.ts';
import {
    DEFAULT_STATE_WORKSPACE_ID,
    type StateScope,
} from '@shared/api/state-types.ts';
import type {
    StateEventCursor,
    StateEventPage,
} from '@shared/api/state-event-types.ts';
import { Command, type CommandOptions } from '@shared/cache/Command.ts';
import { CommandsOrchestrator, type CommandsOrchestratorPolicies, } from '@shared/cache/CommandsOrchestrator.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import type { QRtcMediaPolicy } from '@shared/webrtc/QRtcPeerConnection.ts';
import type { QRtcClientCallbacks } from '@shared/webrtc/QRtcClientCallbacks.ts';
import type { WebSocketClientCallbacks } from '@shared/websocket/JsonWebSocketClient.ts';
import type {
    RtcDataChannelHealth,
    RtcDataChannelSendOptions,
    RtcDataChannelSendResult,
} from '@shared/webrtc/QRtcDataChannel.ts';
import {
    DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
    type QRtcPeerDto,
    type RtcDataChannelLaneConfig,
    type WebRtcPeerLaneOpenResult,
} from '@shared/services/WebRtcConnectionService.ts';
import {
    type ApiMiddleware,
    clearMiddleware,
    getMiddleware,
    initMiddleware,
    isMiddlewareReady,
} from '@shared-web/browser/app-context.ts';
import {
    configureApiClient,
    normalizeApiBaseUrl,
    type RallarApiClientConfig,
    readApiBaseUrl,
} from '@shared-web/browser/api-client-config.ts';
import * as api from '@shared-web/browser/api-integration.ts';
import * as apiWorkflows from '@shared-web/browser/api-workflows.ts';
import * as stateCaches from '@shared-web/browser/data-caches.ts';
import {
    createRallarDataFacade,
    type RallarDataFacade,
    type RallarDataScope,
} from '@shared-web/browser/rallar-data.ts';
import {
    createRallarCrdtFacade,
    type RallarCrdtFacade,
} from '@shared-web/browser/rallar-crdt.ts';
import type { RallarCrdtMessageTransport } from '@shared-web/browser/rallar-crdt-transport.ts';
import { isSameGroupRef, toGroupRefFromScope, toStateScope } from '@shared/api/api-type-utils.ts';

export {
    createRallarDataFacade,
    defineRallarDataStore,
} from '@shared-web/browser/rallar-data.ts';

export {
    createRallarCrdtFacade,
} from '@shared-web/browser/rallar-crdt.ts';

export type {
    RallarCrdtDocument,
    RallarCrdtFacade,
    RallarCrdtFacadeDefaults,
    RallarCrdtOpenOptions,
    RallarCrdtOpenScope,
    RallarCrdtSnapshotListener,
} from '@shared-web/browser/rallar-crdt.ts';

export type {
    RallarDataChangeEvent,
    RallarDataChangeListener,
    RallarDataDurability,
    RallarDataFacade,
    RallarDataHydration,
    RallarDataMigration,
    RallarDataMigrationContext,
    RallarDataScope,
    RallarDataStorageEstimate,
    RallarDataStore,
    RallarDataStoreDefinition,
    RallarDataStoreOptions,
} from '@shared-web/browser/rallar-data.ts';

const RALLAR_REMOTE_STREAM_CALLBACK_ID = 'rallar:remote-stream';
const RALLAR_WS_ANY_MESSAGE_CALLBACK_ID = 'rallar:ws:any-message';
const RALLAR_REALTIME_LIFECYCLE_CALLBACK_ID = 'rallar:realtime:lifecycle';
const RALLAR_RTC_STATUS_CALLBACK_ID = 'rallar:rtc:status';
const RALLAR_WS_STATUS_CALLBACK_ID = 'rallar:ws:status';
const RALLAR_CALL_SIGNAL_TOPIC_ID = 'app.rallar.calls';
const RALLAR_DIRECTOR_DEFAULT_TOPIC_ID = 'app.rallar.director';
const RALLAR_DIRECTOR_RELAY_PROTOCOL = 'rallar.director.relay.v1';
const RALLAR_CALL_INVITE_TYPE_ID = 'app.rallar.calls.invite.v1';
const RALLAR_CALL_ACCEPT_TYPE_ID = 'app.rallar.calls.accept.v1';
const RALLAR_CALL_DECLINE_TYPE_ID = 'app.rallar.calls.decline.v1';
const RALLAR_CALL_CANCEL_TYPE_ID = 'app.rallar.calls.cancel.v1';
const DEFAULT_RALLAR_REALTIME_LANE_ID = 'realtime';
const DEFAULT_RALLAR_REALTIME_OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_RALLAR_WAIT_FOR_OPEN_TIMEOUT_MS = 5_000;
const MAX_RALLAR_STATE_EVENT_DEDUPE_KEYS = 1_000;
const DEFAULT_RALLAR_REPLAY_MAX_PAGES = 1;
const MAX_RALLAR_REPLAY_MAX_PAGES = 50;

export type RallarUnsubscribe = () => void;

export type RallarStateListener<T> = (state: T) => void | Promise<void>;

export type RallarConnectStatus = 'idle' | 'connecting' | 'connected';

export type RallarFlow<K, V> = CommandsOrchestrator<K, V>;

export type RallarFlowPolicies<V> = CommandsOrchestratorPolicies<V>;

export type RallarDefaults = Readonly<{
    applicationId: ApplicationId;
    workspaceId?: WorkspaceId;
    room?: Readonly<{
        roomId?: string;
        roomRef?: GroupRef;
    }>;
    realtime?: Readonly<{
        laneId?: string;
        openTimeoutMs?: number;
    }>;
    rtc?: Readonly<{
        waitTimeoutMs?: number;
        connectOnWait?: boolean;
        dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    }>;
    operations?: Readonly<{
        timeoutMs?: number;
        maxAttempts?: number;
        shouldRetry?: RallarOperationRetryPredicate;
    }>;
}>;

export type RallarOperationRetryPredicate = (
    error: unknown,
    attempt: number,
) => boolean;

export type RallarOperationOptions = Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
    maxAttempts?: number;
    shouldRetry?: RallarOperationRetryPredicate;
    dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
}>;

export type RallarRegisterOptions =
    & RallarOperationOptions
    & Readonly<{
    adminSession?: AuthSession | null;
}>;

export type RallarScopedOperationOptions =
    & RallarOperationOptions
    & Readonly<{
    scope?: StateScope;
}>;

export type RallarRefreshOptions = RallarScopedOperationOptions;

export type RallarStartOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    restoreSession?: boolean;
    connect?: boolean;
    refreshRooms?: boolean;
    refreshPeople?: boolean;
}>;

export type RallarStartResult = Readonly<{
    session?: AuthSession;
    connected: boolean;
    middleware?: ApiMiddleware;
    roomState?: RallarRoomState;
    peopleState?: RallarPeopleState;
}>;

export type RallarSubscriptionScope = Readonly<{
    add(unsubscribe?: RallarUnsubscribe | null): RallarSubscriptionScope;
    unsubscribe(): void;
    size(): number;
}>;

type RallarMessageSubscription = Readonly<{
    selector: RallarMessageSelector;
    listeners: Set<RallarMessageHandler<unknown>>;
}>;

type RallarRoomEventSubscription = Readonly<{
    listener: RallarRoomEventListener;
    options: RallarRoomEventOptions;
}>;

type RallarPeopleEventSubscription = Readonly<{
    listener: RallarPeopleEventListener;
    options: RallarPeopleEventOptions;
}>;

export type RallarRoomSummary = Readonly<{
    roomId: string;
    roomRef: GroupRef;
    name: string;
    status: GroupStatus;
    kind: GroupSnapshot['group']['kind'];
    joinMode: GroupJoinMode;
    memberCount: number;
    onlineMemberCount: number;
    isJoined: boolean;
    isCurrent: boolean;
    snapshot: GroupSnapshot;
}>;

export type RallarRoomMember = Readonly<{
    principalId: string;
    username: string;
    displayName?: string;
    role: GroupRole;
    status: GroupMemberStatus;
    isOwner: boolean;
    isOnline: boolean;
    sessionIds: readonly string[];
    client?: ClientSnapshot;
}>;

export type RallarRoomState = Readonly<{
    rooms: readonly RallarRoomSummary[];
    currentRoomId?: string;
    currentRoomRef?: GroupRef;
    currentRoom?: GroupSnapshot;
    members: readonly RallarRoomMember[];
}>;

export type RallarPerson = Readonly<{
    principalId: string;
    username: string;
    displayName?: string;
    isOnline: boolean;
    activeSessionCount: number;
    activeSessionIds: readonly string[];
    snapshot: ClientSnapshot;
}>;

export type RallarPeopleState = Readonly<{
    people: readonly RallarPerson[];
    clients: readonly ClientSnapshot[];
}>;

export type RallarCreateRoomInput =
    & RallarScopedOperationOptions
    & Readonly<{
    groupId?: string;
    displayName: string;
}>;

export type RallarJoinRoomOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    leaveCurrent?: boolean;
}>;

export type RallarLeaveRoomOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    roomId?: string;
    roomRef?: GroupRef;
    clearCurrent?: boolean;
}>;

export type RallarOnChangeOptions = Readonly<{
    emitCurrent?: boolean;
}>;

export type RallarRoomEventOptions = Readonly<{
    scope?: StateScope;
    roomId?: string;
    roomRef?: GroupRef;
    eventTypes?: readonly GroupEventType[];
}>;

export type RallarPeopleEventOptions = Readonly<{
    scope?: StateScope;
    principalId?: string;
    eventTypes?: readonly ClientEventType[];
}>;

export type RallarListRoomEventsOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    roomId?: string;
    roomRef?: GroupRef;
    eventTypes?: readonly GroupEventType[];
    limit?: number;
    after?: StateEventCursor;
}>;

export type RallarListRoomEventsInput = string | RallarListRoomEventsOptions;

export type RallarReplayEventsResult<TEvent> = Readonly<{
    events: readonly TEvent[];
    nextCursor?: StateEventCursor;
    hasMore: boolean;
    pageCount: number;
    replayedCount: number;
    duplicateCount: number;
}>;

export type RallarReplayRoomEventsOptions =
    & RallarListRoomEventsOptions
    & Readonly<{
    maxPages?: number;
    listener?: RallarRoomEventListener;
}>;

export type RallarReplayRoomEventsInput =
    | string
    | RallarReplayRoomEventsOptions;

export type RallarListPeopleEventsOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    eventTypes?: readonly ClientEventType[];
    limit?: number;
    after?: StateEventCursor;
}>;

export type RallarReplayPeopleEventsOptions =
    & RallarListPeopleEventsOptions
    & Readonly<{
    maxPages?: number;
    listener?: RallarPeopleEventListener;
}>;

export type RallarWaitForOpenStatus =
    | 'open'
    | 'timeout'
    | 'aborted'
    | 'not-connected'
    | 'closed'
    | 'no-peer'
    | 'no-lane'
    | 'failed';

export type RallarWaitForOpenOptions = Readonly<{
    timeoutMs?: number;
    signal?: AbortSignal;
}>;

export type RallarRtcWaitForOpenOptions =
    & RallarWaitForOpenOptions
    & Readonly<{
    laneId?: string;
    connect?: boolean;
}>;

export type RallarRtcRoomLaneWaitOptions =
    & RallarWaitForOpenOptions
    & Readonly<{
    connect?: boolean;
    roomRef?: GroupRef;
}>;

export type RallarRtcRoomLaneWaitStatus =
    | 'open'
    | 'partial'
    | 'not-ready'
    | 'empty'
    | 'not-connected'
    | 'timeout'
    | 'aborted'
    | 'failed';

export type RallarRtcRoomMode = 'off' | 'lazy' | 'warm' | 'eager';

export type RallarRoomTransportState =
    | 'off'
    | 'idle'
    | 'connecting'
    | 'partial'
    | 'open'
    | 'degraded'
    | 'failed';

export type RallarRoomTransportStatus = Readonly<{
    roomRef?: GroupRef;
    roomId?: string;
    ws: RallarWsStatus;
    rtc: Readonly<{
        desired: boolean;
        mode: RallarRtcRoomMode;
        state: RallarRoomTransportState;
        desiredPeerIds: readonly string[];
        knownPeerIds: readonly string[];
        activePeerIds: readonly string[];
        readyPeerIds: readonly string[];
        failedPeerIds: readonly string[];
        laneId: string;
        lastChangedAtEpochMs?: number;
        reason?: string;
    }>;
}>;

export type RallarRtcRoomTransportOptions =
    & RallarWaitForOpenOptions
    & Readonly<{
    laneId?: string;
    mode?: RallarRtcRoomMode;
    minReadyPeers?: number;
    connect?: boolean;
}>;

export type RallarTypedMessageSendStrategy =
    | 'ws'
    | 'rtc'
    | 'realtime'
    | 'ws-then-rtc'
    | 'rtc-with-ws-fallback';

export type RallarMessageTransport = 'rtc' | 'ws' | 'replay';

export type RallarMessage<T = unknown> = Readonly<{
    transport: RallarMessageTransport;
    typeId: string;
    topicId: string;
    contextId: string;
    resourceId: string;
    roomId?: string;
    senderId: string;
    payload: T;
    raw: ALMessage;
    receivedAtEpochMs: number;
}>;

export type RallarMessageHandler<T = unknown> = (
    message: RallarMessage<T>,
) => void | Promise<void>;

export type RallarStateEventListener<TEvent> = (
    event: TEvent,
    message: RallarMessage<TEvent>,
) => void | Promise<void>;

export type RallarRoomEventListener = RallarStateEventListener<GroupEvent>;

export type RallarPeopleEventListener = RallarStateEventListener<ClientEvent>;

export type RallarMessageSelector = Readonly<{
    topicId?: string;
    typeId?: string;
}>;

export type RallarMessageSelectorInput = string | RallarMessageSelector;

export type RallarMessageSendBase<T> = Readonly<{
    typeId: string;
    payload: T;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    ttlHops?: number;
    ttlMs?: number;
    reliability?: 'best-effort' | 'at-least-once';
    ack?: ALAckMode;
    ownership?: 'shared' | 'exclusive';
}>;

export type RallarRtcSendInput<T> =
    & RallarMessageSendBase<T>
    & Readonly<{
    roomId?: string;
    roomRef?: GroupRef;
    membershipEpoch?: number;
    minSnapshotVersion?: number;
    seq?: number;
    orderingKey?: string;
    nextHopPeerIds?: readonly string[];
    overlayId?: string;
    fanoutLimit?: number;
}>;

export type RallarWsSendInput<T> =
    & RallarMessageSendBase<T>
    & Readonly<{
    scope?: 'room' | 'world' | 'all';
    roomId?: string;
    roomRef?: GroupRef;
    minSnapshotVersion?: number;
    exceptPeerIds?: readonly string[];
}>;

export type RallarMessageSendStatus = ALOutboundEnqueueStatus;

export type RallarMessageSendResult = Readonly<{
    transport: RallarMessageTransport;
    status: RallarMessageSendStatus;
    message: ALMessage;
    entry?: ResourceEntry;
    entries: readonly ResourceEntry[];
    reason?: string;
}>;

export type RallarMessageLane<TSendInput, TSelector = string> = Readonly<{
    send<T>(
        input: TSendInput & RallarMessageSendBase<T>,
    ): Promise<RallarMessageSendResult>;
    onMessage<T = unknown>(
        selector: TSelector,
        handler: RallarMessageHandler<T>,
    ): RallarUnsubscribe;
}>;

export type RallarTypedMessageChannelDefinition = Readonly<{
    topicId?: string;
    typeId: string;
}>;

export type RallarTypedPayloadHandler<T> = (
    payload: T,
    message: RallarMessage<T>,
) => void | Promise<void>;

export type RallarTypedRtcSendOptions<T> = Omit<
    RallarRtcSendInput<T>,
    'topicId' | 'typeId' | 'payload'
>;

export type RallarTypedWsSendOptions<T> = Omit<
    RallarWsSendInput<T>,
    'topicId' | 'typeId' | 'payload'
>;

export type RallarTypedMessageSendOptions<T> =
    & Partial<RallarTypedRtcSendOptions<T>>
    & Partial<RallarTypedWsSendOptions<T>>
    & Readonly<{
    strategy?: RallarTypedMessageSendStrategy;
}>;

export type RallarTypedMessageChannel<T> = Readonly<{
    send(
        payload: T,
        options?: RallarTypedMessageSendOptions<T>,
    ): Promise<RallarMessageSendResult>;
    sendRtc(
        payload: T,
        options?: RallarTypedRtcSendOptions<T>,
    ): Promise<RallarMessageSendResult>;
    sendWs(
        payload: T,
        options?: RallarTypedWsSendOptions<T>,
    ): Promise<RallarMessageSendResult>;
    onRtc(handler: RallarTypedPayloadHandler<T>): RallarUnsubscribe;
    onWs(handler: RallarTypedPayloadHandler<T>): RallarUnsubscribe;
}>;

export type RallarRemoteStream = Readonly<{
    peerId: string;
    stream: MediaStream;
    event: RTCTrackEvent;
}>;

export type RallarMediaSourceKind = 'microphone' | 'camera' | 'screen';

export type RallarMediaSourceState = 'open' | 'ended' | 'failed';

export type RallarMediaSourceStatus = Readonly<{
    kind: RallarMediaSourceKind;
    state: RallarMediaSourceState;
    streamId?: string;
    trackIds: readonly string[];
    audioTrackIds: readonly string[];
    videoTrackIds: readonly string[];
    enabledTrackIds: readonly string[];
    endedTrackIds: readonly string[];
    error?: string;
}>;

export type RallarMediaSourceHandle = Readonly<{
    kind: RallarMediaSourceKind;
    stream: MediaStream;
    status(): RallarMediaSourceStatus;
    attach(): Promise<RallarMediaSourceStatus>;
    setEnabled(enabled: boolean): Promise<RallarMediaSourceStatus>;
    stop(): Promise<RallarMediaSourceStatus>;
}>;

export type RallarMediaSourceAttachOptions = Readonly<{
    attach?: boolean;
}>;

export type RallarMicrophoneSourceStartOptions =
    & RallarMediaSourceAttachOptions
    & Readonly<{
    stream?: MediaStream;
    audio?: boolean | MediaTrackConstraints;
}>;

export type RallarCameraSourceStartOptions =
    & RallarMediaSourceAttachOptions
    & Readonly<{
    stream?: MediaStream;
    video?: boolean | MediaTrackConstraints;
}>;

export type RallarScreenSourceStartOptions =
    & RallarMediaSourceAttachOptions
    & Readonly<{
    stream?: MediaStream;
    video?: boolean | MediaTrackConstraints;
    audio?: boolean | MediaTrackConstraints;
}>;

export type RallarMediaSourceController<TOptions> = Readonly<{
    start(options?: TOptions): Promise<RallarMediaSourceHandle>;
    status(): RallarMediaSourceStatus | undefined;
    stop(): Promise<RallarMediaSourceStatus | undefined>;
}>;

export type RallarMediaSourcesFacade = Readonly<{
    microphone: RallarMediaSourceController<RallarMicrophoneSourceStartOptions>;
    camera: RallarMediaSourceController<RallarCameraSourceStartOptions>;
    screen: RallarMediaSourceController<RallarScreenSourceStartOptions>;
}>;

export type RallarRealtimeSendOptions =
    & RtcDataChannelSendOptions
    & Readonly<{
    laneId?: string;
    roomId?: string;
    roomRef?: GroupRef;
    peerIds?: readonly string[];
    openTimeoutMs?: number;
}>;

export type RallarRealtimeJsonSendInput<T> =
    & RallarRealtimeSendOptions
    & Readonly<{
    data: T;
}>;

export type RallarRealtimeBinarySendInput =
    & RallarRealtimeSendOptions
    & Readonly<{
    data: ArrayBuffer | ArrayBufferView<ArrayBuffer>;
}>;

export type RallarRealtimeSendResult = Readonly<{
    peerId: string;
    laneId: string;
    result: RtcDataChannelSendResult;
}>;

export type RallarRealtimeJsonLaneDefaults = RallarRealtimeSendOptions;

export type RallarRealtimeJsonLaneSendOptions<T> = Omit<
    RallarRealtimeJsonSendInput<T>,
    'data'
>;

export type RallarRealtimeJsonLane<T> = Readonly<{
    send(
        data: T,
        options?: RallarRealtimeJsonLaneSendOptions<T>,
    ): Promise<readonly RallarRealtimeSendResult[]>;
    on(handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
}>;

export type RallarTargetMembership = 'fixed' | 'live';

export type RallarTargetSelector = Readonly<{
    peerId?: string;
    peerIds?: readonly string[];
    roomId?: string;
    roomRef?: GroupRef;
    membership?: RallarTargetMembership;
}>;

export type RallarTargetedChannelDefinition =
    & RallarTargetSelector
    & Readonly<{
    laneId?: string;
    openTimeoutMs?: number;
}>;

export type RallarTargetedChannelSendOptions<T> =
    & RallarRealtimeJsonLaneSendOptions<T>
    & RallarTargetSelector;

export type RallarTargetedSendStatus =
    | 'sent'
    | 'partial'
    | 'no-targets'
    | 'failed';

export type RallarTargetedSendResult = Readonly<{
    transport: 'rtc';
    status: RallarTargetedSendStatus;
    laneId: string;
    peerIds: readonly string[];
    results: readonly RallarRealtimeSendResult[];
    reason?: string;
}>;

export type RallarTargetedChannel<T> = Readonly<{
    send(
        data: T,
        options?: RallarTargetedChannelSendOptions<T>,
    ): Promise<RallarTargetedSendResult>;
    on(handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
    peerIds(options?: RallarTargetSelector): readonly string[];
}>;

export type RallarRealtimeMessage<T> = Readonly<{
    peerId: string;
    laneId: string;
    data: T;
    event: MessageEvent;
    receivedAtEpochMs: number;
}>;

export type RallarRealtimeHandler<T> = (
    message: RallarRealtimeMessage<T>,
) => void | Promise<void>;

export type RallarRealtimeHealthOptions = Readonly<{
    peerIds?: readonly string[];
    laneIds?: readonly string[];
}>;

export type RallarRealtimeLaneHealth = Readonly<{
    peerId: string;
    laneId: string;
    channel?: RtcDataChannelHealth;
}>;

export type RallarRtcStatusOptions = Readonly<{
    laneId?: string;
}>;

export type RallarRtcStatusSubscriptionOptions =
    & RallarRtcStatusOptions
    & RallarOnChangeOptions;

export type RallarRtcStatusListener = (
    status: RallarRtcStatus,
) => void | Promise<void>;

export type RallarRtcLifecycleKind =
    | 'snapshot'
    | 'connected'
    | 'disconnected'
    | 'peer-created'
    | 'peer-deleted'
    | 'peer-timeout'
    | 'lane-open'
    | 'lane-close'
    | 'lane-error';

export type RallarRtcLifecycleEvent = Readonly<{
    kind: RallarRtcLifecycleKind;
    atEpochMs: number;
    status: RallarRtcStatus;
    peerId?: string;
    laneId?: string;
    peer?: RallarRtcPeerStatus;
    lane?: RallarRtcLaneStatus;
}>;

export type RallarRtcLifecycleListener = (
    event: RallarRtcLifecycleEvent,
) => void | Promise<void>;

export type RallarRtcPeerConnectionStatus = Readonly<{
    state?: string;
    connectionState?: string;
    iceConnectionState?: string;
    iceGatheringState?: string;
    signalingState?: string;
    hasLocalDescription: boolean;
    hasRemoteDescription: boolean;
    canTrickleIceCandidates?: boolean | null;
    reconnectAttempts: number;
    reconnecting: boolean;
    disconnectPending: boolean;
    makingOffer: boolean;
    ignoreOffer: boolean;
    iceCandidateQueueSize: number;
    localStreamId?: string;
    remoteStreamIds: readonly string[];
}>;

export type RallarRtcLaneStatus = Readonly<{
    peerId: string;
    laneId: string;
    channel?: RtcDataChannelHealth;
    isOpen: boolean;
    isReconnectable: boolean;
}>;

export type RallarRtcPeerStatus = Readonly<{
    peerId: string;
    connection: RallarRtcPeerConnectionStatus;
    lanes: readonly RallarRtcLaneStatus[];
    isActive: boolean;
    hasNoReconnectableLanes: boolean;
    isRoutable: boolean;
    readyLaneIds: readonly string[];
}>;

export type RallarRtcStatus = Readonly<{
    sessionId?: string;
    laneId: string;
    knownPeerIds: readonly string[];
    activePeerIds: readonly string[];
    peerIdsWithNoReconnectableLanes: readonly string[];
    readyPeerIds: readonly string[];
    peers: readonly RallarRtcPeerStatus[];
}>;

export type RallarRtcDiagnosticsOptions = Readonly<{
    peerIds?: readonly string[];
    laneIds?: readonly string[];
}>;

export type RallarRtcCandidateDiagnostics = Readonly<{
    id?: string;
    candidateType?: string;
    protocol?: string;
    address?: string;
    ip?: string;
    port?: number;
    relayProtocol?: string;
    networkType?: string;
    url?: string;
}>;

export type RallarRtcCandidatePairDiagnostics = Readonly<{
    id?: string;
    state?: string;
    nominated?: boolean;
    selected?: boolean;
    currentRoundTripTime?: number;
    availableOutgoingBitrate?: number;
    bytesSent?: number;
    bytesReceived?: number;
    local?: RallarRtcCandidateDiagnostics;
    remote?: RallarRtcCandidateDiagnostics;
    usesRelay: boolean;
}>;

export type RallarRtcPeerDiagnostics = Readonly<{
    peerId: string;
    connection: RallarRtcPeerConnectionStatus;
    lanes: readonly RallarRtcLaneStatus[];
    selectedCandidatePair?: RallarRtcCandidatePairDiagnostics;
    usesRelay: boolean;
    statsAvailable: boolean;
    statsError?: string;
}>;

export type RallarRtcDiagnostics = Readonly<{
    sessionId?: string;
    generatedAtEpochMs: number;
    peerCount: number;
    connectedPeerCount: number;
    relayPeerCount: number;
    peers: readonly RallarRtcPeerDiagnostics[];
}>;

export type RallarRtcRecoveryStatus =
    | 'started'
    | 'restarted'
    | 'no-peer'
    | 'not-connected'
    | 'unsupported'
    | 'failed';

export type RallarRtcRecoveryResult = Readonly<{
    peerId: string;
    action: 'restart-ice' | 'reconnect';
    status: RallarRtcRecoveryStatus;
    rtcStatus: RallarRtcStatus;
    reason?: string;
}>;

export type RallarRtcReconnectOptions =
    & RallarWaitForOpenOptions
    & Readonly<{
    laneId?: string;
}>;

export type RallarWsReadyState =
    | 'missing'
    | 'connecting'
    | 'open'
    | 'closing'
    | 'closed'
    | 'unknown';

export type RallarWsStatus = Readonly<{
    sessionId?: string;
    url?: string;
    connectState: RallarConnectStatus;
    readyState: RallarWsReadyState;
    readyStateCode?: number;
    isOpen: boolean;
    reconnecting: boolean;
    reconnectEnabled: boolean;
    reconnectAttempts: number;
    maxReconnectAttempts: number;
    reconnectExhausted: boolean;
}>;

export type RallarWsWaitForOpenResult = Readonly<{
    transport: 'ws';
    status: RallarWaitForOpenStatus;
    wsStatus: RallarWsStatus;
}>;

export type RallarWsStatusSubscriptionOptions = RallarOnChangeOptions;

export type RallarWsStatusListener = (
    status: RallarWsStatus,
) => void | Promise<void>;

export type RallarWsLifecycleKind =
    | 'snapshot'
    | 'connected'
    | 'disconnected'
    | 'open'
    | 'close'
    | 'error';

export type RallarWsLifecycleEvent = Readonly<{
    kind: RallarWsLifecycleKind;
    atEpochMs: number;
    status: RallarWsStatus;
    code?: number;
    reason?: string;
    wasClean?: boolean;
    eventType?: string;
    intentional?: boolean;
}>;

export type RallarWsLifecycleListener = (
    event: RallarWsLifecycleEvent,
) => void | Promise<void>;

export type RallarRtcWaitForOpenResult = Readonly<{
    transport: 'rtc';
    status: RallarWaitForOpenStatus;
    peerId: string;
    laneId: string;
    rtcStatus: RallarRtcStatus;
    peer?: RallarRtcPeerStatus;
    lane?: RallarRtcLaneStatus;
    reason?: string;
}>;

export type RallarRtcRoomLaneWaitResult = Readonly<{
    transport: 'rtc';
    roomId: string;
    laneId: string;
    status: RallarRtcRoomLaneWaitStatus;
    rtcStatus: RallarRtcStatus;
    ready: readonly RallarRtcWaitForOpenResult[];
    notReady: readonly RallarRtcWaitForOpenResult[];
}>;

export type RallarCallMediaInput = Readonly<{
    stream?: MediaStream;
    audio?: boolean;
    video?: boolean;
}>;

export type RallarCallDataInput = Readonly<{
    lanes?: readonly string[];
    openTimeoutMs?: number;
}>;

export type RallarCallStartInput =
    & RallarTargetSelector
    & Readonly<{
    callId?: string;
    media?: RallarCallMediaInput;
    data?: RallarCallDataInput;
}>;

export type RallarCallParticipantState =
    | 'idle'
    | 'connecting'
    | 'partial'
    | 'open'
    | 'failed'
    | 'ended';

export type RallarCallState =
    | 'empty'
    | 'connecting'
    | 'partial'
    | 'open'
    | 'failed'
    | 'ended';

export type RallarCallParticipantStatus = Readonly<{
    peerId: string;
    state: RallarCallParticipantState;
    lanes: readonly RallarRtcLaneStatus[];
    readyLaneIds: readonly string[];
    failedLaneIds: readonly string[];
    reason?: string;
}>;

export type RallarCallStatus = Readonly<{
    callId: string;
    state: RallarCallState;
    peerIds: readonly string[];
    laneIds: readonly string[];
    participants: readonly RallarCallParticipantStatus[];
    startedAtEpochMs: number;
    endedAtEpochMs?: number;
    media: Readonly<{
        localStreamId?: string;
        audioEnabled?: boolean;
        videoEnabled?: boolean;
        sources: readonly RallarMediaSourceStatus[];
    }>;
}>;

export type RallarCallWaitOptions = RallarWaitForOpenOptions;

export type RallarCallEndOptions = Readonly<{
    stopLocalMedia?: boolean;
    disconnectPeers?: boolean;
}>;

export type RallarCallSignalKind =
    | 'invite'
    | 'accepted'
    | 'declined'
    | 'cancelled';

export type RallarCallSignalPayload = Readonly<{
    kind: RallarCallSignalKind;
    callId: string;
    fromPeerId: string;
    toPeerIds: readonly string[];
    roomRef?: GroupRef;
    membership?: RallarTargetMembership;
    data?: Readonly<{
        laneIds: readonly string[];
    }>;
    media?: Readonly<{
        audio?: boolean;
        video?: boolean;
        screen?: boolean;
    }>;
    message?: string;
    reason?: string;
    occurredAtEpochMs: number;
}>;

export type RallarCallInviteInput =
    & RallarCallStartInput
    & Readonly<{
    message?: string;
}>;

export type RallarCallSignalSend = Readonly<{
    peerId: string;
    result: RallarMessageSendResult;
}>;

export type RallarCallInviteResult = Readonly<{
    callId: string;
    peerIds: readonly string[];
    signals: readonly RallarCallSignalSend[];
}>;

export type RallarDirectorRole = 'none' | 'director' | 'client';

export type RallarDirectorState =
    | 'none'
    | 'fresh'
    | 'stale'
    | 'inactive';

export type RallarDirectorStatus = Readonly<{
    roomRef?: GroupRef;
    roomId?: string;
    role: RallarDirectorRole;
    state: RallarDirectorState;
    appointment?: RallarGroupDirectorAppointment;
    isDirector: boolean;
    isFresh: boolean;
    active: boolean;
    freshness: RallarGroupDirectorFreshness;
    lastHeartbeatAtEpochMs?: number;
    nowEpochMs: number;
}>;

export type RallarDirectorAppointOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    heartbeatTtlMs?: number;
}>;

export type RallarDirectorResignOptions = RallarScopedOperationOptions;

export type RallarDirectorStatusOptions = Readonly<{
    now?: number;
}>;

export type RallarDirectorStatusListener = (
    status: RallarDirectorStatus,
) => void | Promise<void>;

export type RallarDirectorRelayEnvelope<T = unknown> = Readonly<{
    protocol: typeof RALLAR_DIRECTOR_RELAY_PROTOCOL;
    topicId: string;
    typeId: string;
    roomId: string;
    epoch: number;
    sentAtEpochMs: number;
    payload: T;
}>;

export type RallarDirectorRelayMessage<T> = Readonly<{
    transport: 'rtc' | 'ws';
    senderId: string;
    data: T;
    envelope: RallarDirectorRelayEnvelope<T>;
    receivedAtEpochMs: number;
}>;

export type RallarDirectorRelaySendStatus =
    | 'sent'
    | 'partial'
    | 'no-director'
    | 'not-director'
    | 'stale-director'
    | 'failed';

export type RallarDirectorRelaySendResult = Readonly<{
    status: RallarDirectorRelaySendStatus;
    rtc?: RallarTargetedSendResult | RallarMessageSendResult;
    ws?: RallarMessageSendResult;
    reason?: string;
}>;

export type RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot = TOutput> =
    Readonly<{
    roomId?: string;
    roomRef?: GroupRef;
    laneId?: string;
    topicId?: string;
    intentTypeId: string;
    outputTypeId: string;
    heartbeatTypeId?: string;
    snapshotTypeId?: string;
    syncRequestTypeId?: string;
    heartbeatIntervalMs?: number;
    snapshotIntervalMs?: number;
    readSnapshot?: () => TSnapshot | undefined | Promise<TSnapshot | undefined>;
    onIntent?: (
        message: RallarDirectorRelayMessage<TIntent>,
        relay: RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>,
    ) => void | TOutput | readonly TOutput[] | Promise<void | TOutput | readonly TOutput[]>;
    onOutput?: (
        message: RallarDirectorRelayMessage<TOutput>,
    ) => void | Promise<void>;
    onSnapshot?: (
        message: RallarDirectorRelayMessage<TSnapshot>,
    ) => void | Promise<void>;
    onSyncRequest?: (
        message: RallarDirectorRelayMessage<unknown>,
        relay: RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>,
    ) => void | Promise<void>;
}>;

export type RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot = TOutput> =
    Readonly<{
    status(): RallarDirectorStatus;
    sendIntent(intent: TIntent): Promise<RallarDirectorRelaySendResult>;
    sendOutput(output: TOutput): Promise<RallarDirectorRelaySendResult>;
    sendHeartbeat(): Promise<RallarDirectorRelaySendResult>;
    sendSnapshot(snapshot?: TSnapshot): Promise<RallarDirectorRelaySendResult>;
    requestSync(payload?: unknown): Promise<RallarDirectorRelaySendResult>;
    stop(): void;
}>;

export type RallarCallSignalEvent = Readonly<{
    kind: RallarCallSignalKind;
    callId: string;
    fromPeerId: string;
    toPeerIds: readonly string[];
    roomRef?: GroupRef;
    membership?: RallarTargetMembership;
    dataLaneIds: readonly string[];
    media: Readonly<{
        audio?: boolean;
        video?: boolean;
        screen?: boolean;
    }>;
    message?: string;
    reason?: string;
    payload: RallarCallSignalPayload;
    raw: RallarMessage<RallarCallSignalPayload>;
}>;

export type RallarIncomingCallInvite = RallarCallSignalEvent & Readonly<{
    kind: 'invite';
    accept(
        input?: Partial<RallarCallStartInput>,
    ): Promise<RallarCallHandle>;
    decline(reason?: string): Promise<readonly RallarCallSignalSend[]>;
}>;

export type RallarCallSignalListener = (
    event: RallarCallSignalEvent,
) => void | Promise<void>;

export type RallarCallInviteListener = (
    invite: RallarIncomingCallInvite,
) => void | Promise<void>;

export type RallarCallHandle = Readonly<{
    id: string;
    status(): RallarCallStatus;
    wait(options?: RallarCallWaitOptions): Promise<RallarCallStatus>;
    channel<T>(
        definition?: Partial<RallarTargetedChannelDefinition>,
    ): RallarTargetedChannel<T>;
    setLocalStream(stream: MediaStream): Promise<void>;
    setAudioEnabled(enabled: boolean): Promise<void>;
    setVideoEnabled(enabled: boolean): Promise<void>;
    stopLocal(kind: 'audio' | 'video' | 'all'): Promise<void>;
    sources: RallarMediaSourcesFacade;
    end(options?: RallarCallEndOptions): Promise<RallarCallStatus>;
}>;

export type RallarFacade = Readonly<{
    configure(config: RallarApiClientConfig): void;
    setDefaults(defaults?: RallarDefaults): void;
    defaults(): RallarDefaults | undefined;
    connect(options?: RallarOperationOptions): Promise<ApiMiddleware>;
    start(options?: RallarStartOptions): Promise<RallarStartResult>;
    disconnect(): Promise<void>;
    status(): RallarConnectStatus;
    isConnected(): boolean;
    session(): AuthSession | undefined;
    subscriptions(): RallarSubscriptionScope;
    flow<K, V>(policies?: RallarFlowPolicies<V>): RallarFlow<K, V>;
    data: RallarDataFacade;
    crdt: RallarCrdtFacade;
    auth: Readonly<{
        login(
            request: LoginRequest,
            options?: RallarOperationOptions,
        ): Promise<LoginResponse>;
        register(
            request: RegisterRequest,
            options?: RallarRegisterOptions,
        ): Promise<RegisterResponse>;
        registerAndLogin(
            request: RegisterRequest,
            options?: RallarRegisterOptions,
        ): Promise<LoginResponse>;
        logout(options?: RallarOperationOptions): Promise<void>;
        restore(): AuthSession | undefined;
        isLoggedIn(): boolean;
    }>;
    rooms: Readonly<{
        state(): RallarRoomState;
        list(): readonly RallarRoomSummary[];
        refresh(
            input?: StateScope | RallarRefreshOptions,
        ): Promise<RallarRoomState>;
        listEvents(
            input: RallarListRoomEventsInput,
        ): Promise<readonly GroupEvent[]>;
        listEventPage(
            input: RallarListRoomEventsInput,
        ): Promise<StateEventPage<GroupEvent>>;
        replayEvents(
            input: RallarReplayRoomEventsInput,
            listener?: RallarRoomEventListener,
        ): Promise<RallarReplayEventsResult<GroupEvent>>;
        create(input: string | RallarCreateRoomInput): Promise<GroupSnapshot>;
        join(
            roomId: string,
            options?: RallarJoinRoomOptions,
        ): Promise<GroupSnapshot>;
        leave(
            input?: string | RallarLeaveRoomOptions,
        ): Promise<GroupSnapshot | undefined>;
        updateMetadata(
            room: string | GroupRef,
            patch: Readonly<Record<string, unknown>>,
            options?: RallarScopedOperationOptions,
        ): Promise<GroupSnapshot>;
        current(): GroupSnapshot | undefined;
        onChange(
            listener: RallarStateListener<RallarRoomState>,
            options?: RallarOnChangeOptions,
        ): RallarUnsubscribe;
        onEvent(
            listener: RallarRoomEventListener,
            options?: RallarRoomEventOptions,
        ): RallarUnsubscribe;
    }>;
    people: Readonly<{
        state(): RallarPeopleState;
        list(): readonly RallarPerson[];
        refresh(
            input?: StateScope | RallarRefreshOptions,
        ): Promise<RallarPeopleState>;
        listEvents(
            principalId: string,
            options?: RallarListPeopleEventsOptions,
        ): Promise<readonly ClientEvent[]>;
        listEventPage(
            principalId: string,
            options?: RallarListPeopleEventsOptions,
        ): Promise<StateEventPage<ClientEvent>>;
        replayEvents(
            principalId: string,
            options?: RallarReplayPeopleEventsOptions,
            listener?: RallarPeopleEventListener,
        ): Promise<RallarReplayEventsResult<ClientEvent>>;
        get(principalId: string): RallarPerson | undefined;
        onChange(
            listener: RallarStateListener<RallarPeopleState>,
            options?: RallarOnChangeOptions,
        ): RallarUnsubscribe;
        onEvent(
            listener: RallarPeopleEventListener,
            options?: RallarPeopleEventOptions,
        ): RallarUnsubscribe;
    }>;
    director: Readonly<{
        appoint(
            room?: string | GroupRef,
            options?: RallarDirectorAppointOptions,
        ): Promise<RallarDirectorStatus>;
        resign(
            room?: string | GroupRef,
            options?: RallarDirectorResignOptions,
        ): Promise<RallarDirectorStatus>;
        status(
            room?: string | GroupRef,
            options?: RallarDirectorStatusOptions,
        ): RallarDirectorStatus;
        onStatus(listener: RallarDirectorStatusListener): RallarUnsubscribe;
        createRelay<TIntent, TOutput, TSnapshot = TOutput>(
            config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>,
        ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>;
    }>;
    messages: Readonly<{
        rtc: RallarMessageLane<
            RallarRtcSendInput<unknown>,
            RallarMessageSelectorInput
        >;
        ws: RallarMessageLane<
            RallarWsSendInput<unknown>,
            RallarMessageSelectorInput
        >;
        channel<T>(
            definition: RallarTypedMessageChannelDefinition,
        ): RallarTypedMessageChannel<T>;
    }>;
    channels: Readonly<{
        targeted<T>(
            definition: RallarTargetedChannelDefinition,
        ): RallarTargetedChannel<T>;
        room<T>(
            definition: Omit<
                RallarTargetedChannelDefinition,
                'peerId' | 'peerIds'
            >,
        ): RallarTargetedChannel<T>;
    }>;
    rtc: Readonly<{
        status(options?: RallarRtcStatusOptions): RallarRtcStatus;
        roomStatus(
            room: string | GroupRef,
            options?: RallarRtcRoomTransportOptions,
        ): RallarRoomTransportStatus;
        openRoom(
            room: string | GroupRef,
            options?: RallarRtcRoomTransportOptions,
        ): Promise<RallarRoomTransportStatus>;
        waitForRoom(
            room: string | GroupRef,
            options?: RallarRtcRoomTransportOptions,
        ): Promise<RallarRoomTransportStatus>;
        onStatus(
            listener: RallarRtcStatusListener,
            options?: RallarRtcStatusSubscriptionOptions,
        ): RallarUnsubscribe;
        onLifecycle(
            listener: RallarRtcLifecycleListener,
            options?: RallarRtcStatusSubscriptionOptions,
        ): RallarUnsubscribe;
        waitForLane(
            peerId: string,
            laneId: string,
            options?: RallarRtcWaitForOpenOptions,
        ): Promise<RallarRtcWaitForOpenResult>;
        waitForOpen(
            peerId: string,
            options?: RallarRtcWaitForOpenOptions,
        ): Promise<RallarRtcWaitForOpenResult>;
        waitForRoomLane(
            room: string | GroupRef,
            laneId: string,
            options?: RallarRtcRoomLaneWaitOptions,
        ): Promise<RallarRtcRoomLaneWaitResult>;
        peer(
            peerId: string,
            options?: RallarRtcStatusOptions,
        ): RallarRtcPeerStatus | undefined;
        knownPeerIds(): readonly string[];
        activePeerIds(): readonly string[];
        peerIdsWithNoReconnectableLanes(): readonly string[];
        readyPeerIds(laneId?: string): readonly string[];
        diagnostics(
            options?: RallarRtcDiagnosticsOptions,
        ): Promise<RallarRtcDiagnostics>;
        restartIce(peerId: string): Promise<RallarRtcRecoveryResult>;
        reconnectPeer(
            peerId: string,
            options?: RallarRtcReconnectOptions,
        ): Promise<RallarRtcRecoveryResult>;
    }>;
    calls: Readonly<{
        start(input: RallarCallStartInput): Promise<RallarCallHandle>;
        invite(input: RallarCallInviteInput): Promise<RallarCallInviteResult>;
        onInvite(listener: RallarCallInviteListener): RallarUnsubscribe;
        onSignal(listener: RallarCallSignalListener): RallarUnsubscribe;
    }>;
    ws: Readonly<{
        status(): RallarWsStatus;
        onStatus(
            listener: RallarWsStatusListener,
            options?: RallarWsStatusSubscriptionOptions,
        ): RallarUnsubscribe;
        onLifecycle(
            listener: RallarWsLifecycleListener,
            options?: RallarWsStatusSubscriptionOptions,
        ): RallarUnsubscribe;
        waitForOpen(
            options?: RallarWaitForOpenOptions,
        ): Promise<RallarWsWaitForOpenResult>;
    }>;
    realtime: Readonly<{
        sendJson<T>(
            input: RallarRealtimeJsonSendInput<T>,
        ): Promise<readonly RallarRealtimeSendResult[]>;
        sendBinary(
            input: RallarRealtimeBinarySendInput,
        ): Promise<readonly RallarRealtimeSendResult[]>;
        onJson<T = unknown>(
            laneId: string,
            handler: RallarRealtimeHandler<T>,
        ): RallarUnsubscribe;
        onBinary(
            laneId: string,
            handler: RallarRealtimeHandler<ArrayBuffer>,
        ): RallarUnsubscribe;
        json<T>(
            defaults?: RallarRealtimeJsonLaneDefaults,
        ): RallarRealtimeJsonLane<T>;
        health(
            options?: RallarRealtimeHealthOptions,
        ): readonly RallarRealtimeLaneHealth[];
    }>;
    media: Readonly<{
        microphone: RallarMediaSourceController<RallarMicrophoneSourceStartOptions>;
        camera: RallarMediaSourceController<RallarCameraSourceStartOptions>;
        screen: RallarMediaSourceController<RallarScreenSourceStartOptions>;
        setLocalStream(stream: MediaStream): Promise<void>;
        setAudioEnabled(enabled: boolean): Promise<void>;
        setVideoEnabled(enabled: boolean): Promise<void>;
        stopLocal(kind: 'audio' | 'video' | 'all'): Promise<void>;
        setPolicy(policy: QRtcMediaPolicy): Promise<void>;
        onRemoteStream(
            handler: (remote: RallarRemoteStream) => void | Promise<void>,
        ): RallarUnsubscribe;
    }>;
    advanced: Readonly<{
        middleware(): ApiMiddleware;
    }>;
}>;

type RallarRtcStatusSubscription = Readonly<{
    listener: RallarRtcStatusListener;
    options: RallarRtcStatusSubscriptionOptions;
}>;

type RallarRtcLifecycleSubscription = Readonly<{
    listener: RallarRtcLifecycleListener;
    options: RallarRtcStatusSubscriptionOptions;
}>;

type RallarWsStatusSubscription = Readonly<{
    listener: RallarWsStatusListener;
    options: RallarWsStatusSubscriptionOptions;
}>;

type RallarWsLifecycleSubscription = Readonly<{
    listener: RallarWsLifecycleListener;
    options: RallarWsStatusSubscriptionOptions;
}>;

type RallarMediaSourceRuntime = {
    kind: RallarMediaSourceKind;
    stream: MediaStream;
    state: RallarMediaSourceState;
    error?: string;
};

class BrowserRallarFacade implements RallarFacade {
    private connectState: RallarConnectStatus = 'idle';
    private ctx: ApiMiddleware | undefined = undefined;
    private connectPromise: Promise<ApiMiddleware> | undefined = undefined;
    private stateCacheUnsubscribe: RallarUnsubscribe | undefined = undefined;
    private currentRoomId: string | undefined = undefined;
    private currentRoomRef: GroupRef | undefined = undefined;
    private configuredDefaults: RallarDefaults | undefined = undefined;
    private defaultScope: StateScope | undefined = undefined;

    private readonly roomStateListeners = new Set<
        RallarStateListener<RallarRoomState>
    >();
    private readonly peopleStateListeners = new Set<
        RallarStateListener<RallarPeopleState>
    >();
    private readonly directorStatusListeners =
        new Set<RallarDirectorStatusListener>();
    private readonly directorHeartbeatByRoom = new Map<
        string,
        Readonly<{
            sessionId: string;
            epoch: number;
            atEpochMs: number;
        }>
    >();
    private readonly roomEventSubscriptions =
        new Set<RallarRoomEventSubscription>();
    private readonly peopleEventSubscriptions =
        new Set<RallarPeopleEventSubscription>();
    private readonly seenGroupEventKeys = new Set<string>();
    private readonly seenClientEventKeys = new Set<string>();
    private readonly rtcMessageListeners = new Map<
        string,
        RallarMessageSubscription
    >();
    private readonly wsMessageListeners = new Map<
        string,
        RallarMessageSubscription
    >();
    private readonly realtimeJsonListeners = new Map<
        string,
        Set<RallarRealtimeHandler<unknown>>
    >();
    private readonly realtimeBinaryListeners = new Map<
        string,
        Set<RallarRealtimeHandler<ArrayBuffer>>
    >();
    private readonly rtcStatusListeners = new Set<RallarRtcStatusSubscription>();
    private readonly rtcLifecycleListeners =
        new Set<RallarRtcLifecycleSubscription>();
    private readonly wsStatusListeners = new Set<RallarWsStatusSubscription>();
    private readonly wsLifecycleListeners =
        new Set<RallarWsLifecycleSubscription>();
    private readonly registeredRtcMessageTypes = new Set<string>();
    private wsAnyMessageCallbackRegistered = false;
    private readonly remoteStreamListeners = new Set<
        (remote: RallarRemoteStream) => void | Promise<void>
    >();
    private remoteStreamCallbackRegistered = false;
    private readonly localMediaSources = new Map<
        RallarMediaSourceKind,
        RallarMediaSourceRuntime
    >();
    readonly data = createRallarDataFacade({
        resolveScopeKey: (scope) => this.resolveDataScopeKey(scope),
    });
    readonly crdt = createRallarCrdtFacade({
        data: this.data,
        readDefaults: () => this.configuredDefaults,
        readTransport: () => this.toCrdtMessageTransport(),
    });

    configure(config: RallarApiClientConfig): void {
        const nextApiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl ?? '');
        const isChangingApiBaseUrl = nextApiBaseUrl !== readApiBaseUrl();
        if (
            isChangingApiBaseUrl &&
            (this.ctx || this.connectPromise || isMiddlewareReady())
        ) {
            throw new Error('Rallar must be configured before connecting.');
        }

        configureApiClient({ apiBaseUrl: nextApiBaseUrl });
    }

    setDefaults(defaults?: RallarDefaults): void {
        this.configuredDefaults = defaults
            ? cloneRallarDefaults(defaults)
            : undefined;
        this.defaultScope = defaults
            ? {
                applicationId: defaults.applicationId,
                workspaceId: defaults.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
            }
            : undefined;
    }

    defaults(): RallarDefaults | undefined {
        return this.configuredDefaults
            ? cloneRallarDefaults(this.configuredDefaults)
            : undefined;
    }

    readonly auth = {
        login: async (
            request: LoginRequest,
            options: RallarOperationOptions = {},
        ): Promise<LoginResponse> => {
            const operationOptions = this.resolveOperationOptions(options);
            const response = await runRallarCommand(
                (signal) => api.loginToApi(request, { signal }),
                operationOptions,
            );
            if (this.ctx || isMiddlewareReady()) {
                await this.disconnect();
            }
            await this.closeAuthenticatedDataScopes();
            writeSession(response);
            return response;
        },
        register: async (
            request: RegisterRequest,
            options: RallarRegisterOptions = {},
        ): Promise<RegisterResponse> => {
            const operationOptions = this.resolveOperationOptions(options);
            return await runRallarCommand(
                (signal) =>
                    api.registerWithApi(request, {
                        signal,
                        authSession: hasOwn(operationOptions, 'adminSession')
                            ? operationOptions.adminSession
                            : undefined,
                    }),
                operationOptions,
            );
        },
        registerAndLogin: async (
            request: RegisterRequest,
            options: RallarRegisterOptions = {},
        ): Promise<LoginResponse> => {
            await this.auth.register(request, options);
            return await this.auth.login(
                {
                    username: request.username,
                    password: request.password,
                },
                options,
            );
        },
        logout: async (options: RallarOperationOptions = {}): Promise<void> => {
            const operationOptions = this.resolveOperationOptions(options);
            const session = readSession();
            let disconnectError: unknown;
            let dataCleanupError: unknown;
            try {
                try {
                    await this.disconnect();
                } catch (error) {
                    disconnectError = error;
                }
                if (session) {
                    await runRallarCommand(
                        (signal) => api.logoutFromApi({ signal }),
                        operationOptions,
                    );
                }
            } finally {
                try {
                    await this.closeAuthenticatedDataScopes();
                } catch (error) {
                    dataCleanupError = error;
                }
                clearSession();
                this.emitState();
            }
            if (disconnectError) {
                throw disconnectError;
            }
            if (dataCleanupError) {
                throw dataCleanupError;
            }
        },
        restore: (): AuthSession | undefined => readSession(),
        isLoggedIn: (): boolean => isLoggedIn(),
    };

    readonly rooms = {
        state: (): RallarRoomState => this.toRoomState(),
        list: (): readonly RallarRoomSummary[] => this.toRoomState().rooms,
        refresh: async (
            input?: StateScope | RallarRefreshOptions,
        ): Promise<RallarRoomState> => {
            const options = toRallarRefreshOptions(input);
            const operationOptions = this.resolveOperationOptions(options);
            const ctx = await this.connect(operationOptions);
            const operationScope = this.resolveOperationScope(options.scope);
            const { clients, groups } = await apiWorkflows.refreshStateSnapshots(
                operationScope,
                toRallarWorkflowPolicies(operationOptions),
            );
            await this.acceptSnapshots(ctx, clients, groups, operationScope);
            return this.toRoomState();
        },
        listEvents: async (
            input: RallarListRoomEventsInput,
        ): Promise<readonly GroupEvent[]> => {
            const options = typeof input === 'string'
                ? { roomId: input }
                : input;
            const operationOptions = this.resolveOperationOptions(options);
            const roomId = options.roomRef?.groupId ?? options.roomId;
            if (!roomId) {
                throw new Error(
                    'Cannot list room events: roomId or roomRef is required.',
                );
            }

            const scope = this.resolveRoomEventListScope(options);
            return await runRallarCommand(
                async (signal) =>
                    await api.listStateGroupEvents(
                        roomId,
                        scope,
                        toStateEventListRequestOptions(options, signal),
                    ),
                operationOptions,
            );
        },
        listEventPage: async (
            input: RallarListRoomEventsInput,
        ): Promise<StateEventPage<GroupEvent>> => {
            const options = typeof input === 'string'
                ? { roomId: input }
                : input;
            const operationOptions = this.resolveOperationOptions(options);
            const roomId = options.roomRef?.groupId ?? options.roomId;
            if (!roomId) {
                throw new Error(
                    'Cannot list room event page: roomId or roomRef is required.',
                );
            }

            const scope = this.resolveRoomEventListScope(options);
            return await runRallarCommand(
                async (signal) =>
                    await api.listStateGroupEventPage(
                        roomId,
                        scope,
                        toStateEventListRequestOptions(options, signal),
                    ),
                operationOptions,
            );
        },
        replayEvents: async (
            input: RallarReplayRoomEventsInput,
            listener?: RallarRoomEventListener,
        ): Promise<RallarReplayEventsResult<GroupEvent>> => {
            const options = typeof input === 'string'
                ? { roomId: input }
                : input;
            return await this.replayRoomEvents(
                options,
                listener ?? options.listener,
            );
        },
        create: async (
            input: string | RallarCreateRoomInput,
        ): Promise<GroupSnapshot> => {
            const createInput = typeof input === 'string'
                ? { displayName: input }
                : input;
            const operationOptions = this.resolveOperationOptions(createInput);
            const ctx = await this.connect(operationOptions);
            const session = this.requireSession();
            const operationScope = this.resolveOperationScope(createInput.scope);
            const snapshot = await apiWorkflows.createAndJoinStateGroup(
                createInput.displayName,
                session.clientId,
                session.sessionId,
                operationScope,
                toRallarWorkflowPolicies(operationOptions),
                createInput.groupId,
            );
            this.setCurrentRoom(snapshot);
            await this.acceptSnapshots(ctx, [], [snapshot], operationScope);
            return snapshot;
        },
        join: async (
            roomId: string,
            options: RallarJoinRoomOptions = {},
        ): Promise<GroupSnapshot> => {
            const operationOptions = this.resolveOperationOptions(options);
            const ctx = await this.connect(operationOptions);
            const session = this.requireSession();
            const currentRoomId = this.resolveCurrentRoomId();
            const operationScope = this.resolveOperationScope(options.scope);

            const snapshot = await apiWorkflows.joinStateGroup(
                roomId,
                session.clientId,
                session.sessionId,
                operationScope,
                toRallarWorkflowPolicies(operationOptions),
            );

            if (
                (options.leaveCurrent ?? true) && currentRoomId &&
                currentRoomId !== roomId
            ) {
                await this.rooms.leave({
                    roomId: currentRoomId,
                    roomRef: this.currentRoomRef,
                    clearCurrent: false,
                    scope: operationScope,
                    signal: operationOptions.signal,
                    timeoutMs: operationOptions.timeoutMs,
                });
            }

            this.setCurrentRoom(snapshot);
            await this.acceptSnapshots(ctx, [], [snapshot], operationScope);
            return snapshot;
        },
        leave: async (
            input?: string | RallarLeaveRoomOptions,
        ): Promise<GroupSnapshot | undefined> => {
            const options = typeof input === 'string'
                ? { roomId: input }
                : input ?? {};
            const operationOptions = this.resolveOperationOptions(options);
            const ctx = await this.connect(operationOptions);
            const session = this.requireSession();
            const explicitOperationScope = this.resolveOperationScope(options.scope);
            const roomRef = options.roomRef ?? (
                options.roomId
                    ? this.resolveGroupRefFromRoomId(options.roomId, options.scope)
                    : this.resolveDefaultRoomRef() ?? this.resolveCurrentRoomRef()
            );
            const roomId = options.roomId ?? roomRef?.groupId;
            const operationScope = options.scope ??
                (roomRef ? toStateScope(roomRef) : explicitOperationScope);

            if (!roomId) {
                return undefined;
            }

            const snapshot = await apiWorkflows.leaveStateGroup(
                roomId,
                session.clientId,
                session.sessionId,
                operationScope,
                toRallarWorkflowPolicies(operationOptions),
            );

            this.clearCurrentRoomIfMatches(roomRef ?? roomId, options.clearCurrent ?? true);

            await this.acceptSnapshots(ctx, [], [snapshot], operationScope);
            return snapshot;
        },
        updateMetadata: async (
            room: string | GroupRef,
            patch: Readonly<Record<string, unknown>>,
            options: RallarScopedOperationOptions = {},
        ): Promise<GroupSnapshot> => {
            const operationOptions = this.resolveOperationOptions(options);
            const ctx = await this.connect(operationOptions);
            const session = this.requireSession();
            const roomRef = this.resolveRoomRef(room);
            const roomId = this.toRoomId(room);
            const operationScope = options.scope ??
                (roomRef ? toStateScope(roomRef) : this.resolveOperationScope());

            if (!roomId) {
                throw new Error('Cannot update room metadata: room is required.');
            }

            const snapshot = await apiWorkflows.updateStateGroupMetadata(
                roomId,
                patch,
                session.clientId,
                session.sessionId,
                operationScope,
                toRallarWorkflowPolicies(operationOptions),
            );

            await this.acceptSnapshots(ctx, [], [snapshot], operationScope);
            return snapshot;
        },
        current: (): GroupSnapshot | undefined => this.toRoomState().currentRoom,
        onChange: (
            listener: RallarStateListener<RallarRoomState>,
            options: RallarOnChangeOptions = {},
        ): RallarUnsubscribe => {
            this.roomStateListeners.add(listener);
            if (options.emitCurrent ?? true) {
                notifyListener(listener, this.toRoomState());
            }
            return () => {
                this.roomStateListeners.delete(listener);
            };
        },
        onEvent: (
            listener: RallarRoomEventListener,
            options: RallarRoomEventOptions = {},
        ): RallarUnsubscribe => {
            return this.onRoomEvent(listener, options);
        },
    };

    readonly people = {
        state: (): RallarPeopleState => this.toPeopleState(),
        list: (): readonly RallarPerson[] => this.toPeopleState().people,
        refresh: async (
            input?: StateScope | RallarRefreshOptions,
        ): Promise<RallarPeopleState> => {
            const options = toRallarRefreshOptions(input);
            const operationOptions = this.resolveOperationOptions(options);
            const ctx = await this.connect(operationOptions);
            const operationScope = this.resolveOperationScope(options.scope);
            const { clients, groups } = await apiWorkflows.refreshStateSnapshots(
                operationScope,
                toRallarWorkflowPolicies(operationOptions),
            );
            await this.acceptSnapshots(ctx, clients, groups, operationScope);
            return this.toPeopleState();
        },
        listEvents: async (
            principalId: string,
            options: RallarListPeopleEventsOptions = {},
        ): Promise<readonly ClientEvent[]> => {
            const operationOptions = this.resolveOperationOptions(options);
            const scope = this.resolveOperationScope(options.scope) ??
                api.defaultStateScope();
            return await runRallarCommand(
                async (signal) =>
                    await api.listStateClientEvents(
                        principalId,
                        scope,
                        toStateEventListRequestOptions(options, signal),
                    ),
                operationOptions,
            );
        },
        listEventPage: async (
            principalId: string,
            options: RallarListPeopleEventsOptions = {},
        ): Promise<StateEventPage<ClientEvent>> => {
            const operationOptions = this.resolveOperationOptions(options);
            const scope = this.resolveOperationScope(options.scope) ??
                api.defaultStateScope();
            return await runRallarCommand(
                async (signal) =>
                    await api.listStateClientEventPage(
                        principalId,
                        scope,
                        toStateEventListRequestOptions(options, signal),
                    ),
                operationOptions,
            );
        },
        replayEvents: async (
            principalId: string,
            options: RallarReplayPeopleEventsOptions = {},
            listener?: RallarPeopleEventListener,
        ): Promise<RallarReplayEventsResult<ClientEvent>> => {
            return await this.replayPeopleEvents(
                principalId,
                options,
                listener ?? options.listener,
            );
        },
        get: (principalId: string): RallarPerson | undefined => {
            const snapshot = this.findClientSnapshot(principalId);
            return snapshot ? toPerson(snapshot) : undefined;
        },
        onChange: (
            listener: RallarStateListener<RallarPeopleState>,
            options: RallarOnChangeOptions = {},
        ): RallarUnsubscribe => {
            this.peopleStateListeners.add(listener);
            if (options.emitCurrent ?? true) {
                notifyListener(listener, this.toPeopleState());
            }
            return () => {
                this.peopleStateListeners.delete(listener);
            };
        },
        onEvent: (
            listener: RallarPeopleEventListener,
            options: RallarPeopleEventOptions = {},
        ): RallarUnsubscribe => {
            return this.onPeopleEvent(listener, options);
        },
    };

    readonly director = {
        appoint: async (
            room?: string | GroupRef,
            options: RallarDirectorAppointOptions = {},
        ): Promise<RallarDirectorStatus> => {
            const target = room ?? this.resolveDefaultRoom() ??
                this.resolveCurrentRoomRef();
            const snapshot = this.findGroupSnapshotForDirector(target);
            const roomRef = this.resolveDirectorRoomRef(target, snapshot);
            const roomId = this.toRoomId(roomRef ?? target);
            if (!roomRef || !roomId) {
                throw new Error('Cannot appoint director: no room selected.');
            }

            const session = this.requireSession();
            const previous = readRallarGroupDirectorFromSnapshot(snapshot);
            const appointment = createRallarGroupDirectorAppointment({
                session,
                previous,
                heartbeatTtlMs: options.heartbeatTtlMs,
            });
            const metadata = mergeRallarGroupDirectorMetadata(
                snapshot?.group.metadata,
                appointment,
            );
            const updated = await this.rooms.updateMetadata(
                roomRef,
                metadata,
                options,
            );
            this.recordDirectorHeartbeat(roomRef, appointment);
            this.emitDirectorStatuses();
            return this.toDirectorStatus(updated.group);
        },
        resign: async (
            room?: string | GroupRef,
            options: RallarDirectorResignOptions = {},
        ): Promise<RallarDirectorStatus> => {
            const target = room ?? this.resolveDefaultRoom() ??
                this.resolveCurrentRoomRef();
            const snapshot = this.findGroupSnapshotForDirector(target);
            const roomRef = this.resolveDirectorRoomRef(target, snapshot);
            const roomId = this.toRoomId(roomRef ?? target);
            if (!roomRef || !roomId) {
                throw new Error('Cannot resign director: no room selected.');
            }

            const session = this.requireSession();
            const appointment = readRallarGroupDirectorFromSnapshot(snapshot);
            if (!isRallarGroupDirectorForSession(appointment, session)) {
                return this.toDirectorStatus(roomRef);
            }

            const metadata = mergeRallarGroupDirectorMetadata(
                snapshot?.group.metadata,
                undefined,
            );
            const updated = await this.rooms.updateMetadata(
                roomRef,
                metadata,
                options,
            );
            this.directorHeartbeatByRoom.delete(this.toDirectorRoomKey(roomRef));
            this.emitDirectorStatuses();
            return this.toDirectorStatus(updated.group);
        },
        status: (
            room?: string | GroupRef,
            options: RallarDirectorStatusOptions = {},
        ): RallarDirectorStatus => this.toDirectorStatus(room, options),
        onStatus: (
            listener: RallarDirectorStatusListener,
        ): RallarUnsubscribe => {
            this.directorStatusListeners.add(listener);
            notifyListener(listener, this.toDirectorStatus());
            return () => {
                this.directorStatusListeners.delete(listener);
            };
        },
        createRelay: <TIntent, TOutput, TSnapshot = TOutput>(
            config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>,
        ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> =>
            this.createDirectorRelay<TIntent, TOutput, TSnapshot>(config),
    };

    readonly messages = {
        rtc: {
            send: async <T>(
                input: RallarRtcSendInput<T>,
            ): Promise<RallarMessageSendResult> => {
                const ctx = await this.connect();
                const session = this.requireSession();
                const room = input.roomRef ??
                    input.roomId ??
                    this.resolveDefaultRoom() ??
                    this.resolveCurrentRoomRef();
                const roomId = this.toRoomId(room);
                const roomRef = this.resolveRoomRef(room);

                if (!roomId) {
                    throw new Error('Cannot send RTC message: no current room.');
                }
                if (!roomRef) {
                    throw new Error(
                        'Cannot send RTC message: no scoped room reference.',
                    );
                }

                const msg = newALMulticastMessage(
                    session.sessionId,
                    newALRoute(
                        input.topicId ?? input.typeId,
                        input.contextId ?? roomId,
                        input.resourceId ?? crypto.randomUUID(),
                    ),
                    roomRef,
                    input.typeId,
                    input.payload,
                    {
                        membershipEpoch: input.membershipEpoch,
                        minSnapshotVersion: this.resolveRoomMinSnapshotVersion(
                            room,
                            input.minSnapshotVersion,
                        ),
                        ttlHops: input.ttlHops,
                        ttlMs: input.ttlMs,
                        seq: input.seq,
                        orderingKey: input.orderingKey ??
                            toALGroupTargetKey(roomRef),
                        reliability: input.reliability ?? 'at-least-once',
                        ack: input.ack ?? 'none',
                        ownership: input.ownership ?? 'shared',
                        nextHopPeerIds: input.nextHopPeerIds,
                        overlayId: input.overlayId ?? toScopedOverlayId(roomRef),
                        fanoutLimit: input.fanoutLimit,
                    },
                );

                if (this.resolveRoomPeerIds(roomRef).length === 0) {
                    return toRallarMessageSendResult(
                        'rtc',
                        msg,
                        {
                            status: 'no-route',
                            message: msg,
                            entries: [],
                            reason: 'No RTC peers are desired for this room.',
                        },
                    );
                }

                const enqueueResult = await ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent(msg);
                wakeQBoxEngineIfQueued(ctx.middleware.qboxEngine, enqueueResult);

                return toRallarMessageSendResult(
                    'rtc',
                    msg,
                    enqueueResult,
                );
            },
            onMessage: <T = unknown>(
                selector: RallarMessageSelectorInput,
                handler: RallarMessageHandler<T>,
            ): RallarUnsubscribe => {
                return this.onTransportMessage(
                    'rtc',
                    selector,
                    handler as RallarMessageHandler<unknown>,
                );
            },
        },
        ws: {
            send: async <T>(
                input: RallarWsSendInput<T>,
            ): Promise<RallarMessageSendResult> => {
                const ctx = await this.connect();
                const session = this.requireSession();
                const room = input.roomRef ??
                    input.roomId ??
                    (input.scope === undefined ? this.resolveDefaultRoom() : undefined);
                const roomId = this.toRoomId(room);
                const scope = input.scope ?? (roomId ? 'room' : 'all');
                const roomRef = scope === 'room' ? this.resolveRoomRef(room) : undefined;
                const contextId = input.contextId ?? roomId ?? input.scope ??
                    'all';
                const minSnapshotVersion = room
                    ? this.resolveRoomMinSnapshotVersion(
                        room,
                        input.minSnapshotVersion,
                    )
                    : input.minSnapshotVersion;
                const msg = newALBroadcastMessage(
                    session.sessionId,
                    newALRoute(
                        input.topicId ?? input.typeId,
                        contextId,
                        input.resourceId ?? crypto.randomUUID(),
                    ),
                    scope,
                    input.typeId,
                    input.payload,
                    {
                        groupRef: roomRef,
                        exceptPeerIds: input.exceptPeerIds,
                        minSnapshotVersion,
                        ttlHops: input.ttlHops,
                        ttlMs: input.ttlMs,
                        reliability: input.reliability ?? 'at-least-once',
                        ack: input.ack ?? 'none',
                        ownership: input.ownership ?? 'shared',
                    },
                );

                const enqueueResult = await ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent(msg);
                wakeQBoxEngineIfQueued(ctx.middleware.qboxEngine, enqueueResult);

                return toRallarMessageSendResult(
                    'ws',
                    msg,
                    enqueueResult,
                );
            },
            onMessage: <T = unknown>(
                selector: RallarMessageSelectorInput,
                handler: RallarMessageHandler<T>,
            ): RallarUnsubscribe => {
                return this.onTransportMessage(
                    'ws',
                    selector,
                    handler as RallarMessageHandler<unknown>,
                );
            },
        },
        channel: <T>(
            definition: RallarTypedMessageChannelDefinition,
        ): RallarTypedMessageChannel<T> => this.createMessageChannel<T>(definition),
    };

    readonly channels = {
        targeted: <T>(
            definition: RallarTargetedChannelDefinition,
        ): RallarTargetedChannel<T> => this.createTargetedChannel<T>(definition),
        room: <T>(
            definition: Omit<
                RallarTargetedChannelDefinition,
                'peerId' | 'peerIds'
            >,
        ): RallarTargetedChannel<T> =>
            this.createTargetedChannel<T>({
                ...definition,
                membership: definition.membership ?? 'live',
            }),
    };

    readonly rtc = {
        status: (
            options: RallarRtcStatusOptions = {},
        ): RallarRtcStatus => this.toRtcStatus(options),
        roomStatus: (
            room: string | GroupRef,
            options: RallarRtcRoomTransportOptions = {},
        ): RallarRoomTransportStatus =>
            this.toRoomTransportStatus(room, options),
        openRoom: async (
            room: string | GroupRef,
            options: RallarRtcRoomTransportOptions = {},
        ): Promise<RallarRoomTransportStatus> =>
            await this.openRtcRoom(room, options),
        waitForRoom: async (
            room: string | GroupRef,
            options: RallarRtcRoomTransportOptions = {},
        ): Promise<RallarRoomTransportStatus> =>
            await this.waitForRtcRoom(room, options),
        onStatus: (
            listener: RallarRtcStatusListener,
            options: RallarRtcStatusSubscriptionOptions = {},
        ): RallarUnsubscribe => {
            const subscription: RallarRtcStatusSubscription = {
                listener,
                options,
            };
            this.rtcStatusListeners.add(subscription);
            this.registerRtcStatusCallbacks();
            if (options.emitCurrent ?? true) {
                notifyListener(listener, this.toRtcStatus(options));
            }

            return () => {
                this.rtcStatusListeners.delete(subscription);
                this.unregisterRtcStatusCallbacksIfUnused();
            };
        },
        onLifecycle: (
            listener: RallarRtcLifecycleListener,
            options: RallarRtcStatusSubscriptionOptions = {},
        ): RallarUnsubscribe => {
            const subscription: RallarRtcLifecycleSubscription = {
                listener,
                options,
            };
            this.rtcLifecycleListeners.add(subscription);
            this.registerRtcStatusCallbacks();
            if (options.emitCurrent ?? true) {
                this.notifyRtcLifecycleSubscription(
                    subscription,
                    'snapshot',
                );
            }

            return () => {
                this.rtcLifecycleListeners.delete(subscription);
                this.unregisterRtcStatusCallbacksIfUnused();
            };
        },
        waitForLane: async (
            peerId: string,
            laneId: string,
            options: RallarRtcWaitForOpenOptions = {},
        ): Promise<RallarRtcWaitForOpenResult> =>
            await this.waitForRtcLaneOpen(peerId, laneId, options),
        waitForOpen: async (
            peerId: string,
            options: RallarRtcWaitForOpenOptions = {},
        ): Promise<RallarRtcWaitForOpenResult> =>
            await this.waitForRtcLaneOpen(
                peerId,
                options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
                options,
            ),
        waitForRoomLane: async (
            room: string | GroupRef,
            laneId: string,
            options: RallarRtcRoomLaneWaitOptions = {},
        ): Promise<RallarRtcRoomLaneWaitResult> =>
            await this.waitForRtcRoomLaneOpen(options.roomRef ?? room, laneId, options),
        peer: (
            peerId: string,
            options: RallarRtcStatusOptions = {},
        ): RallarRtcPeerStatus | undefined => {
            return this.toRtcStatus(options).peers.find((peer) =>
                peer.peerId === peerId
            );
        },
        knownPeerIds: (): readonly string[] => {
            const ctx = this.readMiddleware();
            return ctx?.middleware.webRtcConnectionService.knownPeerIds() ?? [];
        },
        activePeerIds: (): readonly string[] => {
            const ctx = this.readMiddleware();
            return ctx?.middleware.webRtcConnectionService.activePeerIds() ?? [];
        },
        peerIdsWithNoReconnectableLanes: (): readonly string[] => {
            const ctx = this.readMiddleware();
            return ctx?.middleware.webRtcConnectionService
                .peerIdsWithNoReconnectableLanes() ?? [];
        },
        readyPeerIds: (laneId?: string): readonly string[] => {
            const ctx = this.readMiddleware();
            return ctx?.middleware.webRtcConnectionService.readyPeerIdsForLane(
                laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
            ) ?? [];
        },
        diagnostics: async (
            options: RallarRtcDiagnosticsOptions = {},
        ): Promise<RallarRtcDiagnostics> =>
            await this.toRtcDiagnostics(options),
        restartIce: async (
            peerId: string,
        ): Promise<RallarRtcRecoveryResult> =>
            await this.restartRtcIce(peerId),
        reconnectPeer: async (
            peerId: string,
            options: RallarRtcReconnectOptions = {},
        ): Promise<RallarRtcRecoveryResult> =>
            await this.reconnectRtcPeer(peerId, options),
    };

    readonly calls = {
        start: async (
            input: RallarCallStartInput,
        ): Promise<RallarCallHandle> => await this.startCall(input),
        invite: async (
            input: RallarCallInviteInput,
        ): Promise<RallarCallInviteResult> => await this.inviteCall(input),
        onInvite: (
            listener: RallarCallInviteListener,
        ): RallarUnsubscribe => this.onCallInvite(listener),
        onSignal: (
            listener: RallarCallSignalListener,
        ): RallarUnsubscribe => this.onCallSignal(listener),
    };

    readonly ws = {
        status: (): RallarWsStatus => this.toWsStatus(),
        onStatus: (
            listener: RallarWsStatusListener,
            options: RallarWsStatusSubscriptionOptions = {},
        ): RallarUnsubscribe => {
            const subscription: RallarWsStatusSubscription = {
                listener,
                options,
            };
            this.wsStatusListeners.add(subscription);
            this.registerWsStatusCallbacks();
            if (options.emitCurrent ?? true) {
                notifyListener(listener, this.toWsStatus());
            }

            return () => {
                this.wsStatusListeners.delete(subscription);
                this.unregisterWsStatusCallbacksIfUnused();
            };
        },
        onLifecycle: (
            listener: RallarWsLifecycleListener,
            options: RallarWsStatusSubscriptionOptions = {},
        ): RallarUnsubscribe => {
            const subscription: RallarWsLifecycleSubscription = {
                listener,
                options,
            };
            this.wsLifecycleListeners.add(subscription);
            this.registerWsStatusCallbacks();
            if (options.emitCurrent ?? true) {
                this.notifyWsLifecycleSubscription(subscription, 'snapshot');
            }

            return () => {
                this.wsLifecycleListeners.delete(subscription);
                this.unregisterWsStatusCallbacksIfUnused();
            };
        },
        waitForOpen: async (
            options: RallarWaitForOpenOptions = {},
        ): Promise<RallarWsWaitForOpenResult> =>
            await this.waitForWsOpen(options),
    };

    readonly realtime = {
        sendJson: async <T>(
            input: RallarRealtimeJsonSendInput<T>,
        ): Promise<readonly RallarRealtimeSendResult[]> => {
            const ctx = await this.connect();
            const laneId = this.resolveRealtimeLaneId(input.laneId);
            const peerIds = this.resolveRealtimePeerIds(input);

            return await Promise.all(
                peerIds.map(async (peerId) => {
                    const laneOpen = await this.ensureRealtimeLaneOpen(
                        ctx,
                        peerId,
                        laneId,
                        input,
                    );
                    const sendOptions = toRealtimeDataChannelSendOptions(input);
                    return {
                        peerId,
                        laneId,
                        result: laneOpen.status === 'open' && laneOpen.channel
                            ? laneOpen.channel.sendJson(input.data, sendOptions)
                            : toClosedRealtimeSendResult(),
                    };
                }),
            );
        },
        sendBinary: async (
            input: RallarRealtimeBinarySendInput,
        ): Promise<readonly RallarRealtimeSendResult[]> => {
            const ctx = await this.connect();
            const laneId = this.resolveRealtimeLaneId(input.laneId);
            const peerIds = this.resolveRealtimePeerIds(input);

            return await Promise.all(
                peerIds.map(async (peerId) => {
                    const laneOpen = await this.ensureRealtimeLaneOpen(
                        ctx,
                        peerId,
                        laneId,
                        input,
                    );
                    const sendOptions = toRealtimeDataChannelSendOptions(input);
                    return {
                        peerId,
                        laneId,
                        result: laneOpen.status === 'open' && laneOpen.channel
                            ? laneOpen.channel.sendBinary(input.data, sendOptions)
                            : toClosedRealtimeSendResult(),
                    };
                }),
            );
        },
        onJson: <T = unknown>(
            laneId: string,
            handler: RallarRealtimeHandler<T>,
        ): RallarUnsubscribe => {
            const listeners = this.realtimeJsonListeners.get(laneId) ??
                new Set<RallarRealtimeHandler<unknown>>();
            listeners.add(handler as RallarRealtimeHandler<unknown>);
            this.realtimeJsonListeners.set(laneId, listeners);
            this.registerRealtimeLaneCallbacks(laneId);

            return () => {
                listeners.delete(handler as RallarRealtimeHandler<unknown>);
                this.deleteRealtimeLaneIfUnused(laneId);
            };
        },
        onBinary: (
            laneId: string,
            handler: RallarRealtimeHandler<ArrayBuffer>,
        ): RallarUnsubscribe => {
            const listeners = this.realtimeBinaryListeners.get(laneId) ??
                new Set<RallarRealtimeHandler<ArrayBuffer>>();
            listeners.add(handler);
            this.realtimeBinaryListeners.set(laneId, listeners);
            this.registerRealtimeLaneCallbacks(laneId);

            return () => {
                listeners.delete(handler);
                this.deleteRealtimeLaneIfUnused(laneId);
            };
        },
        json: <T>(
            defaults: RallarRealtimeJsonLaneDefaults = {},
        ): RallarRealtimeJsonLane<T> => this.createRealtimeJsonLane<T>(defaults),
        health: (
            options: RallarRealtimeHealthOptions = {},
        ): readonly RallarRealtimeLaneHealth[] => {
            const ctx = this.readMiddleware();
            if (!ctx) {
                return [];
            }

            const peerIds = options.peerIds ??
                ctx.middleware.webRtcConnectionService.activePeerIds();

            return peerIds.flatMap((peerId) => {
                const peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
                if (!peer) {
                    return [];
                }

                const laneIds = options.laneIds ?? Array.from(peer.channels.keys());
                return laneIds.map((laneId) => ({
                    peerId,
                    laneId,
                    channel: peer.channels.get(laneId)?.readHealth(),
                }));
            });
        },
    };

    readonly media = {
        microphone: this.createMediaSourceController('microphone'),
        camera: this.createMediaSourceController('camera'),
        screen: this.createMediaSourceController('screen'),
        setLocalStream: async (stream: MediaStream): Promise<void> => {
            const ctx = await this.connect();
            await ctx.middleware.rtcRxStreamer.setLocalMediaStream(stream);
        },
        setAudioEnabled: async (enabled: boolean): Promise<void> => {
            const ctx = await this.connect();
            ctx.middleware.rtcRxStreamer.setLocalAudioEnabled(enabled);
        },
        setVideoEnabled: async (enabled: boolean): Promise<void> => {
            const ctx = await this.connect();
            ctx.middleware.rtcRxStreamer.setLocalVideoEnabled(enabled);
        },
        stopLocal: async (kind: 'audio' | 'video' | 'all'): Promise<void> => {
            const ctx = await this.connect();
            this.stopLocalMediaSourcesForKind(kind, false);
            ctx.middleware.rtcRxStreamer.stopLocalMedia(kind);
        },
        setPolicy: async (policy: QRtcMediaPolicy): Promise<void> => {
            const ctx = await this.connect();
            ctx.middleware.rtcRxStreamer.setMediaPolicy(policy);
        },
        onRemoteStream: (
            handler: (remote: RallarRemoteStream) => void | Promise<void>,
        ): RallarUnsubscribe => {
            this.remoteStreamListeners.add(handler);
            this.registerRemoteStreamCallback();

            return () => {
                this.remoteStreamListeners.delete(handler);
                if (this.remoteStreamListeners.size === 0) {
                    this.unregisterRemoteStreamCallback();
                }
            };
        },
    };

    readonly advanced = {
        middleware: (): ApiMiddleware => this.requireMiddleware(),
    };

    async connect(
        options: RallarOperationOptions = {},
    ): Promise<ApiMiddleware> {
        const connectOptions = toRallarOperationOptions(
            this.resolveOperationOptions(options),
        );
        const session = readSession();
        if (
            this.ctx &&
            (!session || this.ctx.session.sessionId !== session.sessionId)
        ) {
            await this.disconnect();
        }

        if (this.ctx) {
            return this.ctx;
        }

        if (this.connectPromise) {
            return await waitForRallarOperation(this.connectPromise, connectOptions);
        }

        this.connectState = 'connecting';
        this.connectPromise = initMiddleware(connectOptions)
            .then((ctx) => {
                this.ctx = ctx;
                this.connectState = 'connected';
                this.stateCacheUnsubscribe ??= stateCaches.onStateCacheChange(
                    () => this.emitState(),
                );
                this.registerAllMessageCallbacks();
                this.registerWsStatusCallbacks(ctx);
                this.registerRealtimeLifecycleCallback(ctx);
                this.registerRtcStatusCallbacks(ctx);
                this.registerAllRealtimeCallbacks();
                this.registerRemoteStreamCallback();
                this.emitState();
                this.emitWsLifecycle('connected');
                this.emitRtcLifecycle('connected');
                return ctx;
            })
            .catch((error) => {
                this.connectState = 'idle';
                throw error;
            })
            .finally(() => {
                this.connectPromise = undefined;
            });

        return await waitForRallarOperation(this.connectPromise, connectOptions);
    }

    async start(
        options: RallarStartOptions = {},
    ): Promise<RallarStartResult> {
        const operationOptions = this.resolveOperationOptions(options);
        const session = options.restoreSession === false
            ? undefined
            : this.auth.restore();

        if (!session || options.connect === false) {
            return {
                session,
                connected: false,
            };
        }

        const middleware = await this.connect(operationOptions);
        const refreshRooms = options.refreshRooms ?? true;
        const refreshPeople = options.refreshPeople ?? false;
        let roomState: RallarRoomState | undefined;
        let peopleState: RallarPeopleState | undefined;

        if (refreshRooms || refreshPeople) {
            const refreshOptions = this.toRefreshOptions(options, operationOptions);
            if (refreshRooms) {
                roomState = await this.rooms.refresh(refreshOptions);
                if (refreshPeople) {
                    peopleState = this.people.state();
                }
            } else {
                peopleState = await this.people.refresh(refreshOptions);
            }
        }

        return {
            session,
            connected: true,
            middleware,
            roomState,
            peopleState,
        };
    }

    disconnect(): Promise<void> {
        this.stateCacheUnsubscribe?.();
        this.stateCacheUnsubscribe = undefined;

        const ctx = this.readMiddleware();
        if (ctx) {
            for (const typeId of this.registeredRtcMessageTypes) {
                ctx.middleware.rtcRxStreamer.removeInboxMessageCallback(typeId);
            }
            if (this.wsAnyMessageCallbackRegistered) {
                ctx.middleware.webSocketQueueBox.removeAnyInboxMessageCallback(
                    RALLAR_WS_ANY_MESSAGE_CALLBACK_ID,
                );
            }
            this.unregisterWsStatusCallbacks(ctx);
            ctx.middleware.webRtcConnectionService.removeRtcPeerLifecycleById(
                RALLAR_REALTIME_LIFECYCLE_CALLBACK_ID,
            );
            this.unregisterRtcStatusCallbacks(ctx);
            ctx.middleware.rtcRxStreamer.stopAllHeartbeats();
            const peerIds = ctx.middleware.webRtcConnectionService.knownPeerIds();
            for (const peerId of peerIds) {
                ctx.middleware.webRtcConnectionService.disconnectPeer(peerId);
            }
            this.unregisterRemoteStreamCallback();
            this.stopLocalMediaSourcesForKind('all', false);
            ctx.middleware.rtcRxStreamer.stopLocalMedia('all');
            ctx.middleware.heartbeat?.stop();
            ctx.middleware.qboxEngine.stop();
            ctx.middleware.webSocketQueueBox.close(
                1000,
                'rallar-disconnect',
            );
        }

        this.registeredRtcMessageTypes.clear();
        this.wsAnyMessageCallbackRegistered = false;
        this.remoteStreamCallbackRegistered = false;
        this.currentRoomId = undefined;
        this.currentRoomRef = undefined;
        this.ctx = undefined;
        this.connectState = 'idle';
        clearMiddleware();
        this.emitState();
        this.emitWsLifecycle('disconnected', {
            code: 1000,
            reason: 'rallar-disconnect',
            intentional: true,
        });
        this.emitRtcLifecycle('disconnected');
        return Promise.resolve();
    }

    status(): RallarConnectStatus {
        return this.connectState;
    }

    isConnected(): boolean {
        return this.connectState === 'connected' &&
            this.readMiddleware() !== undefined;
    }

    session(): AuthSession | undefined {
        return readSession();
    }

    subscriptions(): RallarSubscriptionScope {
        return createRallarSubscriptionScope();
    }

    flow<K, V>(policies: RallarFlowPolicies<V> = {}): RallarFlow<K, V> {
        return CommandsOrchestrator.withPolicies<K, V>(policies);
    }

    private toDirectorStatus(
        room?: string | GroupRef,
        options: RallarDirectorStatusOptions = {},
    ): RallarDirectorStatus {
        const target = room ?? this.resolveDefaultRoom() ??
            this.resolveCurrentRoomRef();
        const snapshot = this.findGroupSnapshotForDirector(target);
        const roomRef = this.resolveDirectorRoomRef(target, snapshot);
        const appointment = readRallarGroupDirectorFromSnapshot(snapshot);
        const session = readSession();
        const heartbeat = roomRef
            ? this.directorHeartbeatByRoom.get(this.toDirectorRoomKey(roomRef))
            : undefined;
        const matchingHeartbeat = heartbeat &&
                appointment &&
                heartbeat.sessionId === appointment.sessionId &&
                heartbeat.epoch === appointment.epoch
            ? heartbeat
            : undefined;
        const now = options.now ?? Date.now();
        const active = isRallarGroupDirectorSessionActive(snapshot, appointment);
        const freshness = active
            ? readRallarGroupDirectorFreshness(
                appointment,
                matchingHeartbeat?.atEpochMs,
                now,
            )
            : appointment
                ? 'stale'
                : 'none';
        const isDirector = isRallarGroupDirectorForSession(appointment, session);

        return {
            roomRef,
            roomId: roomRef?.groupId ?? this.toRoomId(target),
            role: appointment ? (isDirector ? 'director' : 'client') : 'none',
            state: !appointment
                ? 'none'
                : !active
                    ? 'inactive'
                    : freshness,
            appointment,
            isDirector,
            isFresh: freshness === 'fresh' && active,
            active,
            freshness,
            lastHeartbeatAtEpochMs: matchingHeartbeat?.atEpochMs,
            nowEpochMs: now,
        };
    }

    private emitDirectorStatuses(): void {
        if (this.directorStatusListeners.size === 0) {
            return;
        }

        const status = this.toDirectorStatus();
        for (const listener of this.directorStatusListeners) {
            notifyListener(listener, status);
        }
    }

    private findGroupSnapshotForDirector(
        room?: string | GroupRef,
    ): GroupSnapshot | undefined {
        if (!room) {
            return this.toRoomState().currentRoom;
        }

        return this.findGroupSnapshot(room);
    }

    private resolveDirectorRoomRef(
        room: string | GroupRef | undefined,
        snapshot?: GroupSnapshot,
    ): GroupRef | undefined {
        if (typeof room === 'object') {
            return room;
        }

        return snapshot?.group ?? this.resolveRoomRef(room);
    }

    private toDirectorRoomKey(roomRef: GroupRef): string {
        return JSON.stringify([
            roomRef.applicationId,
            roomRef.workspaceId ?? '',
            roomRef.groupId,
        ]);
    }

    private recordDirectorHeartbeat(
        roomRef: GroupRef,
        appointment: RallarGroupDirectorAppointment,
        atEpochMs: number = Date.now(),
    ): void {
        this.directorHeartbeatByRoom.set(this.toDirectorRoomKey(roomRef), {
            sessionId: appointment.sessionId,
            epoch: appointment.epoch,
            atEpochMs,
        });
    }

    private createDirectorRelay<TIntent, TOutput, TSnapshot = TOutput>(
        config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>,
    ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> {
        const laneId = config.laneId ?? DEFAULT_RALLAR_REALTIME_LANE_ID;
        const topicId = config.topicId ?? RALLAR_DIRECTOR_DEFAULT_TOPIC_ID;
        const heartbeatTypeId = config.heartbeatTypeId ??
            `${topicId}.heartbeat`;
        const snapshotTypeId = config.snapshotTypeId ?? `${topicId}.snapshot`;
        const syncRequestTypeId = config.syncRequestTypeId ??
            `${topicId}.sync-request`;
        const roomTarget = config.roomRef ?? config.roomId;
        const subscriptions = createRallarSubscriptionScope();
        const timers: ReturnType<typeof setInterval>[] = [];
        let stopped = false;

        const status = (): RallarDirectorStatus =>
            this.toDirectorStatus(roomTarget);

        const relay = {
            status,
            sendIntent: async (
                intent: TIntent,
            ): Promise<RallarDirectorRelaySendResult> =>
                await this.sendDirectorIntent(
                    status(),
                    laneId,
                    topicId,
                    config.intentTypeId,
                    intent,
                ),
            sendOutput: async (
                output: TOutput,
            ): Promise<RallarDirectorRelaySendResult> =>
                await this.sendDirectorRoomEnvelope(
                    status(),
                    topicId,
                    config.outputTypeId,
                    output,
                ),
            sendHeartbeat: async (): Promise<RallarDirectorRelaySendResult> => {
                const current = status();
                if (current.roomRef && current.appointment && current.isDirector) {
                    this.recordDirectorHeartbeat(
                        current.roomRef,
                        current.appointment,
                    );
                    this.emitDirectorStatuses();
                }
                return await this.sendDirectorRoomEnvelope(
                    current,
                    topicId,
                    heartbeatTypeId,
                    {
                        sessionId: current.appointment?.sessionId,
                        epoch: current.appointment?.epoch,
                    },
                );
            },
            sendSnapshot: async (
                snapshot?: TSnapshot,
            ): Promise<RallarDirectorRelaySendResult> => {
                const resolvedSnapshot = snapshot ??
                    await config.readSnapshot?.();
                if (resolvedSnapshot === undefined) {
                    return {
                        status: 'failed',
                        reason: 'No director snapshot is available.',
                    };
                }

                return await this.sendDirectorRoomEnvelope(
                    status(),
                    topicId,
                    snapshotTypeId,
                    resolvedSnapshot,
                );
            },
            requestSync: async (
                payload?: unknown,
            ): Promise<RallarDirectorRelaySendResult> =>
                await this.sendDirectorIntent(
                    status(),
                    laneId,
                    topicId,
                    syncRequestTypeId,
                    payload ?? {},
                ),
            stop: (): void => {
                if (stopped) {
                    return;
                }
                stopped = true;
                subscriptions.unsubscribe();
                for (const timer of timers) {
                    clearInterval(timer);
                }
            },
        } satisfies RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>;

        const handleEnvelope = async <T>(
            transport: 'rtc' | 'ws',
            senderId: string,
            envelope: RallarDirectorRelayEnvelope<T>,
        ): Promise<void> => {
            if (stopped || !this.isCurrentDirectorEnvelope(status(), envelope, senderId)) {
                return;
            }

            const message: RallarDirectorRelayMessage<T> = {
                transport,
                senderId,
                data: envelope.payload,
                envelope,
                receivedAtEpochMs: Date.now(),
            };

            if (envelope.typeId === heartbeatTypeId) {
                const current = status();
                if (senderId !== current.appointment?.sessionId) {
                    return;
                }
                if (current.roomRef && current.appointment) {
                    this.recordDirectorHeartbeat(
                        current.roomRef,
                        current.appointment,
                        message.receivedAtEpochMs,
                    );
                    this.emitDirectorStatuses();
                }
                return;
            }

            if (envelope.typeId === config.outputTypeId) {
                const current = status();
                if (!current.isFresh || senderId !== current.appointment?.sessionId) {
                    return;
                }
                await config.onOutput?.(
                    message as unknown as RallarDirectorRelayMessage<TOutput>,
                );
                return;
            }

            if (envelope.typeId === snapshotTypeId) {
                const current = status();
                if (!current.isFresh || senderId !== current.appointment?.sessionId) {
                    return;
                }
                await config.onSnapshot?.(
                    message as unknown as RallarDirectorRelayMessage<TSnapshot>,
                );
                return;
            }

            if (!status().isDirector) {
                return;
            }

            if (envelope.typeId === config.intentTypeId) {
                const output = await config.onIntent?.(
                    message as unknown as RallarDirectorRelayMessage<TIntent>,
                    relay,
                );
                const outputs = Array.isArray(output) ? output : output ? [output] : [];
                for (const item of outputs) {
                    await relay.sendOutput(item as TOutput);
                }
                return;
            }

            if (envelope.typeId === syncRequestTypeId) {
                await config.onSyncRequest?.(message, relay);
                if (config.readSnapshot) {
                    await relay.sendSnapshot();
                }
            }
        };

        subscriptions
            .add(this.realtime.onJson<RallarDirectorRelayEnvelope>(
                laneId,
                async (message) => {
                    if (!isRallarDirectorRelayEnvelope(message.data, topicId)) {
                        return;
                    }
                    await handleEnvelope('rtc', message.peerId, message.data);
                },
            ))
            .add(this.messages.ws.onMessage<RallarDirectorRelayEnvelope>(
                { topicId },
                async (message) => {
                    if (!isRallarDirectorRelayEnvelope(message.payload, topicId)) {
                        return;
                    }
                    await handleEnvelope('ws', message.senderId, message.payload);
                },
            ))
            .add(this.messages.rtc.onMessage<RallarDirectorRelayEnvelope>(
                { topicId, typeId: config.outputTypeId },
                async (message) => {
                    if (!isRallarDirectorRelayEnvelope(message.payload, topicId)) {
                        return;
                    }
                    await handleEnvelope('rtc', message.senderId, message.payload);
                },
            ))
            .add(this.messages.rtc.onMessage<RallarDirectorRelayEnvelope>(
                { topicId, typeId: heartbeatTypeId },
                async (message) => {
                    if (!isRallarDirectorRelayEnvelope(message.payload, topicId)) {
                        return;
                    }
                    await handleEnvelope('rtc', message.senderId, message.payload);
                },
            ))
            .add(this.messages.rtc.onMessage<RallarDirectorRelayEnvelope>(
                { topicId, typeId: snapshotTypeId },
                async (message) => {
                    if (!isRallarDirectorRelayEnvelope(message.payload, topicId)) {
                        return;
                    }
                    await handleEnvelope('rtc', message.senderId, message.payload);
                },
            ));

        const heartbeatIntervalMs = config.heartbeatIntervalMs ??
            Math.max(
                500,
                Math.min(
                    2_000,
                    (status().appointment?.heartbeatTtlMs ??
                        DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS) / 2,
                ),
            );
        timers.push(setInterval(() => {
            if (status().isDirector) {
                void relay.sendHeartbeat();
            }
        }, heartbeatIntervalMs));

        if (config.readSnapshot) {
            timers.push(setInterval(() => {
                if (status().isDirector) {
                    void relay.sendSnapshot();
                }
            }, config.snapshotIntervalMs ?? 2_000));
        }

        return relay;
    }

    private async sendDirectorIntent<T>(
        status: RallarDirectorStatus,
        laneId: string,
        topicId: string,
        typeId: string,
        payload: T,
    ): Promise<RallarDirectorRelaySendResult> {
        if (!status.appointment || !status.roomId) {
            return {
                status: 'no-director',
                reason: 'No director is appointed for this room.',
            };
        }

        if (!status.isFresh) {
            return {
                status: 'stale-director',
                reason: 'The appointed director is stale or inactive.',
            };
        }

        if (status.isDirector) {
            return {
                status: 'not-director',
                reason: 'The local session is the director.',
            };
        }

        const envelope = this.createDirectorEnvelope(
            status,
            topicId,
            typeId,
            payload,
        );
        const rtc = await this.channels.targeted<RallarDirectorRelayEnvelope<T>>({
            peerId: status.appointment.sessionId,
            laneId,
        }).send(envelope);

        if (rtc.status === 'sent') {
            return { status: 'sent', rtc };
        }

        const ws = await this.sendWsUnicastMessage(
            status.appointment.sessionId,
            envelope,
            typeId,
            {
                topicId,
                contextId: status.roomId,
            },
        );

        return {
            status: isSuccessfulRallarMessageSendStatus(ws.status)
                ? 'sent'
                : 'failed',
            rtc,
            ws,
            reason: isSuccessfulRallarMessageSendStatus(ws.status)
                ? undefined
                : ws.reason,
        };
    }

    private async sendDirectorRoomEnvelope<T>(
        status: RallarDirectorStatus,
        topicId: string,
        typeId: string,
        payload: T,
    ): Promise<RallarDirectorRelaySendResult> {
        if (!status.appointment || !status.roomRef || !status.roomId) {
            return {
                status: 'no-director',
                reason: 'No director is appointed for this room.',
            };
        }

        if (!status.isDirector) {
            return {
                status: 'not-director',
                reason: 'Only the appointed local director can send director output.',
            };
        }

        const envelope = this.createDirectorEnvelope(
            status,
            topicId,
            typeId,
            payload,
        );
        const rtc = await this.messages.rtc.send<RallarDirectorRelayEnvelope<T>>({
            roomRef: status.roomRef,
            topicId,
            typeId,
            payload: envelope,
            reliability: 'best-effort',
            ack: 'none',
            ttlMs: 5_000,
        });

        if (isSuccessfulRallarMessageSendStatus(rtc.status)) {
            return { status: 'sent', rtc };
        }

        const ws = await this.messages.ws.send<RallarDirectorRelayEnvelope<T>>({
            roomRef: status.roomRef,
            topicId,
            typeId,
            payload: envelope,
            reliability: 'best-effort',
            ack: 'none',
            ttlMs: 5_000,
        });

        return {
            status: isSuccessfulRallarMessageSendStatus(ws.status)
                ? 'sent'
                : 'failed',
            rtc,
            ws,
            reason: isSuccessfulRallarMessageSendStatus(ws.status)
                ? undefined
                : ws.reason ?? rtc.reason,
        };
    }

    private createDirectorEnvelope<T>(
        status: RallarDirectorStatus,
        topicId: string,
        typeId: string,
        payload: T,
    ): RallarDirectorRelayEnvelope<T> {
        if (!status.appointment || !status.roomId) {
            throw new Error('Cannot create director envelope without appointment.');
        }

        return {
            protocol: RALLAR_DIRECTOR_RELAY_PROTOCOL,
            topicId,
            typeId,
            roomId: status.roomId,
            epoch: status.appointment.epoch,
            sentAtEpochMs: Date.now(),
            payload,
        };
    }

    private isCurrentDirectorEnvelope(
        status: RallarDirectorStatus,
        envelope: RallarDirectorRelayEnvelope,
        _senderId: string,
    ): boolean {
        return Boolean(
            status.appointment &&
                status.roomId &&
                envelope.roomId === status.roomId &&
                envelope.epoch === status.appointment.epoch,
        );
    }

    private toCrdtMessageTransport(): RallarCrdtMessageTransport {
        return {
            ws: {
                send: async (input) => {
                    const result = await this.messages.ws.send(input as never);
                    return {
                        transport: 'ws',
                        status: result.status,
                        reason: result.reason,
                    };
                },
                onMessage: (selector, handler) =>
                    this.messages.ws.onMessage(selector, async (message) => {
                        await handler({
                            payload: message.payload as never,
                            topicId: message.topicId,
                            typeId: message.typeId,
                            transport: 'ws',
                        });
                    }),
            },
            rtc: {
                send: async (input) => {
                    const result = await this.messages.rtc.send(input as never);
                    return {
                        transport: 'rtc',
                        status: result.status,
                        reason: result.reason,
                    };
                },
                onMessage: (selector, handler) =>
                    this.messages.rtc.onMessage(selector, async (message) => {
                        await handler({
                            payload: message.payload as never,
                            topicId: message.topicId,
                            typeId: message.typeId,
                            transport: 'rtc',
                        });
                    }),
            },
        };
    }

    private createMessageChannel<T>(
        definition: RallarTypedMessageChannelDefinition,
    ): RallarTypedMessageChannel<T> {
        const selector = normalizeRallarMessageSelector(definition);
        if (!selector.typeId) {
            throw new Error('Typed message channels require a typeId.');
        }

        const channelDefinition = {
            topicId: selector.topicId,
            typeId: selector.typeId,
        };

        return {
            send: async (
                payload,
                options: RallarTypedMessageSendOptions<T> = {},
            ) =>
                await this.sendTypedMessageWithStrategy(
                    channelDefinition,
                    payload,
                    options,
                ),
            sendRtc: async (
                payload,
                options: RallarTypedRtcSendOptions<T> = {},
            ) =>
                await this.messages.rtc.send<T>({
                    ...options,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                }),
            sendWs: async (
                payload,
                options: RallarTypedWsSendOptions<T> = {},
            ) =>
                await this.messages.ws.send<T>({
                    ...options,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                }),
            onRtc: (handler) =>
                this.messages.rtc.onMessage<T>(
                    channelDefinition,
                    async (message) => {
                        await handler(message.payload, message);
                    },
                ),
            onWs: (handler) =>
                this.messages.ws.onMessage<T>(
                    channelDefinition,
                    async (message) => {
                        await handler(message.payload, message);
                    },
                ),
        };
    }

    private async sendTypedMessageWithStrategy<T>(
        channelDefinition: RallarTypedMessageChannelDefinition,
        payload: T,
        options: RallarTypedMessageSendOptions<T>,
    ): Promise<RallarMessageSendResult> {
        const { strategy = 'rtc-with-ws-fallback', ...sendOptions } = options;
        const rtcOptions = sendOptions as RallarTypedRtcSendOptions<T>;
        const wsOptions = sendOptions as RallarTypedWsSendOptions<T>;

        switch (strategy) {
            case 'ws':
                return await this.messages.ws.send<T>({
                    ...wsOptions,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                });
            case 'rtc':
            case 'realtime':
                return await this.messages.rtc.send<T>({
                    ...rtcOptions,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                });
            case 'ws-then-rtc': {
                const wsResult = await this.messages.ws.send<T>({
                    ...wsOptions,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                });
                if (isSuccessfulRallarMessageSendStatus(wsResult.status)) {
                    return wsResult;
                }

                return await this.messages.rtc.send<T>({
                    ...rtcOptions,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                });
            }
            case 'rtc-with-ws-fallback':
            default: {
                const rtcResult = await this.messages.rtc.send<T>({
                    ...rtcOptions,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                });
                if (isSuccessfulRallarMessageSendStatus(rtcResult.status)) {
                    return rtcResult;
                }

                return await this.messages.ws.send<T>({
                    ...wsOptions,
                    topicId: channelDefinition.topicId,
                    typeId: channelDefinition.typeId,
                    payload,
                });
            }
        }
    }

    private createRealtimeJsonLane<T>(
        defaults: RallarRealtimeJsonLaneDefaults,
    ): RallarRealtimeJsonLane<T> {
        const laneId = this.resolveRealtimeLaneId(defaults.laneId);

        return {
            send: async (
                data,
                options: RallarRealtimeJsonLaneSendOptions<T> = {},
            ) =>
                await this.realtime.sendJson<T>({
                    ...defaults,
                    ...options,
                    data,
                }),
            on: (handler) => this.realtime.onJson<T>(laneId, handler),
        };
    }

    private createTargetedChannel<T>(
        definition: RallarTargetedChannelDefinition,
    ): RallarTargetedChannel<T> {
        const fixedPeerIds = definition.membership === 'live'
            ? undefined
            : this.resolveTargetPeerIds(definition);
        const defaultLaneId = this.resolveRealtimeLaneId(definition.laneId);
        const resolvePeerIds = (
            options: RallarTargetSelector = {},
        ): readonly string[] => {
            if (fixedPeerIds && !hasTargetSelectorOverride(options)) {
                return fixedPeerIds;
            }

            return this.resolveTargetPeerIds({
                ...definition,
                ...options,
            });
        };

        return {
            send: async (
                data,
                options: RallarTargetedChannelSendOptions<T> = {},
            ) => {
                const laneId = this.resolveRealtimeLaneId(
                    options.laneId ?? definition.laneId,
                );
                const peerIds = resolvePeerIds(options);
                if (peerIds.length === 0) {
                    return {
                        transport: 'rtc',
                        status: 'no-targets',
                        laneId,
                        peerIds,
                        results: [],
                        reason: 'No target RTC peers resolved.',
                    };
                }

                const results = await this.realtime.sendJson<T>({
                    ...definition,
                    ...options,
                    laneId,
                    peerIds,
                    data,
                });

                return {
                    transport: 'rtc',
                    status: toTargetedSendStatus(peerIds, results),
                    laneId,
                    peerIds,
                    results,
                };
            },
            on: (handler) => this.realtime.onJson<T>(defaultLaneId, handler),
            peerIds: resolvePeerIds,
        };
    }

    private createMediaSourceController<TOptions>(
        kind: RallarMediaSourceKind,
    ): RallarMediaSourceController<TOptions> {
        return {
            start: async (options?: TOptions): Promise<RallarMediaSourceHandle> =>
                await this.startMediaSource(
                    kind,
                    (options ?? {}) as
                        | RallarMicrophoneSourceStartOptions
                        | RallarCameraSourceStartOptions
                        | RallarScreenSourceStartOptions,
                ),
            status: (): RallarMediaSourceStatus | undefined =>
                this.readMediaSourceStatus(kind),
            stop: async (): Promise<RallarMediaSourceStatus | undefined> =>
                await this.stopMediaSource(kind),
        };
    }

    private async startMediaSource(
        kind: RallarMediaSourceKind,
        options:
            | RallarMicrophoneSourceStartOptions
            | RallarCameraSourceStartOptions
            | RallarScreenSourceStartOptions = {},
    ): Promise<RallarMediaSourceHandle> {
        await this.stopMediaSource(kind, false);

        let runtime: RallarMediaSourceRuntime;
        try {
            const stream = options.stream ??
                await this.captureMediaSource(kind, options);
            runtime = {
                kind,
                stream,
                state: 'open',
            };
            this.localMediaSources.set(kind, runtime);
            this.registerMediaSourceEndedCallbacks(runtime);
        } catch (error) {
            runtime = {
                kind,
                stream: toEmptyMediaStream(),
                state: 'failed',
                error: toErrorMessage(error),
            };
            this.localMediaSources.set(kind, runtime);
            throw error;
        }

        const handle = this.toMediaSourceHandle(kind);
        if (options.attach ?? true) {
            await handle.attach();
        }
        return handle;
    }

    private async captureMediaSource(
        kind: RallarMediaSourceKind,
        options:
            | RallarMicrophoneSourceStartOptions
            | RallarCameraSourceStartOptions
            | RallarScreenSourceStartOptions,
    ): Promise<MediaStream> {
        const mediaDevices = globalThis.navigator?.mediaDevices;
        if (!mediaDevices) {
            throw new Error('Browser media devices are not available.');
        }

        if (kind === 'microphone') {
            return await mediaDevices.getUserMedia({
                audio: (options as RallarMicrophoneSourceStartOptions).audio ??
                    true,
                video: false,
            });
        }

        if (kind === 'camera') {
            return await mediaDevices.getUserMedia({
                audio: false,
                video: (options as RallarCameraSourceStartOptions).video ?? true,
            });
        }

        const screenOptions = options as RallarScreenSourceStartOptions;
        const getDisplayMedia = mediaDevices.getDisplayMedia?.bind(mediaDevices);
        if (!getDisplayMedia) {
            throw new Error('Browser screen capture is not available.');
        }

        return await getDisplayMedia({
            audio: screenOptions.audio ?? false,
            video: screenOptions.video ?? true,
        });
    }

    private toMediaSourceHandle(
        kind: RallarMediaSourceKind,
    ): RallarMediaSourceHandle {
        const runtime = this.requireMediaSource(kind);
        return {
            kind,
            stream: runtime.stream,
            status: (): RallarMediaSourceStatus =>
                this.readMediaSourceStatus(kind) ?? toMediaSourceStatus(runtime),
            attach: async (): Promise<RallarMediaSourceStatus> => {
                await this.attachLocalMediaSources();
                return this.readMediaSourceStatus(kind) ??
                    toMediaSourceStatus(runtime);
            },
            setEnabled: async (
                enabled: boolean,
            ): Promise<RallarMediaSourceStatus> => {
                for (const track of readMediaSourceTracks(kind, runtime.stream)) {
                    track.enabled = enabled;
                }
                await this.attachLocalMediaSources();
                return this.readMediaSourceStatus(kind) ??
                    toMediaSourceStatus(runtime);
            },
            stop: async (): Promise<RallarMediaSourceStatus> =>
                await this.stopMediaSource(kind) ??
                    toMediaSourceStatus({
                        ...runtime,
                        state: 'ended',
                    }),
        };
    }

    private requireMediaSource(
        kind: RallarMediaSourceKind,
    ): RallarMediaSourceRuntime {
        const runtime = this.localMediaSources.get(kind);
        if (!runtime) {
            throw new Error(`Rallar media source is not started: ${kind}.`);
        }

        return runtime;
    }

    private readMediaSourceStatus(
        kind: RallarMediaSourceKind,
    ): RallarMediaSourceStatus | undefined {
        const runtime = this.localMediaSources.get(kind);
        return runtime ? toMediaSourceStatus(runtime) : undefined;
    }

    private readMediaSourceStatuses(): readonly RallarMediaSourceStatus[] {
        return Array.from(this.localMediaSources.values())
            .map(toMediaSourceStatus);
    }

    private async stopMediaSource(
        kind: RallarMediaSourceKind,
        attach: boolean = true,
    ): Promise<RallarMediaSourceStatus | undefined> {
        const runtime = this.localMediaSources.get(kind);
        if (!runtime) {
            return undefined;
        }

        this.localMediaSources.delete(kind);
        for (const track of readMediaStreamTracks(runtime.stream)) {
            track.stop();
        }
        runtime.state = 'ended';

        if (attach) {
            await this.attachLocalMediaSources();
        }

        return toMediaSourceStatus(runtime);
    }

    private stopLocalMediaSourcesForKind(
        kind: 'audio' | 'video' | 'all',
        attach: boolean,
    ): void {
        const sourceKinds = kind === 'all'
            ? ['microphone', 'camera', 'screen'] as const
            : kind === 'audio'
                ? ['microphone'] as const
                : ['camera', 'screen'] as const;

        for (const sourceKind of sourceKinds) {
            const runtime = this.localMediaSources.get(sourceKind);
            if (!runtime) {
                continue;
            }

            this.localMediaSources.delete(sourceKind);
            for (const track of readMediaSourceTracks(sourceKind, runtime.stream)) {
                track.stop();
            }
            runtime.state = 'ended';
        }

        if (attach) {
            this.attachLocalMediaSources()
                .catch((error) =>
                    console.error('Error attaching Rallar local media sources', error)
                );
        }
    }

    private async attachLocalMediaSources(): Promise<void> {
        const ctx = await this.connect();
        const runtimes = Array.from(this.localMediaSources.values())
            .filter((runtime) => runtime.state === 'open');
        const tracks = runtimes.flatMap((runtime) =>
            readMediaStreamTracks(runtime.stream)
                .filter((track) => track.readyState !== 'ended')
        );

        if (tracks.length === 0) {
            ctx.middleware.rtcRxStreamer.stopLocalMedia('all');
            return;
        }

        const stream = toComposedMediaStream(runtimes, tracks);
        await ctx.middleware.rtcRxStreamer.setLocalMediaStream(stream);
        ctx.middleware.rtcRxStreamer.setLocalAudioEnabled(
            tracks.some((track) => track.kind === 'audio' && track.enabled),
        );
        ctx.middleware.rtcRxStreamer.setLocalVideoEnabled(
            tracks.some((track) => track.kind === 'video' && track.enabled),
        );
    }

    private registerMediaSourceEndedCallbacks(
        runtime: RallarMediaSourceRuntime,
    ): void {
        for (const track of readMediaStreamTracks(runtime.stream)) {
            track.addEventListener?.('ended', () => {
                if (this.localMediaSources.get(runtime.kind) !== runtime) {
                    return;
                }

                if (readMediaStreamTracks(runtime.stream).some((candidate) =>
                    candidate.readyState !== 'ended'
                )) {
                    return;
                }

                runtime.state = 'ended';
                this.localMediaSources.delete(runtime.kind);
                this.attachLocalMediaSources()
                    .catch((error) =>
                        console.error(
                            'Error attaching Rallar local media sources',
                            error,
                        )
                    );
            }, { once: true });
        }
    }

    private async inviteCall(
        input: RallarCallInviteInput,
    ): Promise<RallarCallInviteResult> {
        await this.connect();

        const callId = input.callId ?? crypto.randomUUID();
        const peerIds = this.resolveTargetPeerIds(input);
        const payload = this.toCallSignalPayload(
            'invite',
            callId,
            peerIds,
            input,
        );
        const signals = await this.sendCallSignalToPeers(peerIds, payload);

        return {
            callId,
            peerIds,
            signals,
        };
    }

    private onCallSignal(
        listener: RallarCallSignalListener,
    ): RallarUnsubscribe {
        return this.messages.ws.onMessage<RallarCallSignalPayload>(
            {
                topicId: RALLAR_CALL_SIGNAL_TOPIC_ID,
            },
            async (message) => {
                const event = this.toCallSignalEvent(message);
                if (event) {
                    await listener(event);
                }
            },
        );
    }

    private onCallInvite(
        listener: RallarCallInviteListener,
    ): RallarUnsubscribe {
        return this.messages.ws.onMessage<RallarCallSignalPayload>(
            {
                topicId: RALLAR_CALL_SIGNAL_TOPIC_ID,
                typeId: RALLAR_CALL_INVITE_TYPE_ID,
            },
            async (message) => {
                const event = this.toIncomingCallInvite(message);
                if (event) {
                    await listener(event);
                }
            },
        );
    }

    private toIncomingCallInvite(
        message: RallarMessage<RallarCallSignalPayload>,
    ): RallarIncomingCallInvite | undefined {
        const event = this.toCallSignalEvent(message);
        if (!event || event.kind !== 'invite') {
            return undefined;
        }

        return {
            ...event,
            kind: 'invite',
            accept: async (
                input: Partial<RallarCallStartInput> = {},
            ): Promise<RallarCallHandle> => {
                await this.sendCallSignalToPeers(
                    [event.fromPeerId],
                    this.toCallSignalPayload(
                        'accepted',
                        event.callId,
                        [event.fromPeerId],
                        {
                            ...input,
                            callId: event.callId,
                            peerId: event.fromPeerId,
                            data: input.data ??
                                (event.dataLaneIds.length > 0
                                    ? { lanes: event.dataLaneIds }
                                    : undefined),
                            roomRef: input.roomRef ?? event.roomRef,
                            membership: input.membership ?? event.membership,
                        },
                    ),
                );

                return await this.startCall({
                    ...input,
                    callId: event.callId,
                    peerId: event.fromPeerId,
                    data: input.data ??
                        (event.dataLaneIds.length > 0
                            ? { lanes: event.dataLaneIds }
                            : undefined),
                });
            },
            decline: async (
                reason?: string,
            ): Promise<readonly RallarCallSignalSend[]> =>
                await this.sendCallSignalToPeers(
                    [event.fromPeerId],
                    this.toCallSignalPayload(
                        'declined',
                        event.callId,
                        [event.fromPeerId],
                        {
                            peerId: event.fromPeerId,
                            callId: event.callId,
                            data: event.dataLaneIds.length > 0
                                ? { lanes: event.dataLaneIds }
                                : undefined,
                            roomRef: event.roomRef,
                            membership: event.membership,
                        },
                        reason,
                    ),
                ),
        };
    }

    private toCallSignalEvent(
        message: RallarMessage<RallarCallSignalPayload>,
    ): RallarCallSignalEvent | undefined {
        if (!isRallarCallSignalPayload(message.payload)) {
            return undefined;
        }

        const payload = message.payload;
        if (!this.isCallSignalForCurrentSession(payload)) {
            return undefined;
        }

        return {
            kind: payload.kind,
            callId: payload.callId,
            fromPeerId: payload.fromPeerId,
            toPeerIds: payload.toPeerIds,
            roomRef: payload.roomRef,
            membership: payload.membership,
            dataLaneIds: payload.data?.laneIds ?? [],
            media: payload.media ?? {},
            message: payload.message,
            reason: payload.reason,
            payload,
            raw: message,
        };
    }

    private isCallSignalForCurrentSession(
        payload: RallarCallSignalPayload,
    ): boolean {
        const sessionId = readSession()?.sessionId;
        if (!sessionId || payload.fromPeerId === sessionId) {
            return false;
        }

        return payload.toPeerIds.length === 0 ||
            payload.toPeerIds.includes(sessionId);
    }

    private toCallSignalPayload(
        kind: RallarCallSignalKind,
        callId: string,
        toPeerIds: readonly string[],
        input: Partial<RallarCallInviteInput>,
        reason?: string,
    ): RallarCallSignalPayload {
        const session = this.requireSession();
        return {
            kind,
            callId,
            fromPeerId: session.sessionId,
            toPeerIds: [...new Set(toPeerIds)],
            roomRef: input.roomRef ??
                (input.roomId ? this.resolveRoomRef(input.roomId) : undefined),
            membership: input.membership,
            data: {
                laneIds: input.data?.lanes
                    ? [...new Set(input.data.lanes)]
                    : [],
            },
            media: {
                audio: input.media?.audio,
                video: input.media?.video,
                screen: this.readMediaSourceStatus('screen')?.state === 'open',
            },
            message: input.message,
            reason,
            occurredAtEpochMs: Date.now(),
        };
    }

    private async sendCallSignalToPeers(
        peerIds: readonly string[],
        payload: RallarCallSignalPayload,
    ): Promise<readonly RallarCallSignalSend[]> {
        const uniquePeerIds = [...new Set(peerIds)]
            .filter((peerId) => peerId !== this.requireSession().sessionId);
        return await Promise.all(
            uniquePeerIds.map(async (peerId) => ({
                peerId,
                result: await this.sendWsUnicastMessage(
                    peerId,
                    payload,
                    toCallSignalTypeId(payload.kind),
                    {
                        topicId: RALLAR_CALL_SIGNAL_TOPIC_ID,
                        contextId: payload.callId,
                    },
                ),
            })),
        );
    }

    private async sendWsUnicastMessage<T>(
        peerId: string,
        payload: T,
        typeId: string,
        options: Readonly<{
            topicId: string;
            contextId: string;
            resourceId?: string;
        }>,
    ): Promise<RallarMessageSendResult> {
        const ctx = await this.connect();
        const session = this.requireSession();
        const msg = newALUnicastMessage(
            session.sessionId,
            newALRoute(
                options.topicId,
                options.contextId,
                options.resourceId ?? crypto.randomUUID(),
            ),
            peerId,
            typeId,
            payload,
        );

        const enqueueResult = await ctx.middleware.webSocketQueueBox
            .enqueueOutboxIfAbsent(msg);
        wakeQBoxEngineIfQueued(ctx.middleware.qboxEngine, enqueueResult);

        return toRallarMessageSendResult('ws', msg, enqueueResult);
    }

    private async startCall(
        input: RallarCallStartInput,
    ): Promise<RallarCallHandle> {
        await this.connect();

        const callId = input.callId ?? crypto.randomUUID();
        const startedAtEpochMs = Date.now();
        const laneIds = this.resolveCallLaneIds(input);
        const fixedPeerIds = input.membership === 'live'
            ? undefined
            : this.resolveTargetPeerIds(input);
        const mediaState: {
            localStreamId?: string;
            audioEnabled?: boolean;
            videoEnabled?: boolean;
        } = {
            localStreamId: input.media?.stream?.id,
            audioEnabled: input.media?.audio,
            videoEnabled: input.media?.video,
        };
        let endedAtEpochMs: number | undefined;

        const resolvePeerIds = (
            options: RallarTargetSelector = {},
        ): readonly string[] => {
            if (fixedPeerIds && !hasTargetSelectorOverride(options)) {
                return fixedPeerIds;
            }

            return this.resolveTargetPeerIds({
                ...input,
                ...options,
            });
        };
        const status = (): RallarCallStatus =>
            this.toCallStatus({
                callId,
                laneIds,
                peerIds: resolvePeerIds(),
                startedAtEpochMs,
                endedAtEpochMs,
                media: mediaState,
            });
        const wait = async (
            options: RallarCallWaitOptions = {},
        ): Promise<RallarCallStatus> => {
            if (endedAtEpochMs !== undefined) {
                return status();
            }

            const ctx = await this.connect();
            const peerIds = resolvePeerIds();
            if (laneIds.length === 0) {
                this.startPeerConnections(ctx, peerIds);
                return status();
            }

            await Promise.all(
                peerIds.flatMap((peerId) =>
                    laneIds.map((laneId) =>
                        this.waitForRtcLaneOpen(
                            peerId,
                            laneId,
                            {
                                ...options,
                                connect: true,
                            },
                        )
                    )
                ),
            );
            return status();
        };
        const handle: RallarCallHandle = {
            id: callId,
            status,
            wait,
            channel: <T>(
                definition: Partial<RallarTargetedChannelDefinition> = {},
            ) => {
                const membership = definition.membership ?? input.membership ??
                    'fixed';
                const target = membership === 'live' &&
                        (input.roomId !== undefined || input.roomRef !== undefined) &&
                        !hasTargetSelectorOverride(definition)
                    ? {
                        roomId: input.roomId,
                        roomRef: input.roomRef,
                        membership,
                    }
                    : {
                        peerIds: resolvePeerIds(definition),
                        membership,
                    };

                return this.createTargetedChannel<T>({
                    ...definition,
                    ...target,
                    laneId: definition.laneId ?? laneIds[0],
                });
            },
            setLocalStream: async (stream: MediaStream): Promise<void> => {
                await this.media.setLocalStream(stream);
                mediaState.localStreamId = stream.id;
            },
            setAudioEnabled: async (enabled: boolean): Promise<void> => {
                await this.media.setAudioEnabled(enabled);
                mediaState.audioEnabled = enabled;
            },
            setVideoEnabled: async (enabled: boolean): Promise<void> => {
                await this.media.setVideoEnabled(enabled);
                mediaState.videoEnabled = enabled;
            },
            stopLocal: async (kind: 'audio' | 'video' | 'all'): Promise<void> => {
                await this.media.stopLocal(kind);
                if (kind === 'audio' || kind === 'all') {
                    mediaState.audioEnabled = false;
                }
                if (kind === 'video' || kind === 'all') {
                    mediaState.videoEnabled = false;
                }
                if (kind === 'all') {
                    mediaState.localStreamId = undefined;
                }
            },
            sources: {
                microphone: this.media.microphone,
                camera: this.media.camera,
                screen: this.media.screen,
            },
            end: async (
                options: RallarCallEndOptions = {},
            ): Promise<RallarCallStatus> => {
                if (endedAtEpochMs === undefined) {
                    endedAtEpochMs = Date.now();
                }

                const ctx = this.readMiddleware();
                if (options.disconnectPeers ?? false) {
                    for (const peerId of resolvePeerIds()) {
                        ctx?.middleware.webRtcConnectionService.disconnectPeer(
                            peerId,
                        );
                    }
                }

                if (options.stopLocalMedia ?? true) {
                    await this.media.stopLocal('all');
                    mediaState.localStreamId = undefined;
                    mediaState.audioEnabled = false;
                    mediaState.videoEnabled = false;
                }

                return status();
            },
        };

        if (input.media?.stream) {
            await handle.setLocalStream(input.media.stream);
        }
        if (input.media?.audio !== undefined) {
            await handle.setAudioEnabled(input.media.audio);
        }
        if (input.media?.video !== undefined) {
            await handle.setVideoEnabled(input.media.video);
        }

        await wait({
            timeoutMs: input.data?.openTimeoutMs,
        });

        return handle;
    }

    private startPeerConnections(
        ctx: ApiMiddleware,
        peerIds: readonly string[],
    ): void {
        for (const peerId of peerIds) {
            ctx.middleware.webRtcConnectionService.ensurePeerConnectionStarted(
                peerId,
            );
        }
    }

    private toCallStatus(input: Readonly<{
        callId: string;
        laneIds: readonly string[];
        peerIds: readonly string[];
        startedAtEpochMs: number;
            endedAtEpochMs?: number;
            media: Readonly<{
                localStreamId?: string;
                audioEnabled?: boolean;
                videoEnabled?: boolean;
            }>;
    }>): RallarCallStatus {
        const participants = input.peerIds.map((peerId) =>
            this.toCallParticipantStatus(
                peerId,
                input.laneIds,
                input.endedAtEpochMs !== undefined,
            )
        );

        return {
            callId: input.callId,
            state: toCallState(participants, input.endedAtEpochMs),
            peerIds: input.peerIds,
            laneIds: input.laneIds,
            participants,
            startedAtEpochMs: input.startedAtEpochMs,
            endedAtEpochMs: input.endedAtEpochMs,
            media: {
                ...input.media,
                sources: this.readMediaSourceStatuses(),
            },
        };
    }

    private toCallParticipantStatus(
        peerId: string,
        laneIds: readonly string[],
        ended: boolean,
    ): RallarCallParticipantStatus {
        const rtcStatus = this.toRtcStatus({
            laneId: laneIds[0] ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
        });
        const peer = rtcStatus.peers.find((candidate) =>
            candidate.peerId === peerId
        );
        const lanes = laneIds.length === 0
            ? peer?.lanes ?? []
            : laneIds.map((laneId) =>
                peer?.lanes.find((lane) => lane.laneId === laneId) ??
                    toMissingRtcLaneStatus(peerId, laneId)
            );
        const readyLaneIds = lanes
            .filter((lane) => lane.isOpen)
            .map((lane) => lane.laneId);
        const failedLaneIds = lanes
            .filter((lane) => !lane.isOpen && !lane.isReconnectable)
            .map((lane) => lane.laneId);

        return {
            peerId,
            state: toCallParticipantState({
                ended,
                peer,
                laneCount: laneIds.length,
                readyLaneCount: readyLaneIds.length,
                failedLaneCount: failedLaneIds.length,
            }),
            lanes,
            readyLaneIds,
            failedLaneIds,
            reason: toCallParticipantReason(peer, laneIds.length, failedLaneIds),
        };
    }

    private toRtcStatus(
        options: RallarRtcStatusOptions = {},
    ): RallarRtcStatus {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const ctx = this.readMiddleware();
        if (!ctx) {
            return {
                sessionId: readSession()?.sessionId,
                laneId,
                knownPeerIds: [],
                activePeerIds: [],
                peerIdsWithNoReconnectableLanes: [],
                readyPeerIds: [],
                peers: [],
            };
        }

        const service = ctx.middleware.webRtcConnectionService;
        const knownPeerIds = service.knownPeerIds();
        const activePeerIds = service.activePeerIds();
        const peerIdsWithNoReconnectableLanes = service
            .peerIdsWithNoReconnectableLanes();
        const readyPeerIds = service.readyPeerIdsForLane(laneId);
        const activePeerIdSet = new Set(activePeerIds);
        const peerIdsWithNoReconnectableLanesSet = new Set(
            peerIdsWithNoReconnectableLanes,
        );
        const readyPeerIdSet = new Set(readyPeerIds);

        return {
            sessionId: ctx.session.sessionId,
            laneId,
            knownPeerIds,
            activePeerIds,
            peerIdsWithNoReconnectableLanes,
            readyPeerIds,
            peers: knownPeerIds.map((peerId) =>
                this.toRtcPeerStatus(
                    peerId,
                    service.readPeer(peerId),
                    activePeerIdSet,
                    peerIdsWithNoReconnectableLanesSet,
                    readyPeerIdSet,
                )
            ),
        };
    }

    private toRtcPeerStatus(
        peerId: string,
        peer: QRtcPeerDto | undefined,
        activePeerIds: ReadonlySet<string>,
        peerIdsWithNoReconnectableLanes: ReadonlySet<string>,
        readyPeerIds: ReadonlySet<string>,
    ): RallarRtcPeerStatus {
        const lanes = peer
            ? Array.from(peer.channels.entries()).map(([laneId, channel]) =>
                toRtcLaneStatus(peerId, laneId, channel.readHealth())
            )
            : [];

        return {
            peerId,
            connection: toRtcConnectionStatus(peer),
            lanes,
            isActive: activePeerIds.has(peerId),
            hasNoReconnectableLanes: peerIdsWithNoReconnectableLanes.has(peerId),
            isRoutable: readyPeerIds.has(peerId),
            readyLaneIds: lanes
                .filter((lane) => lane.isOpen)
                .map((lane) => lane.laneId),
        };
    }

    private async toRtcDiagnostics(
        options: RallarRtcDiagnosticsOptions = {},
    ): Promise<RallarRtcDiagnostics> {
        const ctx = this.readMiddleware();
        const sessionId = ctx?.session.sessionId ?? readSession()?.sessionId;
        if (!ctx) {
            return {
                sessionId,
                generatedAtEpochMs: Date.now(),
                peerCount: 0,
                connectedPeerCount: 0,
                relayPeerCount: 0,
                peers: [],
            };
        }

        const service = ctx.middleware.webRtcConnectionService;
        const peerIds = options.peerIds ?? service.knownPeerIds();
        const activePeerIds = new Set(service.activePeerIds());
        const noReconnectableLanePeerIds = new Set(
            service.peerIdsWithNoReconnectableLanes(),
        );
        const readyPeerIds = new Set(
            service.readyPeerIdsForLane(
                options.laneIds?.[0] ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
            ),
        );
        const peers = await Promise.all(
            [...new Set(peerIds)].map(async (peerId) => {
                const peer = service.readPeer(peerId);
                const status = this.toRtcPeerStatus(
                    peerId,
                    peer,
                    activePeerIds,
                    noReconnectableLanePeerIds,
                    readyPeerIds,
                );
                return await this.toRtcPeerDiagnostics(
                    status,
                    peer,
                    options,
                );
            }),
        );

        return {
            sessionId,
            generatedAtEpochMs: Date.now(),
            peerCount: peers.length,
            connectedPeerCount: peers.filter((peer) =>
                peer.connection.connectionState === 'connected'
            ).length,
            relayPeerCount: peers.filter((peer) => peer.usesRelay).length,
            peers,
        };
    }

    private async toRtcPeerDiagnostics(
        status: RallarRtcPeerStatus,
        peer: QRtcPeerDto | undefined,
        options: RallarRtcDiagnosticsOptions,
    ): Promise<RallarRtcPeerDiagnostics> {
        const laneIds = options.laneIds
            ? new Set(options.laneIds)
            : undefined;
        const lanes = laneIds
            ? status.lanes.filter((lane) => laneIds.has(lane.laneId))
            : status.lanes;

        try {
            const selectedCandidatePair = await readSelectedCandidatePairDiagnostics(
                peer?.connection.status.pc,
            );
            return {
                peerId: status.peerId,
                connection: status.connection,
                lanes,
                selectedCandidatePair,
                usesRelay: selectedCandidatePair?.usesRelay ?? false,
                statsAvailable: selectedCandidatePair !== undefined,
            };
        } catch (error) {
            return {
                peerId: status.peerId,
                connection: status.connection,
                lanes,
                usesRelay: false,
                statsAvailable: false,
                statsError: toErrorMessage(error),
            };
        }
    }

    private async restartRtcIce(
        peerId: string,
    ): Promise<RallarRtcRecoveryResult> {
        const ctx = this.readMiddleware();
        if (!ctx) {
            return this.toRtcRecoveryResult(
                peerId,
                'restart-ice',
                'not-connected',
                'Rallar is not connected.',
            );
        }

        const peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
        if (!peer) {
            return this.toRtcRecoveryResult(
                peerId,
                'restart-ice',
                'no-peer',
                `RTC peer ${peerId} is not known.`,
            );
        }

        const pc = peer.connection.status.pc;
        if (!pc || typeof pc.restartIce !== 'function') {
            return this.toRtcRecoveryResult(
                peerId,
                'restart-ice',
                'unsupported',
                `RTC peer ${peerId} does not expose restartIce().`,
            );
        }

        try {
            pc.restartIce();
            return this.toRtcRecoveryResult(peerId, 'restart-ice', 'restarted');
        } catch (error) {
            return this.toRtcRecoveryResult(
                peerId,
                'restart-ice',
                'failed',
                toErrorMessage(error),
            );
        }
    }

    private async reconnectRtcPeer(
        peerId: string,
        options: RallarRtcReconnectOptions = {},
    ): Promise<RallarRtcRecoveryResult> {
        const ctx = this.readMiddleware();
        if (!ctx) {
            return this.toRtcRecoveryResult(
                peerId,
                'reconnect',
                'not-connected',
                'Rallar is not connected.',
            );
        }

        try {
            ctx.middleware.webRtcConnectionService.disconnectPeer(peerId);
            const laneId = options.laneId;
            if (laneId) {
                const result = await this.waitForRtcLaneOpen(
                    peerId,
                    laneId,
                    {
                        ...options,
                        connect: true,
                    },
                );
                return this.toRtcRecoveryResult(
                    peerId,
                    'reconnect',
                    result.status === 'open' ? 'started' : 'failed',
                    result.reason,
                );
            }

            const started = ctx.middleware.webRtcConnectionService
                .ensurePeerConnectionStarted(peerId);
            if (started.left) {
                return this.toRtcRecoveryResult(
                    peerId,
                    'reconnect',
                    started.left.kind === 'self' ? 'failed' : 'failed',
                    started.left.kind,
                );
            }

            return this.toRtcRecoveryResult(peerId, 'reconnect', 'started');
        } catch (error) {
            return this.toRtcRecoveryResult(
                peerId,
                'reconnect',
                'failed',
                toErrorMessage(error),
            );
        }
    }

    private toRtcRecoveryResult(
        peerId: string,
        action: RallarRtcRecoveryResult['action'],
        status: RallarRtcRecoveryStatus,
        reason?: string,
    ): RallarRtcRecoveryResult {
        return {
            peerId,
            action,
            status,
            rtcStatus: this.toRtcStatus(),
            reason,
        };
    }

    private toWsStatus(): RallarWsStatus {
        const ctx = this.readMiddleware();
        if (!ctx) {
            return {
                sessionId: readSession()?.sessionId,
                connectState: this.connectState,
                readyState: 'missing',
                isOpen: false,
                reconnecting: false,
                reconnectEnabled: false,
                reconnectAttempts: 0,
                maxReconnectAttempts: 0,
                reconnectExhausted: false,
            };
        }

        const health = ctx.middleware.webSocketQueueBox.readHealth();
        return {
            sessionId: health.sessionId,
            url: toPublicWsStatusUrl(health.url),
            connectState: this.connectState,
            readyState: health.readyState,
            readyStateCode: health.readyStateCode,
            isOpen: health.isOpen,
            reconnecting: health.reconnecting,
            reconnectEnabled: health.reconnectEnabled,
            reconnectAttempts: health.reconnectAttempts,
            maxReconnectAttempts: health.maxReconnectAttempts,
            reconnectExhausted: health.reconnectExhausted,
        };
    }

    private waitForWsOpen(
        options: RallarWaitForOpenOptions = {},
    ): Promise<RallarWsWaitForOpenResult> {
        const current = this.toWsStatus();
        if (current.isOpen) {
            return Promise.resolve(toWsWaitForOpenResult('open', current));
        }

        if (options.signal?.aborted) {
            return Promise.resolve(toWsWaitForOpenResult('aborted', current));
        }

        if (!this.readMiddleware()) {
            return Promise.resolve(
                toWsWaitForOpenResult('not-connected', current),
            );
        }

        if (isTerminalClosedWsStatus(current)) {
            return Promise.resolve(toWsWaitForOpenResult('closed', current));
        }

        const timeoutMs = normalizeWaitTimeoutMs(options.timeoutMs);
        if (timeoutMs <= 0) {
            return Promise.resolve(toWsWaitForOpenResult('timeout', current));
        }

        return new Promise<RallarWsWaitForOpenResult>((resolve) => {
            let settled = false;
            let latest = current;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let unsubscribe: RallarUnsubscribe = () => {
            };

            const finish = (
                status: RallarWaitForOpenStatus,
                wsStatus: RallarWsStatus = latest,
            ): void => {
                if (settled) {
                    return;
                }

                settled = true;
                if (timeout !== undefined) {
                    clearTimeout(timeout);
                }
                options.signal?.removeEventListener('abort', onAbort);
                unsubscribe();
                resolve(toWsWaitForOpenResult(status, wsStatus));
            };

            const onAbort = (): void => finish('aborted');

            unsubscribe = this.ws.onStatus(
                (status) => {
                    latest = status;
                    if (status.isOpen) {
                        finish('open', status);
                        return;
                    }

                    if (isTerminalClosedWsStatus(status)) {
                        finish('closed', status);
                    }
                },
                {
                    emitCurrent: false,
                },
            );
            options.signal?.addEventListener('abort', onAbort, { once: true });
            timeout = setTimeout(() => finish('timeout'), timeoutMs);
        });
    }

    private async waitForRtcLaneOpen(
        peerId: string,
        laneId: string,
        options: RallarRtcWaitForOpenOptions = {},
    ): Promise<RallarRtcWaitForOpenResult> {
        const ctx = this.readMiddleware();
        if (options.signal?.aborted) {
            return this.toRtcWaitForOpenResult('aborted', peerId, laneId);
        }

        if (!ctx) {
            return this.toRtcWaitForOpenResult('not-connected', peerId, laneId);
        }

        if (this.resolveRtcConnectOnWait(options.connect)) {
            return await this.waitForRtcLaneOpenWithConnect(
                ctx,
                peerId,
                laneId,
                options,
            );
        }

        let peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
        if (!peer) {
            return this.toRtcWaitForOpenResult('no-peer', peerId, laneId);
        }

        const channel = peer.channels.get(laneId);
        if (!channel) {
            return this.toRtcWaitForOpenResult('no-lane', peerId, laneId);
        }

        const initialHealth = channel.readHealth();
        if (initialHealth.readyState === 'open') {
            return this.toRtcWaitForOpenResult('open', peerId, laneId);
        }

        if (isClosedRtcLaneHealth(initialHealth)) {
            return this.toRtcWaitForOpenResult('closed', peerId, laneId);
        }

        const timeoutMs = normalizeWaitTimeoutMs(
            this.resolveRtcWaitTimeoutMs(options.timeoutMs),
        );
        if (timeoutMs <= 0) {
            return this.toRtcWaitForOpenResult('timeout', peerId, laneId);
        }

        const opened = await waitForRtcChannelOpenOrAbort(
            channel.waitUntilOpen(timeoutMs),
            options.signal,
        );
        if (opened === 'aborted') {
            return this.toRtcWaitForOpenResult('aborted', peerId, laneId);
        }

        if (opened) {
            return this.toRtcWaitForOpenResult('open', peerId, laneId);
        }

        return this.toRtcWaitForOpenResult(
            isClosedRtcLaneHealth(channel.readHealth()) ? 'closed' : 'timeout',
            peerId,
            laneId,
        );
    }

    private async waitForRtcRoomLaneOpen(
        room: string | GroupRef,
        laneId: string,
        options: RallarRtcRoomLaneWaitOptions = {},
    ): Promise<RallarRtcRoomLaneWaitResult> {
        const roomId = typeof room === 'string' ? room : room.groupId;
        const peerIds = this.resolveRoomPeerIds(options.roomRef ?? room);
        if (peerIds.length === 0) {
            return this.toRtcRoomLaneWaitResult(roomId, laneId, [], []);
        }

        const results = await Promise.all(
            peerIds.map((peerId) =>
                this.waitForRtcLaneOpen(
                    peerId,
                    laneId,
                    options,
                )
            ),
        );
        const ready = results.filter((result) => result.status === 'open');
        const notReady = results.filter((result) => result.status !== 'open');

        return this.toRtcRoomLaneWaitResult(roomId, laneId, ready, notReady);
    }

    private async openRtcRoom(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {},
    ): Promise<RallarRoomTransportStatus> {
        const mode = options.mode ?? 'lazy';
        if (mode === 'off' || mode === 'lazy') {
            return this.toRoomTransportStatus(room, {
                ...options,
                mode,
            });
        }

        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const readiness = await this.waitForRtcRoomLaneOpen(
            room,
            laneId,
            {
                ...options,
                connect: true,
            },
        );

        return this.toRoomTransportStatus(room, {
            ...options,
            mode,
            laneId,
        }, readiness);
    }

    private async waitForRtcRoom(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {},
    ): Promise<RallarRoomTransportStatus> {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const readiness = await this.waitForRtcRoomLaneOpen(
            room,
            laneId,
            {
                ...options,
                connect: options.connect ?? true,
            },
        );

        return this.toRoomTransportStatus(room, {
            ...options,
            laneId,
        }, readiness);
    }

    private toRoomTransportStatus(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {},
        readiness?: RallarRtcRoomLaneWaitResult,
    ): RallarRoomTransportStatus {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const mode = options.mode ?? 'lazy';
        const roomRef = this.resolveRoomRef(room);
        const roomId = this.toRoomId(room);
        const desiredPeerIds = this.resolveRoomPeerIds(roomRef ?? room);
        const desiredPeerIdSet = new Set(desiredPeerIds);
        const rtcStatus = this.toRtcStatus({ laneId });
        const knownPeerIds = rtcStatus.knownPeerIds.filter((peerId) =>
            desiredPeerIdSet.has(peerId)
        );
        const activePeerIds = rtcStatus.activePeerIds.filter((peerId) =>
            desiredPeerIdSet.has(peerId)
        );
        const readyPeerIds = rtcStatus.readyPeerIds.filter((peerId) =>
            desiredPeerIdSet.has(peerId)
        );
        const failedPeerIds = rtcStatus.peerIdsWithNoReconnectableLanes.filter(
            (peerId) => desiredPeerIdSet.has(peerId),
        );
        const minReadyPeers = Math.max(
            0,
            options.minReadyPeers ?? desiredPeerIds.length,
        );
        const state = toRoomTransportState({
            mode,
            desiredPeerCount: desiredPeerIds.length,
            knownPeerCount: knownPeerIds.length,
            activePeerCount: activePeerIds.length,
            readyPeerCount: readyPeerIds.length,
            failedPeerCount: failedPeerIds.length,
            minReadyPeers,
            waitStatus: readiness?.status,
        });

        return {
            roomRef,
            roomId,
            ws: this.toWsStatus(),
            rtc: {
                desired: mode !== 'off',
                mode,
                state,
                desiredPeerIds,
                knownPeerIds,
                activePeerIds,
                readyPeerIds,
                failedPeerIds,
                laneId,
                lastChangedAtEpochMs: Date.now(),
                reason: toRoomTransportReason(state, readiness),
            },
        };
    }

    private async waitForRtcLaneOpenWithConnect(
        ctx: ApiMiddleware,
        peerId: string,
        laneId: string,
        options: RallarRtcWaitForOpenOptions,
    ): Promise<RallarRtcWaitForOpenResult> {
        try {
            const result = await ctx.middleware.webRtcConnectionService
                .ensurePeerLaneOpen(
                    peerId,
                    laneId,
                    {
                        timeoutMs: normalizeWaitTimeoutMs(
                            this.resolveRtcWaitTimeoutMs(options.timeoutMs),
                        ),
                        signal: options.signal,
                    },
                );

            return this.toRtcWaitForOpenResultFromPeerLaneOpen(result);
        } catch (error) {
            return this.toRtcWaitForOpenResult(
                'failed',
                peerId,
                laneId,
                toErrorMessage(error),
            );
        }
    }

    private toRtcWaitForOpenResultFromPeerLaneOpen(
        result: WebRtcPeerLaneOpenResult,
    ): RallarRtcWaitForOpenResult {
        return this.toRtcWaitForOpenResult(
            toRallarWaitForOpenStatus(result.status),
            result.peerId,
            result.laneId,
            toPeerLaneOpenReason(result),
        );
    }

    private toRtcRoomLaneWaitResult(
        roomId: string,
        laneId: string,
        ready: readonly RallarRtcWaitForOpenResult[],
        notReady: readonly RallarRtcWaitForOpenResult[],
    ): RallarRtcRoomLaneWaitResult {
        return {
            transport: 'rtc',
            roomId,
            laneId,
            status: toRtcRoomLaneWaitStatus(ready, notReady),
            rtcStatus: this.toRtcStatus({ laneId }),
            ready,
            notReady,
        };
    }

    private toRtcWaitForOpenResult(
        status: RallarWaitForOpenStatus,
        peerId: string,
        laneId: string,
        reason?: string,
    ): RallarRtcWaitForOpenResult {
        const rtcStatus = this.toRtcStatus({ laneId });
        const peer = rtcStatus.peers.find((candidate) =>
            candidate.peerId === peerId
        );
        const lane = peer?.lanes.find((candidate) =>
            candidate.laneId === laneId
        );
        return {
            transport: 'rtc',
            status,
            peerId,
            laneId,
            rtcStatus,
            peer,
            lane,
            reason,
        };
    }

    private registerWsStatusCallbacks(
        ctx: ApiMiddleware | undefined = this.readMiddleware(),
    ): void {
        if (!ctx || !this.hasWsStatusSubscriptions()) {
            return;
        }

        ctx.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo(
            RALLAR_WS_STATUS_CALLBACK_ID,
            this.toWsLifecycleCallbacks(),
        );
    }

    private toWsLifecycleCallbacks(): WebSocketClientCallbacks {
        return {
            onOpen: (event) => {
                this.emitWsLifecycle('open', {
                    eventType: event.type,
                });
            },
            onClose: (event) => {
                this.emitWsLifecycle('close', {
                    code: event.code,
                    reason: event.reason,
                    wasClean: event.wasClean,
                    eventType: event.type,
                    intentional: false,
                });
            },
            onError: (event) => {
                this.emitWsLifecycle('error', {
                    eventType: event.type,
                    intentional: false,
                });
            },
        };
    }

    private unregisterWsStatusCallbacksIfUnused(): void {
        if (this.hasWsStatusSubscriptions()) {
            return;
        }

        this.unregisterWsStatusCallbacks();
    }

    private unregisterWsStatusCallbacks(
        ctx: ApiMiddleware | undefined = this.readMiddleware(),
    ): void {
        ctx?.middleware.webSocketQueueBox.socket.removeWebsocketCallbackById(
            RALLAR_WS_STATUS_CALLBACK_ID,
        );
    }

    private hasWsStatusSubscriptions(): boolean {
        return this.wsStatusListeners.size > 0 ||
            this.wsLifecycleListeners.size > 0;
    }

    private emitWsLifecycle(
        kind: RallarWsLifecycleKind,
        input: Readonly<{
            code?: number;
            reason?: string;
            wasClean?: boolean;
            eventType?: string;
            intentional?: boolean;
        }> = {},
    ): void {
        this.emitWsStatus();
        for (const subscription of this.wsLifecycleListeners) {
            this.notifyWsLifecycleSubscription(subscription, kind, input);
        }
    }

    private emitWsStatus(): void {
        for (const subscription of this.wsStatusListeners) {
            notifyListener(subscription.listener, this.toWsStatus());
        }
    }

    private notifyWsLifecycleSubscription(
        subscription: RallarWsLifecycleSubscription,
        kind: RallarWsLifecycleKind,
        input: Readonly<{
            code?: number;
            reason?: string;
            wasClean?: boolean;
            eventType?: string;
            intentional?: boolean;
        }> = {},
    ): void {
        notifyListener(subscription.listener, {
            kind,
            atEpochMs: Date.now(),
            status: this.toWsStatus(),
            code: input.code,
            reason: input.reason,
            wasClean: input.wasClean,
            eventType: input.eventType,
            intentional: input.intentional,
        });
    }

    private async acceptSnapshots(
        ctx: ApiMiddleware,
        clients: readonly ClientSnapshot[],
        groups: readonly GroupSnapshot[],
        scope?: StateScope,
    ): Promise<void> {
        await stateCaches.hydrateStateCaches(
            ctx.middleware.webRtcGroupManager,
            toClientInfo(ctx.session),
            clients,
            groups,
            { scope },
        );
        this.emitState();
    }

    private emitState(): void {
        const roomState = this.toRoomState();
        const peopleState = this.toPeopleState();

        for (const listener of this.roomStateListeners) {
            notifyListener(listener, roomState);
        }
        for (const listener of this.peopleStateListeners) {
            notifyListener(listener, peopleState);
        }
        this.emitDirectorStatuses();
    }

    private registerRtcStatusCallbacks(
        ctx: ApiMiddleware | undefined = this.readMiddleware(),
    ): void {
        if (!ctx || !this.hasRtcStatusSubscriptions()) {
            return;
        }

        const service = ctx.middleware.webRtcConnectionService;
        service.onRtcPeerLifecycleDo(
            RALLAR_RTC_STATUS_CALLBACK_ID,
            {
                onCreated: (peer) => {
                    this.registerRtcStatusCallbacksForPeer(peer);
                    this.emitRtcLifecycle('peer-created', {
                        peerId: peer.peerId,
                    });
                },
                onDeleted: (peer) => {
                    this.unregisterRtcStatusCallbacksForPeer(peer);
                    this.emitRtcLifecycleSoon('peer-deleted', {
                        peerId: peer.peerId,
                    });
                },
                onConnectTimeout: (peer) => {
                    this.emitRtcLifecycle('peer-timeout', {
                        peerId: peer.peerId,
                    });
                },
            },
        );

        for (const peerId of service.knownPeerIds()) {
            const peer = service.readPeer(peerId);
            if (peer) {
                this.registerRtcStatusCallbacksForPeer(peer);
            }
        }
    }

    private registerRtcStatusCallbacksForPeer(peer: QRtcPeerDto): void {
        for (const [laneId, channel] of peer.channels.entries()) {
            channel.onRtcCallbacksDo(
                RALLAR_RTC_STATUS_CALLBACK_ID,
                this.toRtcLaneLifecycleCallbacks(peer.peerId, laneId),
            );
        }
    }

    private toRtcLaneLifecycleCallbacks(
        peerId: string,
        laneId: string,
    ): QRtcClientCallbacks {
        return {
            onOpen: async () => {
                this.emitRtcLifecycle('lane-open', { peerId, laneId });
            },
            onClose: async () => {
                this.emitRtcLifecycle('lane-close', { peerId, laneId });
            },
            onError: async () => {
                this.emitRtcLifecycle('lane-error', { peerId, laneId });
            },
        };
    }

    private unregisterRtcStatusCallbacksIfUnused(): void {
        if (this.hasRtcStatusSubscriptions()) {
            return;
        }

        this.unregisterRtcStatusCallbacks();
    }

    private unregisterRtcStatusCallbacks(
        ctx: ApiMiddleware | undefined = this.readMiddleware(),
    ): void {
        if (!ctx) {
            return;
        }

        const service = ctx.middleware.webRtcConnectionService;
        service.removeRtcPeerLifecycleById(RALLAR_RTC_STATUS_CALLBACK_ID);
        for (const peerId of service.knownPeerIds()) {
            const peer = service.readPeer(peerId);
            if (peer) {
                this.unregisterRtcStatusCallbacksForPeer(peer);
            }
        }
    }

    private unregisterRtcStatusCallbacksForPeer(peer: QRtcPeerDto): void {
        for (const channel of peer.channels.values()) {
            channel.removeRtcCallbackById(RALLAR_RTC_STATUS_CALLBACK_ID);
        }
    }

    private hasRtcStatusSubscriptions(): boolean {
        return this.rtcStatusListeners.size > 0 ||
            this.rtcLifecycleListeners.size > 0;
    }

    private emitRtcLifecycleSoon(
        kind: RallarRtcLifecycleKind,
        input: Readonly<{
            peerId?: string;
            laneId?: string;
        }> = {},
    ): void {
        queueMicrotask(() => this.emitRtcLifecycle(kind, input));
    }

    private emitRtcLifecycle(
        kind: RallarRtcLifecycleKind,
        input: Readonly<{
            peerId?: string;
            laneId?: string;
        }> = {},
    ): void {
        this.emitRtcStatus();
        for (const subscription of this.rtcLifecycleListeners) {
            this.notifyRtcLifecycleSubscription(subscription, kind, input);
        }
    }

    private emitRtcStatus(): void {
        for (const subscription of this.rtcStatusListeners) {
            notifyListener(
                subscription.listener,
                this.toRtcStatus(subscription.options),
            );
        }
    }

    private notifyRtcLifecycleSubscription(
        subscription: RallarRtcLifecycleSubscription,
        kind: RallarRtcLifecycleKind,
        input: Readonly<{
            peerId?: string;
            laneId?: string;
        }> = {},
    ): void {
        const status = this.toRtcStatus(subscription.options);
        const peer = input.peerId
            ? status.peers.find((candidate) => candidate.peerId === input.peerId)
            : undefined;
        const lane = input.laneId
            ? peer?.lanes.find((candidate) => candidate.laneId === input.laneId)
            : undefined;

        notifyListener(subscription.listener, {
            kind,
            atEpochMs: Date.now(),
            status,
            peerId: input.peerId,
            laneId: input.laneId,
            peer,
            lane,
        });
    }

    private toRoomState(): RallarRoomState {
        const session = readSession();
        const sessionId = session?.sessionId;
        const rooms = this.readGroupSnapshots()
            .filter(isGroupActive)
            .sort((left, right) =>
                readGroupDisplayName(left).localeCompare(readGroupDisplayName(right))
            );
        const currentRoomRef = this.resolveCurrentRoomRef();
        const currentRoomId = currentRoomRef?.groupId;
        const currentRoom = currentRoomRef
            ? this.findGroupSnapshot(currentRoomRef)
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
            currentRoomId,
            currentRoomRef,
            currentRoom,
            members: this.toRoomMembers(currentRoom),
        };
    }

    private toRoomMembers(
        currentRoom: GroupSnapshot | undefined,
    ): readonly RallarRoomMember[] {
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
                const client = this.findClientSnapshot(member.principalId);
                const sessionIds = sessionIdsByPrincipalId.get(member.principalId) ??
                    [];

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
    }

    private toPeopleState(): RallarPeopleState {
        const clients = this.readClientSnapshots()
            .sort((left, right) =>
                toPersonName(left).localeCompare(toPersonName(right))
            );

        return {
            people: clients.map(toPerson),
            clients,
        };
    }

    private resolveCurrentRoomId(): string | undefined {
        return this.resolveCurrentRoomRef()?.groupId;
    }

    private resolveCurrentRoomRef(): GroupRef | undefined {
        const session = readSession();
        if (!session) {
            return undefined;
        }

        if (this.currentRoomRef) {
            const current = this.findGroupSnapshot(this.currentRoomRef);
            if (
                current &&
                isGroupActive(current) &&
                isSessionInGroup(current, session.sessionId)
            ) {
                return current.group;
            }
        }

        if (this.currentRoomId) {
            const current = this.findGroupSnapshot(this.currentRoomId);
            if (
                current &&
                isGroupActive(current) &&
                isSessionInGroup(current, session.sessionId)
            ) {
                return current.group;
            }
        }

        return this.findFirstGroupSnapshotRefForSession(session.sessionId);
    }

    private readGroupSnapshots(): GroupSnapshot[] {
        return readRallarCacheOrDefault(
            () => groupStateSnapshotsRepository.getAllGroupStateSnapshots(),
            [],
        );
    }

    private findGroupSnapshot(room: string | GroupRef | undefined): GroupSnapshot | undefined {
        if (!room) {
            return undefined;
        }
        if (typeof room !== 'string') {
            return readRallarCacheOrDefault(
                () => groupStateSnapshotsRepository.findGroupStateSnapshotByRef(room),
                undefined,
            );
        }

        const scopedRef = this.resolveGroupRefFromRoomId(room);
        if (scopedRef) {
            const scopedSnapshot = readRallarCacheOrDefault(
                () => groupStateSnapshotsRepository.findGroupStateSnapshotByRef(scopedRef),
                undefined,
            );
            if (scopedSnapshot) {
                return scopedSnapshot;
            }
        }

        return this.readGroupSnapshots()
            .filter((snapshot) => snapshot.group.groupId === room)
            .sort((left, right) => readGroupVersion(right) - readGroupVersion(left))
            .at(0);
    }

    private resolveRoomMinSnapshotVersion(
        room: string | GroupRef | undefined,
        explicitMinSnapshotVersion?: number,
    ): number | undefined {
        const cached = this.findGroupSnapshot(room);
        const cachedVersion = cached ? readGroupVersion(cached) : undefined;

        if (explicitMinSnapshotVersion === undefined) {
            return cachedVersion;
        }

        if (cachedVersion === undefined) {
            return explicitMinSnapshotVersion;
        }

        return Math.max(explicitMinSnapshotVersion, cachedVersion);
    }

    private findFirstGroupSnapshotRefForSession(
        sessionId: string,
    ): GroupRef | undefined {
        const fromRepository = readRallarCacheOrDefault(
            () =>
                groupStateSnapshotsRepository
                    .findFirstGroupStateSnapshotRefSessionIdIsIn(sessionId),
            undefined,
        );
        if (fromRepository) {
            return fromRepository;
        }

        return this.readGroupSnapshots()
            .find((snapshot) =>
                snapshot.activeSessions.some((activeSession) =>
                    activeSession.sessionId === sessionId
                )
            )
            ?.group;
    }

    private setCurrentRoom(snapshot: GroupSnapshot): void {
        this.currentRoomId = readGroupId(snapshot);
        this.currentRoomRef = snapshot.group;
    }

    private clearCurrentRoomIfMatches(
        room: string | GroupRef,
        clearCurrent: boolean,
    ): void {
        if (!clearCurrent) {
            return;
        }

        if (
            typeof room === 'string'
                ? this.currentRoomId === room
                : this.currentRoomRef
                    ? isSameGroupRef(this.currentRoomRef, room)
                    : this.currentRoomId === room.groupId
        ) {
            this.currentRoomId = undefined;
            this.currentRoomRef = undefined;
        }
    }

    private toRoomId(room: string | GroupRef | undefined): string | undefined {
        return typeof room === 'string' ? room : room?.groupId;
    }

    private resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined {
        if (!room) {
            return undefined;
        }

        if (typeof room !== 'string') {
            return room;
        }

        return this.resolveGroupRefFromRoomId(room) ??
            this.findGroupSnapshot(room)?.group;
    }

    private resolveOperationOptions<T extends RallarOperationOptions>(
        options: T,
    ): T & RallarOperationOptions {
        const timeoutMs = options.timeoutMs !== undefined
            ? options.timeoutMs
            : this.configuredDefaults?.operations?.timeoutMs;
        const maxAttempts = options.maxAttempts !== undefined
            ? options.maxAttempts
            : this.configuredDefaults?.operations?.maxAttempts;
        const shouldRetry = options.shouldRetry ??
            this.configuredDefaults?.operations?.shouldRetry;
        const dataChannelLanes = options.dataChannelLanes !== undefined
            ? options.dataChannelLanes
            : this.configuredDefaults?.rtc?.dataChannelLanes;

        if (
            timeoutMs === undefined &&
            maxAttempts === undefined &&
            shouldRetry === undefined &&
            dataChannelLanes === undefined
        ) {
            return options;
        }

        return {
            ...options,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(maxAttempts !== undefined ? { maxAttempts } : {}),
            ...(shouldRetry !== undefined ? { shouldRetry } : {}),
            ...(dataChannelLanes !== undefined ? { dataChannelLanes } : {}),
        };
    }

    private resolveOperationScope(scope?: StateScope): StateScope | undefined {
        return scope ?? this.defaultScope;
    }

    private resolveRoomEventListScope(
        options: RallarListRoomEventsOptions,
    ): StateScope {
        if (options.roomRef) {
            return {
                applicationId: options.roomRef.applicationId,
                workspaceId: options.roomRef.workspaceId ??
                    DEFAULT_STATE_WORKSPACE_ID,
            };
        }

        return this.resolveOperationScope(options.scope) ??
            api.defaultStateScope();
    }

    private resolveGroupRefFromRoomId(
        roomId: string,
        scope?: StateScope,
    ): GroupRef | undefined {
        return toGroupRefFromScope(
            roomId,
            this.resolveOperationScope(scope),
        );
    }

    private toRefreshOptions(
        options: RallarStartOptions,
        operationOptions: RallarOperationOptions,
    ): RallarRefreshOptions {
        return {
            ...(options.scope ? { scope: options.scope } : {}),
            ...(operationOptions.signal ? { signal: operationOptions.signal } : {}),
            ...(operationOptions.timeoutMs !== undefined
                ? { timeoutMs: operationOptions.timeoutMs }
                : {}),
            ...(operationOptions.maxAttempts !== undefined
                ? { maxAttempts: operationOptions.maxAttempts }
                : {}),
            ...(operationOptions.shouldRetry !== undefined
                ? { shouldRetry: operationOptions.shouldRetry }
                : {}),
            ...(operationOptions.dataChannelLanes !== undefined
                ? { dataChannelLanes: operationOptions.dataChannelLanes }
                : {}),
        };
    }

    private resolveDefaultRoom(): string | GroupRef | undefined {
        return this.resolveDefaultRoomRef() ??
            this.configuredDefaults?.room?.roomId;
    }

    private resolveDefaultRoomRef(): GroupRef | undefined {
        const defaultRoom = this.configuredDefaults?.room;
        if (!defaultRoom) {
            return undefined;
        }

        return defaultRoom.roomRef ??
            (defaultRoom.roomId
                ? this.resolveGroupRefFromRoomId(defaultRoom.roomId)
                : undefined);
    }

    private resolveRealtimeLaneId(laneId?: string): string {
        return laneId ??
            this.configuredDefaults?.realtime?.laneId ??
            DEFAULT_RALLAR_REALTIME_LANE_ID;
    }

    private resolveRealtimeOpenTimeoutMs(openTimeoutMs?: number): number {
        return openTimeoutMs ??
            this.configuredDefaults?.realtime?.openTimeoutMs ??
            DEFAULT_RALLAR_REALTIME_OPEN_TIMEOUT_MS;
    }

    private resolveRtcWaitTimeoutMs(timeoutMs?: number): number | undefined {
        return timeoutMs ??
            this.configuredDefaults?.rtc?.waitTimeoutMs;
    }

    private resolveRtcConnectOnWait(connect?: boolean): boolean {
        return connect ??
            this.configuredDefaults?.rtc?.connectOnWait ??
            false;
    }

    private readClientSnapshots(): ClientSnapshot[] {
        return readRallarCacheOrDefault(
            () => clientStateSnapshotsRepository.getAllClientStateSnapshots(),
            [],
        );
    }

    private findClientSnapshot(
        principalId: string,
    ): ClientSnapshot | undefined {
        return readRallarCacheOrDefault(
            () =>
                clientStateSnapshotsRepository
                    .findClientStateSnapshotByPrincipalId(principalId),
            undefined,
        );
    }

    private onTransportMessage(
        transport: RallarMessageTransport,
        selectorInput: RallarMessageSelectorInput,
        handler: RallarMessageHandler<unknown>,
    ): RallarUnsubscribe {
        const selector = normalizeRallarMessageSelector(selectorInput);
        if (transport === 'rtc' && !selector.typeId) {
            throw new Error('RTC message subscriptions require a typeId.');
        }

        const subscription = this.messageSubscription(transport, selector);
        subscription.listeners.add(handler);

        if (this.readMiddleware()) {
            this.registerMessageCallback(transport, selector);
        }

        return () => {
            subscription.listeners.delete(handler);
            if (subscription.listeners.size > 0) {
                return;
            }

            const registry = transport === 'rtc'
                ? this.rtcMessageListeners
                : this.wsMessageListeners;
            registry.delete(toMessageSelectorKey(selector));

            if (transport === 'rtc' && selector.typeId) {
                if (!this.hasRtcSubscriptionsForTypeId(selector.typeId)) {
                    this.unregisterMessageCallback(transport, selector);
                }
                return;
            }

            if (
                transport === 'ws' &&
                this.wsMessageListeners.size === 0 &&
                !this.hasStateEventSubscriptions()
            ) {
                this.unregisterMessageCallback(transport, selector);
            }
        };
    }

    private onRoomEvent(
        listener: RallarRoomEventListener,
        options: RallarRoomEventOptions,
    ): RallarUnsubscribe {
        const subscription: RallarRoomEventSubscription = {
            listener,
            options,
        };
        this.roomEventSubscriptions.add(subscription);
        this.registerStateEventCallbacks();

        return () => {
            this.roomEventSubscriptions.delete(subscription);
            this.unregisterStateEventCallbacksIfUnused();
        };
    }

    private onPeopleEvent(
        listener: RallarPeopleEventListener,
        options: RallarPeopleEventOptions,
    ): RallarUnsubscribe {
        const subscription: RallarPeopleEventSubscription = {
            listener,
            options,
        };
        this.peopleEventSubscriptions.add(subscription);
        this.registerStateEventCallbacks();

        return () => {
            this.peopleEventSubscriptions.delete(subscription);
            this.unregisterStateEventCallbacksIfUnused();
        };
    }

    private async replayRoomEvents(
        options: RallarReplayRoomEventsOptions,
        listener?: RallarRoomEventListener,
    ): Promise<RallarReplayEventsResult<GroupEvent>> {
        const operationOptions = this.resolveOperationOptions(options);
        const roomId = options.roomRef?.groupId ?? options.roomId;
        if (!roomId) {
            throw new Error(
                'Cannot replay room events: roomId or roomRef is required.',
            );
        }

        const scope = this.resolveRoomEventListScope(options);
        return await runRallarCommand(
            async (signal) => {
                let after = options.after;
                let hasMore = false;
                let nextCursor: StateEventCursor | undefined;
                let pageCount = 0;
                let duplicateCount = 0;
                const replayedEvents: GroupEvent[] = [];
                const maxPages = toReplayMaxPages(options.maxPages);

                while (pageCount < maxPages) {
                    const page = await api.listStateGroupEventPage(
                        roomId,
                        scope,
                        toStateEventListRequestOptions(
                            {
                                ...options,
                                after,
                            },
                            signal,
                        ),
                    );
                    pageCount += 1;
                    hasMore = page.hasMore;
                    nextCursor = page.nextCursor;

                    for (const event of page.events) {
                        const result = await this.replayRoomEvent(event, listener);
                        if (result === 'duplicate') {
                            duplicateCount += 1;
                        } else if (result === 'replayed') {
                            replayedEvents.push(event);
                        }
                    }

                    if (!page.hasMore || !page.nextCursor) {
                        break;
                    }
                    after = page.nextCursor;
                }

                return {
                    events: replayedEvents,
                    ...(nextCursor ? { nextCursor } : {}),
                    hasMore,
                    pageCount,
                    replayedCount: replayedEvents.length,
                    duplicateCount,
                };
            },
            operationOptions,
        );
    }

    private async replayPeopleEvents(
        principalId: string,
        options: RallarReplayPeopleEventsOptions,
        listener?: RallarPeopleEventListener,
    ): Promise<RallarReplayEventsResult<ClientEvent>> {
        const operationOptions = this.resolveOperationOptions(options);
        const scope = this.resolveOperationScope(options.scope) ??
            api.defaultStateScope();
        return await runRallarCommand(
            async (signal) => {
                let after = options.after;
                let hasMore = false;
                let nextCursor: StateEventCursor | undefined;
                let pageCount = 0;
                let duplicateCount = 0;
                const replayedEvents: ClientEvent[] = [];
                const maxPages = toReplayMaxPages(options.maxPages);

                while (pageCount < maxPages) {
                    const page = await api.listStateClientEventPage(
                        principalId,
                        scope,
                        toStateEventListRequestOptions(
                            {
                                ...options,
                                after,
                            },
                            signal,
                        ),
                    );
                    pageCount += 1;
                    hasMore = page.hasMore;
                    nextCursor = page.nextCursor;

                    for (const event of page.events) {
                        const result = await this.replayPeopleEvent(event, listener);
                        if (result === 'duplicate') {
                            duplicateCount += 1;
                        } else if (result === 'replayed') {
                            replayedEvents.push(event);
                        }
                    }

                    if (!page.hasMore || !page.nextCursor) {
                        break;
                    }
                    after = page.nextCursor;
                }

                return {
                    events: replayedEvents,
                    ...(nextCursor ? { nextCursor } : {}),
                    hasMore,
                    pageCount,
                    replayedCount: replayedEvents.length,
                    duplicateCount,
                };
            },
            operationOptions,
        );
    }

    private async replayRoomEvent(
        event: GroupEvent,
        listener?: RallarRoomEventListener,
    ): Promise<'replayed' | 'duplicate' | 'no-listeners'> {
        if (!isGroupEventPayload(event)) {
            return 'no-listeners';
        }

        const dedupeKey = toGroupStateEventDedupeKey(event);
        if (this.seenGroupEventKeys.has(dedupeKey)) {
            return 'duplicate';
        }

        const message = toReplayGroupStateEventMessage(event);
        if (listener) {
            rememberStateEventKey(this.seenGroupEventKeys, dedupeKey);
            await notifyStateEventListener(listener, event, message);
            return 'replayed';
        }

        const subscriptions = [...this.roomEventSubscriptions]
            .filter((subscription) =>
                this.matchesRoomEventSubscription(subscription, event)
            );
        if (subscriptions.length === 0) {
            return 'no-listeners';
        }

        rememberStateEventKey(this.seenGroupEventKeys, dedupeKey);
        await Promise.all(
            subscriptions.map(async (subscription) =>
                await notifyStateEventListener(
                    subscription.listener,
                    event,
                    message,
                )
            ),
        );
        return 'replayed';
    }

    private async replayPeopleEvent(
        event: ClientEvent,
        listener?: RallarPeopleEventListener,
    ): Promise<'replayed' | 'duplicate' | 'no-listeners'> {
        if (!isClientEventPayload(event)) {
            return 'no-listeners';
        }

        const dedupeKey = toClientStateEventDedupeKey(event);
        if (this.seenClientEventKeys.has(dedupeKey)) {
            return 'duplicate';
        }

        const message = toReplayClientStateEventMessage(event);
        if (listener) {
            rememberStateEventKey(this.seenClientEventKeys, dedupeKey);
            await notifyStateEventListener(listener, event, message);
            return 'replayed';
        }

        const subscriptions = [...this.peopleEventSubscriptions]
            .filter((subscription) =>
                this.matchesPeopleEventSubscription(subscription, event)
            );
        if (subscriptions.length === 0) {
            return 'no-listeners';
        }

        rememberStateEventKey(this.seenClientEventKeys, dedupeKey);
        await Promise.all(
            subscriptions.map(async (subscription) =>
                await notifyStateEventListener(
                    subscription.listener,
                    event,
                    message,
                )
            ),
        );
        return 'replayed';
    }

    private registerStateEventCallbacks(): void {
        if (!this.readMiddleware() || !this.hasStateEventSubscriptions()) {
            return;
        }

        this.registerMessageCallback('ws', {});
    }

    private unregisterStateEventCallbacksIfUnused(): void {
        if (
            this.wsMessageListeners.size === 0 &&
            !this.hasStateEventSubscriptions()
        ) {
            this.unregisterMessageCallback('ws', {});
        }
    }

    private hasStateEventSubscriptions(): boolean {
        return this.roomEventSubscriptions.size > 0 ||
            this.peopleEventSubscriptions.size > 0;
    }

    private messageSubscription(
        transport: RallarMessageTransport,
        selector: RallarMessageSelector,
    ): RallarMessageSubscription {
        const registry = transport === 'rtc'
            ? this.rtcMessageListeners
            : this.wsMessageListeners;
        const key = toMessageSelectorKey(selector);
        const existing = registry.get(key);
        if (existing) {
            return existing;
        }

        const created: RallarMessageSubscription = {
            selector,
            listeners: new Set<RallarMessageHandler<unknown>>(),
        };
        registry.set(key, created);
        return created;
    }

    private registerAllMessageCallbacks(): void {
        for (const subscription of this.rtcMessageListeners.values()) {
            this.registerMessageCallback('rtc', subscription.selector);
        }
        if (
            this.wsMessageListeners.size > 0 ||
            this.hasStateEventSubscriptions()
        ) {
            this.registerMessageCallback('ws', {});
        }
    }

    private registerMessageCallback(
        transport: RallarMessageTransport,
        selector: RallarMessageSelector,
    ): void {
        const ctx = this.readMiddleware();
        if (!ctx) {
            return;
        }

        if (transport === 'rtc') {
            const typeId = selector.typeId;
            if (!typeId) {
                throw new Error('RTC message callbacks require a typeId.');
            }

            if (this.registeredRtcMessageTypes.has(typeId)) {
                return;
            }

            ctx.middleware.rtcRxStreamer.onInboxMessageDo(typeId, {
                onMessage: async (message: ALMessage) => {
                    await this.dispatchTransportMessage('rtc', message);
                },
            });
            this.registeredRtcMessageTypes.add(typeId);
            return;
        }

        if (this.wsAnyMessageCallbackRegistered) {
            return;
        }

        ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo(
            RALLAR_WS_ANY_MESSAGE_CALLBACK_ID,
            {
                onMessage: async (message: ALMessage) => {
                    await this.dispatchTransportMessage('ws', message);
                },
            },
        );
        this.wsAnyMessageCallbackRegistered = true;
    }

    private unregisterMessageCallback(
        transport: RallarMessageTransport,
        selector: RallarMessageSelector,
    ): void {
        const ctx = this.readMiddleware();
        if (!ctx) {
            return;
        }

        if (transport === 'rtc') {
            const typeId = selector.typeId;
            if (!typeId) {
                return;
            }

            ctx.middleware.rtcRxStreamer.removeInboxMessageCallback(typeId);
            this.registeredRtcMessageTypes.delete(typeId);
            return;
        }

        ctx.middleware.webSocketQueueBox.removeAnyInboxMessageCallback(
            RALLAR_WS_ANY_MESSAGE_CALLBACK_ID,
        );
        this.wsAnyMessageCallbackRegistered = false;
    }

    private registerRealtimeLifecycleCallback(ctx: ApiMiddleware): void {
        ctx.middleware.webRtcConnectionService.onRtcPeerLifecycleDo(
            RALLAR_REALTIME_LIFECYCLE_CALLBACK_ID,
            {
                onCreated: (peer) => this.registerRealtimeCallbacksForPeer(peer),
                onDeleted: (peer) => {
                    for (const laneId of this.realtimeLaneIds()) {
                        peer.channels.get(laneId)?.removeOnRawMessageCallbackById(
                            this.toRealtimeCallbackId(laneId),
                        );
                    }
                },
            },
        );
    }

    private registerAllRealtimeCallbacks(): void {
        for (const laneId of this.realtimeLaneIds()) {
            this.registerRealtimeLaneCallbacks(laneId);
        }
    }

    private registerRealtimeLaneCallbacks(laneId: string): void {
        const ctx = this.readMiddleware();
        if (!ctx) {
            return;
        }

        const peerIds = ctx.middleware.webRtcConnectionService.activePeerIds();
        for (const peerId of peerIds) {
            const peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
            if (peer) {
                this.registerRealtimeCallbacksForPeer(peer, laneId);
            }
        }
    }

    private registerRealtimeCallbacksForPeer(
        peer: QRtcPeerDto,
        laneId?: string,
    ): void {
        const laneIds = laneId ? [laneId] : this.realtimeLaneIds();
        for (const currentLaneId of laneIds) {
            const channel = peer.channels.get(currentLaneId);
            if (!channel) {
                continue;
            }

            channel.onRawMessageDo(
                this.toRealtimeCallbackId(currentLaneId),
                {
                    onMessage: async (data, event) => {
                        await this.dispatchRealtimeMessage(
                            peer.peerId,
                            currentLaneId,
                            data,
                            event,
                        );
                    },
                },
            );
        }
    }

    private async dispatchRealtimeMessage(
        peerId: string,
        laneId: string,
        data: MessageEvent['data'],
        event: MessageEvent,
    ): Promise<void> {
        if (typeof data === 'string') {
            await this.dispatchRealtimeJson(peerId, laneId, data, event);
            return;
        }

        await this.dispatchRealtimeBinary(peerId, laneId, data, event);
    }

    private async dispatchRealtimeJson(
        peerId: string,
        laneId: string,
        data: string,
        event: MessageEvent,
    ): Promise<void> {
        const listeners = this.realtimeJsonListeners.get(laneId);
        if (!listeners || listeners.size === 0) {
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch (error) {
            console.error('Error parsing Rallar realtime JSON message', error);
            return;
        }

        await this.notifyRealtimeListeners(listeners, {
            peerId,
            laneId,
            data: parsed,
            event,
            receivedAtEpochMs: Date.now(),
        });
    }

    private async dispatchRealtimeBinary(
        peerId: string,
        laneId: string,
        data: MessageEvent['data'],
        event: MessageEvent,
    ): Promise<void> {
        const listeners = this.realtimeBinaryListeners.get(laneId);
        if (!listeners || listeners.size === 0) {
            return;
        }

        const bytes = await toArrayBuffer(data);
        if (!bytes) {
            return;
        }

        await this.notifyRealtimeListeners(listeners, {
            peerId,
            laneId,
            data: bytes,
            event,
            receivedAtEpochMs: Date.now(),
        });
    }

    private async notifyRealtimeListeners<T>(
        listeners: Set<RallarRealtimeHandler<T>>,
        message: RallarRealtimeMessage<T>,
    ): Promise<void> {
        await Promise.all(
            [...listeners].map(async (listener) => {
                try {
                    await listener(message);
                } catch (error) {
                    console.error('Error notifying Rallar realtime listener', error);
                }
            }),
        );
    }

    private deleteRealtimeLaneIfUnused(laneId: string): void {
        const jsonListeners = this.realtimeJsonListeners.get(laneId);
        if (jsonListeners?.size === 0) {
            this.realtimeJsonListeners.delete(laneId);
        }

        const binaryListeners = this.realtimeBinaryListeners.get(laneId);
        if (binaryListeners?.size === 0) {
            this.realtimeBinaryListeners.delete(laneId);
        }

        if (
            this.realtimeJsonListeners.has(laneId) ||
            this.realtimeBinaryListeners.has(laneId)
        ) {
            return;
        }

        const ctx = this.readMiddleware();
        if (!ctx) {
            return;
        }

        const peerIds = ctx.middleware.webRtcConnectionService.knownPeerIds();
        for (const peerId of peerIds) {
            ctx.middleware.webRtcConnectionService
                .readPeer(peerId)
                ?.channels.get(laneId)
                ?.removeOnRawMessageCallbackById(this.toRealtimeCallbackId(laneId));
        }
    }

    private realtimeLaneIds(): readonly string[] {
        return [
            ...new Set([
                ...this.realtimeJsonListeners.keys(),
                ...this.realtimeBinaryListeners.keys(),
            ]),
        ];
    }

    private resolveRoomPeerIds(room: string | GroupRef): readonly string[] {
        const session = readSession();
        const snapshot = this.findGroupSnapshot(room);
        const peerIds = (snapshot?.activeSessions ?? [])
            .map((activeSession) => activeSession.sessionId)
            .filter((sessionId) => sessionId !== session?.sessionId);

        return [...new Set(peerIds)];
    }

    private resolveTargetPeerIds(
        input: RallarTargetSelector = {},
    ): readonly string[] {
        const session = readSession();
        const explicitPeerIds = input.peerIds ??
            (input.peerId ? [input.peerId] : undefined);
        if (explicitPeerIds) {
            return [...new Set(explicitPeerIds)]
                .filter((peerId) => peerId !== session?.sessionId);
        }

        const room = input.roomRef ??
            input.roomId ??
            this.resolveDefaultRoom() ??
            this.resolveCurrentRoomRef();
        return room ? this.resolveRoomPeerIds(room) : [];
    }

    private resolveCallLaneIds(
        input: RallarCallStartInput,
    ): readonly string[] {
        if (!input.data) {
            return input.media ? [] : [DEFAULT_RTC_DATA_CHANNEL_LANE_ID];
        }

        const lanes = input.data.lanes?.length
            ? input.data.lanes
            : [DEFAULT_RTC_DATA_CHANNEL_LANE_ID];
        return [...new Set(lanes.filter((laneId) => laneId.length > 0))];
    }

    private resolveRealtimePeerIds(
        input: RallarRealtimeSendOptions,
    ): readonly string[] {
        const session = readSession();
        if (input.peerIds) {
            return [...new Set(input.peerIds)]
                .filter((sessionId) => sessionId !== session?.sessionId);
        }

        const defaultRoom = this.resolveDefaultRoom();
        const room = input.roomRef
            ? this.findGroupSnapshot(input.roomRef)
            : input.roomId
                ? this.findGroupSnapshot(input.roomId)
                : defaultRoom
                    ? this.findGroupSnapshot(defaultRoom)
                    : this.toRoomState().currentRoom;

        const peerIds = (room?.activeSessions ?? [])
            .map((activeSession) => activeSession.sessionId)
            .filter((sessionId) => sessionId !== session?.sessionId);

        return [...new Set(peerIds)];
    }

    private async ensureRealtimeLaneOpen(
        ctx: ApiMiddleware,
        peerId: string,
        laneId: string,
        input: RallarRealtimeSendOptions,
    ): Promise<WebRtcPeerLaneOpenResult> {
        return await ctx.middleware.webRtcConnectionService.ensurePeerLaneOpen(
            peerId,
            laneId,
            {
                timeoutMs: this.resolveRealtimeOpenTimeoutMs(input.openTimeoutMs),
            },
        );
    }

    private toRealtimeCallbackId(laneId: string): string {
        return `rallar:realtime:${laneId}`;
    }

    private async dispatchTransportMessage(
        transport: RallarMessageTransport,
        message: ALMessage,
    ): Promise<void> {
        const registry = transport === 'rtc'
            ? this.rtcMessageListeners
            : this.wsMessageListeners;
        const listeners = new Set<RallarMessageHandler<unknown>>();

        for (const subscription of registry.values()) {
            if (!matchesRallarMessageSelector(subscription.selector, message)) {
                continue;
            }

            for (const listener of subscription.listeners) {
                listeners.add(listener);
            }
        }

        const shouldDispatchStateEvent =
            transport === 'ws' &&
            this.isStateEventMessage(message) &&
            this.hasStateEventSubscriptions();

        if (listeners.size === 0 && !shouldDispatchStateEvent) {
            return;
        }

        const rallarMessage = toRallarMessage(transport, message);
        if (shouldDispatchStateEvent) {
            await this.dispatchStateEventMessage(rallarMessage);
        }

        if (listeners.size === 0) {
            return;
        }

        await Promise.all(
            [...listeners].map(async (listener) => {
                try {
                    await listener(rallarMessage);
                } catch (error) {
                    console.error('Error notifying Rallar message listener', error);
                }
            }),
        );
    }

    private isStateEventMessage(message: ALMessage): boolean {
        return message.payload.typeId === AppTopics.groupStateEvent ||
            message.payload.typeId === AppTopics.clientStateEvent;
    }

    private async dispatchStateEventMessage(
        message: RallarMessage<unknown>,
    ): Promise<void> {
        if (message.typeId === AppTopics.groupStateEvent) {
            await this.dispatchRoomStateEvent(
                message as RallarMessage<GroupEvent>,
            );
            return;
        }

        if (message.typeId === AppTopics.clientStateEvent) {
            await this.dispatchPeopleStateEvent(
                message as RallarMessage<ClientEvent>,
            );
        }
    }

    private async dispatchRoomStateEvent(
        message: RallarMessage<GroupEvent>,
    ): Promise<void> {
        const event = message.payload;
        if (!isGroupEventPayload(event)) {
            return;
        }

        const subscriptions = [...this.roomEventSubscriptions]
            .filter((subscription) =>
                this.matchesRoomEventSubscription(subscription, event)
            );
        if (subscriptions.length === 0) {
            return;
        }

        const dedupeKey = toGroupStateEventDedupeKey(event);
        if (this.seenGroupEventKeys.has(dedupeKey)) {
            return;
        }
        rememberStateEventKey(this.seenGroupEventKeys, dedupeKey);

        await Promise.all(
            subscriptions.map(async (subscription) =>
                await notifyStateEventListener(
                    subscription.listener,
                    event,
                    message,
                )
            ),
        );
    }

    private async dispatchPeopleStateEvent(
        message: RallarMessage<ClientEvent>,
    ): Promise<void> {
        const event = message.payload;
        if (!isClientEventPayload(event)) {
            return;
        }

        const subscriptions = [...this.peopleEventSubscriptions]
            .filter((subscription) =>
                this.matchesPeopleEventSubscription(subscription, event)
            );
        if (subscriptions.length === 0) {
            return;
        }

        const dedupeKey = toClientStateEventDedupeKey(event);
        if (this.seenClientEventKeys.has(dedupeKey)) {
            return;
        }
        rememberStateEventKey(this.seenClientEventKeys, dedupeKey);

        await Promise.all(
            subscriptions.map(async (subscription) =>
                await notifyStateEventListener(
                    subscription.listener,
                    event,
                    message,
                )
            ),
        );
    }

    private matchesRoomEventSubscription(
        subscription: RallarRoomEventSubscription,
        event: GroupEvent,
    ): boolean {
        const { options } = subscription;
        if (
            options.eventTypes &&
            !options.eventTypes.includes(event.eventType)
        ) {
            return false;
        }

        if (
            options.roomRef &&
            !isSameStateGroupRef(event, options.roomRef)
        ) {
            return false;
        }

        if (
            !options.roomRef &&
            options.roomId &&
            event.groupId !== options.roomId
        ) {
            return false;
        }

        const scope = options.scope ?? this.defaultScope;
        return isSameStateScopeValue(event, scope);
    }

    private matchesPeopleEventSubscription(
        subscription: RallarPeopleEventSubscription,
        event: ClientEvent,
    ): boolean {
        const { options } = subscription;
        if (
            options.eventTypes &&
            !options.eventTypes.includes(event.eventType)
        ) {
            return false;
        }

        if (options.principalId && event.principalId !== options.principalId) {
            return false;
        }

        const scope = options.scope ?? this.defaultScope;
        return isSameStateScopeValue(event, scope);
    }

    private hasRtcSubscriptionsForTypeId(typeId: string): boolean {
        for (const subscription of this.rtcMessageListeners.values()) {
            if (subscription.selector.typeId === typeId) {
                return true;
            }
        }

        return false;
    }

    private registerRemoteStreamCallback(): void {
        if (
            this.remoteStreamCallbackRegistered ||
            this.remoteStreamListeners.size === 0
        ) {
            return;
        }

        const ctx = this.readMiddleware();
        if (!ctx) {
            return;
        }

        ctx.middleware.rtcRxStreamer.onRemoteStreamDo(
            RALLAR_REMOTE_STREAM_CALLBACK_ID,
            async (peerId, stream, event) => {
                await Promise.all(
                    [...this.remoteStreamListeners].map(async (listener) => {
                        try {
                            await listener({ peerId, stream, event });
                        } catch (error) {
                            console.error(
                                'Error notifying Rallar remote stream listener',
                                error,
                            );
                        }
                    }),
                );
            },
        );
        this.remoteStreamCallbackRegistered = true;
    }

    private unregisterRemoteStreamCallback(): void {
        const ctx = this.readMiddleware();
        if (!ctx || !this.remoteStreamCallbackRegistered) {
            return;
        }

        ctx.middleware.rtcRxStreamer.removeOnRemoteStreamCallbackById(
            RALLAR_REMOTE_STREAM_CALLBACK_ID,
        );
        this.remoteStreamCallbackRegistered = false;
    }

    private readMiddleware(): ApiMiddleware | undefined {
        if (this.ctx) {
            return this.ctx;
        }

        if (!isMiddlewareReady()) {
            return undefined;
        }

        this.ctx = getMiddleware();
        return this.ctx;
    }

    private requireMiddleware(): ApiMiddleware {
        const ctx = this.readMiddleware();
        if (!ctx) {
            throw new Error('Rallar is not connected. Call rallar.connect() first.');
        }

        return ctx;
    }

    private requireSession(): AuthSession {
        const session = readSession();
        if (!session) {
            throw new Error('Rallar requires an auth session.');
        }

        return session;
    }

    private async closeAuthenticatedDataScopes(): Promise<void> {
        if (!readSession()) {
            return;
        }

        await Promise.all([
            this.data.closeScope('session'),
            this.data.closeScope('principal'),
        ]);
    }

    private resolveDataScopeKey(scope: RallarDataScope): string {
        if (scope === 'app') {
            return 'app';
        }

        if (scope === 'principal') {
            return `principal:${this.requireSession().clientId}`;
        }

        if (scope === 'session') {
            return `session:${this.requireSession().sessionId}`;
        }

        return String(scope);
    }
}

function toRtcConnectionStatus(
    peer: QRtcPeerDto | undefined,
): RallarRtcPeerConnectionStatus {
    const status = peer?.connection.status;
    const pc = status?.pc;

    return {
        state: status?.state ? String(status.state) : undefined,
        connectionState: pc?.connectionState,
        iceConnectionState: pc?.iceConnectionState,
        iceGatheringState: pc?.iceGatheringState,
        signalingState: pc?.signalingState,
        hasLocalDescription: pc?.localDescription !== null &&
            pc?.localDescription !== undefined,
        hasRemoteDescription: pc?.remoteDescription !== null &&
            pc?.remoteDescription !== undefined,
        canTrickleIceCandidates: pc?.canTrickleIceCandidates,
        reconnectAttempts: status?.reconnectAttempts ?? 0,
        reconnecting: status?.reconnectTimer !== undefined,
        disconnectPending: status?.disconnectTimer !== undefined,
        makingOffer: status?.makingOffer ?? false,
        ignoreOffer: status?.ignoreOffer ?? false,
        iceCandidateQueueSize: status?.iceCandidateQueue.length ?? 0,
        localStreamId: status?.localStream?.id,
        remoteStreamIds: Array.from(status?.remoteStreams.keys() ?? []),
    };
}

function toRtcLaneStatus(
    peerId: string,
    laneId: string,
    channel: RtcDataChannelHealth | undefined,
): RallarRtcLaneStatus {
    return {
        peerId,
        laneId,
        channel,
        isOpen: channel?.readyState === 'open' || channel?.state === 'Open',
        isReconnectable: isReconnectableRtcLane(channel),
    };
}

function isReconnectableRtcLane(
    channel: RtcDataChannelHealth | undefined,
): boolean {
    return channel?.state === 'Idle' ||
        channel?.state === 'Closed' ||
        channel?.state === 'Failed';
}

function isClosedRtcLaneHealth(
    channel: RtcDataChannelHealth | undefined,
): boolean {
    return channel?.readyState === 'closing' ||
        channel?.readyState === 'closed' ||
        channel?.state === 'Closed' ||
        channel?.state === 'Failed';
}

function isTerminalClosedWsStatus(status: RallarWsStatus): boolean {
    return (status.readyState === 'closing' || status.readyState === 'closed') &&
        !status.reconnecting &&
        !status.reconnectEnabled;
}

function normalizeWaitTimeoutMs(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
        return DEFAULT_RALLAR_WAIT_FOR_OPEN_TIMEOUT_MS;
    }

    return Math.max(0, Math.floor(timeoutMs));
}

function toPublicWsStatusUrl(url: string | undefined): string | undefined {
    if (!url) {
        return url;
    }

    try {
        const parsed = new URL(url);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return url.split(/[?#]/, 1)[0];
    }
}

function toWsWaitForOpenResult(
    status: RallarWaitForOpenStatus,
    wsStatus: RallarWsStatus,
): RallarWsWaitForOpenResult {
    return {
        transport: 'ws',
        status,
        wsStatus,
    };
}

function waitForRtcChannelOpenOrAbort(
    waitUntilOpen: Promise<boolean>,
    signal?: AbortSignal,
): Promise<boolean | 'aborted'> {
    if (!signal) {
        return waitUntilOpen;
    }

    if (signal.aborted) {
        return Promise.resolve('aborted');
    }

    return new Promise<boolean | 'aborted'>((resolve, reject) => {
        const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort);
            resolve('aborted');
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waitUntilOpen
            .then((opened) => {
                signal.removeEventListener('abort', onAbort);
                resolve(opened);
            })
            .catch((error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            });
    });
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toRallarWaitForOpenStatus(
    status: WebRtcPeerLaneOpenResult['status'],
): RallarWaitForOpenStatus {
    switch (status) {
        case 'open':
        case 'timeout':
        case 'aborted':
        case 'no-peer':
        case 'no-lane':
        case 'closed':
            return status;
        case 'self':
        case 'connect-failed':
        case 'failed':
            return 'failed';
    }
}

function toRtcRoomLaneWaitStatus(
    ready: readonly RallarRtcWaitForOpenResult[],
    notReady: readonly RallarRtcWaitForOpenResult[],
): RallarRtcRoomLaneWaitStatus {
    if (ready.length === 0 && notReady.length === 0) {
        return 'empty';
    }

    if (notReady.length === 0) {
        return 'open';
    }

    if (ready.length > 0) {
        return 'partial';
    }

    if (notReady.every((peer) => peer.status === 'not-connected')) {
        return 'not-connected';
    }

    if (notReady.every((peer) => peer.status === 'timeout')) {
        return 'timeout';
    }

    if (notReady.every((peer) => peer.status === 'aborted')) {
        return 'aborted';
    }

    if (notReady.every((peer) => peer.status === 'failed')) {
        return 'failed';
    }

    return 'not-ready';
}

function toRoomTransportState(
    input: Readonly<{
        mode: RallarRtcRoomMode;
        desiredPeerCount: number;
        knownPeerCount: number;
        activePeerCount: number;
        readyPeerCount: number;
        failedPeerCount: number;
        minReadyPeers: number;
        waitStatus?: RallarRtcRoomLaneWaitStatus;
    }>,
): RallarRoomTransportState {
    if (input.mode === 'off') {
        return 'off';
    }

    if (input.desiredPeerCount === 0) {
        return 'open';
    }

    if (input.readyPeerCount === input.desiredPeerCount) {
        return 'open';
    }

    if (
        input.minReadyPeers > 0 &&
        input.readyPeerCount >= input.minReadyPeers
    ) {
        return 'partial';
    }

    if (
        input.waitStatus === 'failed' ||
        input.waitStatus === 'timeout' ||
        input.failedPeerCount >= input.desiredPeerCount
    ) {
        return input.readyPeerCount > 0 ? 'degraded' : 'failed';
    }

    if (input.failedPeerCount > 0 && input.readyPeerCount > 0) {
        return 'degraded';
    }

    if (input.knownPeerCount > 0 || input.activePeerCount > 0) {
        return 'connecting';
    }

    return 'idle';
}

function toRoomTransportReason(
    state: RallarRoomTransportState,
    readiness?: RallarRtcRoomLaneWaitResult,
): string | undefined {
    if (readiness?.status === 'empty') {
        return 'Room has no RTC peer targets.';
    }

    if (
        readiness?.status === 'timeout' ||
        readiness?.status === 'failed' ||
        readiness?.status === 'aborted' ||
        readiness?.status === 'not-connected'
    ) {
        return `Room RTC wait ended with ${readiness.status}.`;
    }

    if (state === 'idle') {
        return 'Room RTC has not started connecting yet.';
    }

    if (state === 'partial') {
        return 'Room RTC is partially ready.';
    }

    if (state === 'degraded') {
        return 'Room RTC is degraded.';
    }

    return undefined;
}

function toPeerLaneOpenReason(
    result: WebRtcPeerLaneOpenResult,
): string | undefined {
    if (result.status === 'open' || !result.error) {
        return undefined;
    }

    const cause = (result.error as Error & { cause?: unknown }).cause;
    return cause !== undefined
        ? toErrorMessage(cause)
        : result.error.message;
}

function hasTargetSelectorOverride(
    input: RallarTargetSelector,
): boolean {
    return input.peerId !== undefined ||
        input.peerIds !== undefined ||
        input.roomId !== undefined ||
        input.roomRef !== undefined ||
        input.membership !== undefined;
}

function toTargetedSendStatus(
    peerIds: readonly string[],
    results: readonly RallarRealtimeSendResult[],
): RallarTargetedSendStatus {
    if (peerIds.length === 0) {
        return 'no-targets';
    }

    const sentCount = results.filter((result) =>
        isAcceptedRealtimeSendStatus(result.result.status)
    ).length;
    if (sentCount === peerIds.length) {
        return 'sent';
    }

    return sentCount > 0 ? 'partial' : 'failed';
}

function isAcceptedRealtimeSendStatus(
    status: RtcDataChannelSendResult['status'],
): boolean {
    return status === 'sent' || status === 'queued' || status === 'replaced';
}

function toMissingRtcLaneStatus(
    peerId: string,
    laneId: string,
): RallarRtcLaneStatus {
    return {
        peerId,
        laneId,
        isOpen: false,
        isReconnectable: false,
    };
}

function toCallParticipantState(
    input: Readonly<{
        ended: boolean;
        peer?: RallarRtcPeerStatus;
        laneCount: number;
        readyLaneCount: number;
        failedLaneCount: number;
    }>,
): RallarCallParticipantState {
    if (input.ended) {
        return 'ended';
    }

    if (!input.peer) {
        return 'idle';
    }

    if (input.laneCount === 0) {
        return input.peer.hasNoReconnectableLanes
            ? 'failed'
            : input.peer.isActive
                ? 'open'
                : 'connecting';
    }

    if (input.readyLaneCount === input.laneCount) {
        return 'open';
    }

    if (input.readyLaneCount > 0) {
        return 'partial';
    }

    if (input.failedLaneCount === input.laneCount) {
        return 'failed';
    }

    return input.peer.isActive ? 'connecting' : 'idle';
}

function toCallState(
    participants: readonly RallarCallParticipantStatus[],
    endedAtEpochMs?: number,
): RallarCallState {
    if (endedAtEpochMs !== undefined) {
        return 'ended';
    }

    if (participants.length === 0) {
        return 'empty';
    }

    if (participants.every((participant) => participant.state === 'open')) {
        return 'open';
    }

    if (
        participants.some((participant) =>
            participant.state === 'open' || participant.state === 'partial'
        )
    ) {
        return 'partial';
    }

    if (participants.every((participant) => participant.state === 'failed')) {
        return 'failed';
    }

    return 'connecting';
}

function toCallParticipantReason(
    peer: RallarRtcPeerStatus | undefined,
    laneCount: number,
    failedLaneIds: readonly string[],
): string | undefined {
    if (!peer) {
        return 'RTC peer has not been opened yet.';
    }

    if (failedLaneIds.length > 0) {
        return `RTC lanes failed or are unavailable: ${failedLaneIds.join(', ')}.`;
    }

    if (laneCount > 0 && peer.readyLaneIds.length === 0) {
        return 'RTC data lanes are not open yet.';
    }

    return undefined;
}

async function readSelectedCandidatePairDiagnostics(
    pc: RTCPeerConnection | undefined,
): Promise<RallarRtcCandidatePairDiagnostics | undefined> {
    if (!pc || typeof pc.getStats !== 'function') {
        return undefined;
    }

    const report = await pc.getStats();
    const stats = toStatsArray(report);
    const byId = new Map(stats.map((stat) => [String(stat.id), stat]));
    const selectedPair = stats.find((stat) =>
        stat.type === 'candidate-pair' &&
        (stat.selected === true || stat.nominated === true ||
            stat.state === 'succeeded')
    );
    if (!selectedPair) {
        return undefined;
    }

    const local = selectedPair.localCandidateId
        ? toCandidateDiagnostics(byId.get(String(selectedPair.localCandidateId)))
        : undefined;
    const remote = selectedPair.remoteCandidateId
        ? toCandidateDiagnostics(byId.get(String(selectedPair.remoteCandidateId)))
        : undefined;

    return {
        id: toOptionalString(selectedPair.id),
        state: toOptionalString(selectedPair.state),
        nominated: toOptionalBoolean(selectedPair.nominated),
        selected: toOptionalBoolean(selectedPair.selected),
        currentRoundTripTime: toOptionalNumber(
            selectedPair.currentRoundTripTime,
        ),
        availableOutgoingBitrate: toOptionalNumber(
            selectedPair.availableOutgoingBitrate,
        ),
        bytesSent: toOptionalNumber(selectedPair.bytesSent),
        bytesReceived: toOptionalNumber(selectedPair.bytesReceived),
        local,
        remote,
        usesRelay: local?.candidateType === 'relay' ||
            remote?.candidateType === 'relay',
    };
}

function toStatsArray(report: RTCStatsReport): Array<Record<string, unknown>> {
    const values: Array<Record<string, unknown>> = [];
    report.forEach((stat) => {
        if (typeof stat === 'object' && stat !== null) {
            values.push(stat as Record<string, unknown>);
        }
    });
    return values;
}

function toCandidateDiagnostics(
    stat: Record<string, unknown> | undefined,
): RallarRtcCandidateDiagnostics | undefined {
    if (!stat) {
        return undefined;
    }

    return {
        id: toOptionalString(stat.id),
        candidateType: toOptionalString(stat.candidateType),
        protocol: toOptionalString(stat.protocol),
        address: toOptionalString(stat.address),
        ip: toOptionalString(stat.ip),
        port: toOptionalNumber(stat.port),
        relayProtocol: toOptionalString(stat.relayProtocol),
        networkType: toOptionalString(stat.networkType),
        url: toOptionalString(stat.url),
    };
}

function toOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function toCallSignalTypeId(kind: RallarCallSignalKind): string {
    switch (kind) {
        case 'invite':
            return RALLAR_CALL_INVITE_TYPE_ID;
        case 'accepted':
            return RALLAR_CALL_ACCEPT_TYPE_ID;
        case 'declined':
            return RALLAR_CALL_DECLINE_TYPE_ID;
        case 'cancelled':
            return RALLAR_CALL_CANCEL_TYPE_ID;
    }
}

function isRallarCallSignalPayload(
    value: unknown,
): value is RallarCallSignalPayload {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const candidate = value as Partial<RallarCallSignalPayload>;
    return (
        candidate.kind === 'invite' ||
        candidate.kind === 'accepted' ||
        candidate.kind === 'declined' ||
        candidate.kind === 'cancelled'
    ) &&
        typeof candidate.callId === 'string' &&
        typeof candidate.fromPeerId === 'string' &&
        Array.isArray(candidate.toPeerIds) &&
        candidate.toPeerIds.every((peerId) => typeof peerId === 'string') &&
        typeof candidate.occurredAtEpochMs === 'number';
}

function readMediaStreamTracks(stream: MediaStream): MediaStreamTrack[] {
    return typeof stream.getTracks === 'function'
        ? stream.getTracks()
        : [];
}

function readMediaSourceTracks(
    kind: RallarMediaSourceKind,
    stream: MediaStream,
): MediaStreamTrack[] {
    const tracks = readMediaStreamTracks(stream);
    if (kind === 'microphone') {
        return tracks.filter((track) => track.kind === 'audio');
    }

    if (kind === 'camera') {
        return tracks.filter((track) => track.kind === 'video');
    }

    return tracks;
}

function toMediaSourceStatus(
    runtime: RallarMediaSourceRuntime,
): RallarMediaSourceStatus {
    const tracks = readMediaStreamTracks(runtime.stream);
    const endedTrackIds = tracks
        .filter((track) => track.readyState === 'ended')
        .map((track) => track.id);
    const state = runtime.state === 'open' &&
            tracks.length > 0 &&
            endedTrackIds.length === tracks.length
        ? 'ended'
        : runtime.state;

    return {
        kind: runtime.kind,
        state,
        streamId: runtime.stream.id,
        trackIds: tracks.map((track) => track.id),
        audioTrackIds: tracks
            .filter((track) => track.kind === 'audio')
            .map((track) => track.id),
        videoTrackIds: tracks
            .filter((track) => track.kind === 'video')
            .map((track) => track.id),
        enabledTrackIds: tracks
            .filter((track) => track.enabled)
            .map((track) => track.id),
        endedTrackIds,
        error: runtime.error,
    };
}

function toComposedMediaStream(
    runtimes: readonly RallarMediaSourceRuntime[],
    tracks: readonly MediaStreamTrack[],
): MediaStream {
    if (runtimes.length === 1) {
        const only = runtimes[0];
        if (only && readMediaStreamTracks(only.stream).length === tracks.length) {
            return only.stream;
        }
    }

    if (typeof globalThis.MediaStream === 'function') {
        return new MediaStream([...tracks]);
    }

    return toMediaStreamLike(
        `rallar-local-media:${tracks.map((track) => track.id).join(',')}`,
        tracks,
    );
}

function toEmptyMediaStream(): MediaStream {
    if (typeof globalThis.MediaStream === 'function') {
        return new MediaStream();
    }

    return toMediaStreamLike('rallar-empty-media', []);
}

function toMediaStreamLike(
    id: string,
    tracks: readonly MediaStreamTrack[],
): MediaStream {
    return {
        id,
        active: tracks.some((track) => track.readyState !== 'ended'),
        getTracks: () => [...tracks],
        getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
        getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    } as MediaStream;
}

export function createRallarFacade(): RallarFacade {
    return new BrowserRallarFacade();
}

export const rallar: RallarFacade = createRallarFacade();

function createRallarSubscriptionScope(): RallarSubscriptionScope {
    const unsubscribers = new Set<RallarUnsubscribe>();
    let closed = false;
    let scope!: RallarSubscriptionScope;

    scope = {
        add: (unsubscribe): RallarSubscriptionScope => {
            if (!unsubscribe) {
                return scope;
            }

            if (closed) {
                unsubscribe();
                return scope;
            }

            unsubscribers.add(unsubscribe);
            return scope;
        },
        unsubscribe: (): void => {
            if (closed) {
                return;
            }

            closed = true;
            const current = [...unsubscribers];
            unsubscribers.clear();
            for (const unsubscribe of current) {
                unsubscribe();
            }
        },
        size: (): number => unsubscribers.size,
    };

    return scope;
}

function toRallarRefreshOptions(
    input?: StateScope | RallarRefreshOptions,
): RallarRefreshOptions {
    if (!input) {
        return {};
    }

    if (isStateScope(input)) {
        return { scope: input };
    }

    return input;
}

function cloneRallarDefaults(defaults: RallarDefaults): RallarDefaults {
    return {
        applicationId: defaults.applicationId,
        ...(defaults.workspaceId !== undefined
            ? { workspaceId: defaults.workspaceId }
            : {}),
        ...(defaults.room
            ? {
                room: {
                    ...(defaults.room.roomId !== undefined
                        ? { roomId: defaults.room.roomId }
                        : {}),
                    ...(defaults.room.roomRef
                        ? { roomRef: { ...defaults.room.roomRef } }
                        : {}),
                },
            }
            : {}),
        ...(defaults.realtime
            ? { realtime: { ...defaults.realtime } }
            : {}),
        ...(defaults.rtc
            ? {
                rtc: {
                    ...defaults.rtc,
                    ...(defaults.rtc.dataChannelLanes
                        ? { dataChannelLanes: [...defaults.rtc.dataChannelLanes] }
                        : {}),
                },
            }
            : {}),
        ...(defaults.operations
            ? { operations: { ...defaults.operations } }
            : {}),
    };
}

function toRallarWorkflowPolicies<V>(
    options?: RallarOperationOptions,
): CommandsOrchestratorPolicies<V> {
    if (
        !options?.signal &&
        options?.timeoutMs === undefined &&
        options?.maxAttempts === undefined &&
        options?.shouldRetry === undefined
    ) {
        return {};
    }

    return {
        command: toRallarCommandOptions(options),
    };
}

function toRallarOperationOptions(
    options: RallarOperationOptions,
): RallarOperationOptions {
    if (
        !options.signal &&
        options.timeoutMs === undefined &&
        options.maxAttempts === undefined &&
        options.shouldRetry === undefined &&
        options.dataChannelLanes === undefined
    ) {
        return {};
    }

    const normalized: {
        signal?: AbortSignal;
        timeoutMs?: number;
        maxAttempts?: number;
        shouldRetry?: RallarOperationRetryPredicate;
        dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    } = {};
    if (options.signal) {
        normalized.signal = options.signal;
    }
    if (options.timeoutMs !== undefined) {
        normalized.timeoutMs = options.timeoutMs;
    }
    if (options.maxAttempts !== undefined) {
        normalized.maxAttempts = options.maxAttempts;
    }
    if (options.shouldRetry !== undefined) {
        normalized.shouldRetry = options.shouldRetry;
    }
    if (options.dataChannelLanes !== undefined) {
        normalized.dataChannelLanes = options.dataChannelLanes;
    }

    return normalized;
}

function runRallarCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: RallarOperationOptions,
): Promise<T> {
    return new Command<T>(supplier, toRallarCommandOptions(options)).run();
}

function waitForRallarOperation<T>(
    promise: Promise<T>,
    options: RallarOperationOptions,
): Promise<T> {
    if (!options.signal && options.timeoutMs === undefined) {
        return promise;
    }

    return runRallarCommand(() => promise, options);
}

function hasOwn<T extends object, K extends PropertyKey>(
    value: T,
    key: K,
): value is T & Record<K, unknown> {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function toRallarCommandOptions<T>(
    options: RallarOperationOptions,
): CommandOptions<T> {
    const commandOptions: CommandOptions<T> = {};
    if (options.signal) {
        commandOptions.signal = options.signal;
    }
    if (options.timeoutMs !== undefined) {
        commandOptions.timeoutMs = options.timeoutMs;
    }
    if (options.maxAttempts !== undefined) {
        commandOptions.maxAttempts = options.maxAttempts;
    }
    if (options.shouldRetry) {
        commandOptions.shouldRetry = options.shouldRetry;
    } else if (options.maxAttempts !== undefined) {
        commandOptions.shouldRetry = shouldRetryRallarOperation;
    }

    return commandOptions;
}

function shouldRetryRallarOperation(error: unknown): boolean {
    const status = readHttpStatus(error);
    if (status !== undefined) {
        return status === 429 || status >= 500;
    }

    return true;
}

function readHttpStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }

    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' && Number.isFinite(status)
        ? status
        : undefined;
}

function isStateScope(
    input: StateScope | RallarRefreshOptions,
): input is StateScope {
    return 'applicationId' in input;
}

function readRallarCacheOrDefault<T>(
    reader: () => T,
    defaultValue: T,
): T {
    try {
        return reader();
    } catch (error) {
        if (isUnconfiguredRallarCacheError(error)) {
            return defaultValue;
        }

        throw error;
    }
}

function isUnconfiguredRallarCacheError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('Repository not found: shared.repository.') ||
        message.includes('snapshot repository is not configured');
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

function toRallarMessage<T>(
    transport: RallarMessageTransport,
    message: ALMessage,
): RallarMessage<T> {
    return {
        transport,
        typeId: message.payload.typeId,
        topicId: message.route.topicId,
        contextId: message.route.contextId,
        resourceId: message.route.resourceId,
        roomId: readMessageRoomId(message),
        senderId: message.id.senderId,
        payload: decodeMessagePayload<T>(message),
        raw: message,
        receivedAtEpochMs: Date.now(),
    };
}

function toRallarMessageSendResult(
    transport: RallarMessageTransport,
    message: ALMessage,
    result: ALOutboundEnqueueResult,
): RallarMessageSendResult {
    return {
        transport,
        status: result.status,
        message,
        entry: result.entry,
        entries: result.entries,
        reason: result.reason,
    };
}

function isSuccessfulRallarMessageSendStatus(
    status: RallarMessageSendStatus,
): boolean {
    return status === 'enqueued' ||
        status === 'sent-immediate' ||
        status === 'duplicate' ||
        status === 'superseded' ||
        status === 'skipped';
}

function isRallarDirectorRelayEnvelope(
    value: unknown,
    topicId: string,
): value is RallarDirectorRelayEnvelope {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }

    const envelope = value as Partial<RallarDirectorRelayEnvelope>;
    return envelope.protocol === RALLAR_DIRECTOR_RELAY_PROTOCOL &&
        envelope.topicId === topicId &&
        typeof envelope.typeId === 'string' &&
        typeof envelope.roomId === 'string' &&
        typeof envelope.epoch === 'number' &&
        typeof envelope.sentAtEpochMs === 'number' &&
        'payload' in envelope;
}

function wakeQBoxEngineIfQueued(
    engine: Readonly<{ wake(): void }>,
    result: ALOutboundEnqueueResult,
): void {
    if (result.status === 'enqueued' || result.status === 'duplicate') {
        engine.wake();
    }
}

export function normalizeRallarMessageSelector(
    selector: RallarMessageSelectorInput,
): RallarMessageSelector {
    if (typeof selector === 'string') {
        return { typeId: selector };
    }

    if (!selector.topicId && !selector.typeId) {
        throw new Error('Message selector requires topicId or typeId.');
    }

    return selector;
}

function toMessageSelectorKey(selector: RallarMessageSelector): string {
    return `${selector.topicId ?? '*'}/${selector.typeId ?? '*'}`;
}

export function matchesRallarMessageSelector(
    selector: RallarMessageSelector,
    message: ALMessage,
): boolean {
    return (selector.topicId === undefined ||
            selector.topicId === message.route.topicId) &&
        (selector.typeId === undefined ||
            selector.typeId === message.payload.typeId);
}

function readMessageRoomId(message: ALMessage): string | undefined {
    if (message.targets?.mode === 'multicast') {
        return message.targets.groupRef.groupId;
    }

    if (
        message.targets?.mode === 'broadcast' && message.targets.scope === 'room'
    ) {
        return message.route.contextId;
    }

    return undefined;
}

function decodeMessagePayload<T>(message: ALMessage): T {
    try {
        return JSON.parse(message.payload.resource) as T;
    } catch {
        return message.payload.resource as T;
    }
}

function toRealtimeDataChannelSendOptions(
    input: RallarRealtimeSendOptions,
): RtcDataChannelSendOptions {
    return {
        key: input.key,
        maxAgeMs: input.maxAgeMs,
        now: input.now,
    };
}

function toStateEventListRequestOptions<TEventType extends string>(
    options: Readonly<{
        eventTypes?: readonly TEventType[];
        limit?: number;
        after?: StateEventCursor;
    }>,
    signal?: AbortSignal,
): Readonly<{
    eventTypes?: readonly TEventType[];
    limit?: number;
    after?: StateEventCursor;
    signal?: AbortSignal;
}> {
    return {
        ...(options.eventTypes !== undefined ? { eventTypes: options.eventTypes } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.after !== undefined ? { after: options.after } : {}),
        ...(signal ? { signal } : {}),
    };
}

function toClosedRealtimeSendResult(): RtcDataChannelSendResult {
    return {
        status: 'closed',
        reason: 'Realtime lane not connected',
        bufferedAmount: 0,
    };
}

async function toArrayBuffer(
    data: MessageEvent['data'],
): Promise<ArrayBuffer | undefined> {
    if (data instanceof ArrayBuffer) {
        return data;
    }

    if (ArrayBuffer.isView(data)) {
        const bytes = new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
        );
        return bytes.slice().buffer;
    }

    if (typeof Blob !== 'undefined' && data instanceof Blob) {
        return await data.arrayBuffer();
    }

    return undefined;
}

function isGroupEventPayload(value: unknown): value is GroupEvent {
    return isRecord(value) &&
        typeof value.applicationId === 'string' &&
        typeof value.groupId === 'string' &&
        typeof value.eventId === 'string' &&
        typeof value.eventType === 'string' &&
        typeof value.snapshotVersion === 'number';
}

function isClientEventPayload(value: unknown): value is ClientEvent {
    return isRecord(value) &&
        typeof value.applicationId === 'string' &&
        typeof value.principalId === 'string' &&
        typeof value.eventId === 'string' &&
        typeof value.eventType === 'string' &&
        typeof value.snapshotVersion === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isSameStateGroupRef(
    left: Pick<GroupRef, 'applicationId' | 'workspaceId' | 'groupId'>,
    right: Pick<GroupRef, 'applicationId' | 'workspaceId' | 'groupId'>,
): boolean {
    return left.groupId === right.groupId &&
        isSameStateScopeValue(left, right);
}

function isSameStateScopeValue(
    value: Pick<StateScope, 'applicationId'> & { workspaceId?: string },
    scope?: Pick<StateScope, 'applicationId'> & { workspaceId?: string },
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

function toReplayGroupStateEventMessage(event: GroupEvent): RallarMessage<GroupEvent> {
    return toRallarMessage(
        'replay',
        newALBroadcastMessage(
            'rallar:replay',
            newALRoute(
                AppTopics.groupStateEvent,
                event.groupId,
                event.eventId,
            ),
            'all',
            AppTopics.groupStateEvent,
            event,
        ),
    );
}

function toReplayClientStateEventMessage(
    event: ClientEvent,
): RallarMessage<ClientEvent> {
    return toRallarMessage(
        'replay',
        newALBroadcastMessage(
            'rallar:replay',
            newALRoute(
                AppTopics.clientStateEvent,
                event.principalId,
                event.eventId,
            ),
            'all',
            AppTopics.clientStateEvent,
            event,
        ),
    );
}

function toGroupStateEventDedupeKey(event: GroupEvent): string {
    return [
        event.applicationId,
        normalizeStateWorkspaceId(event.workspaceId),
        event.groupId,
        event.eventId,
    ].join('/');
}

function toClientStateEventDedupeKey(event: ClientEvent): string {
    return [
        event.applicationId,
        normalizeStateWorkspaceId(event.workspaceId),
        event.principalId,
        event.eventId,
    ].join('/');
}

function toReplayMaxPages(value?: number): number {
    if (value === undefined) {
        return DEFAULT_RALLAR_REPLAY_MAX_PAGES;
    }

    if (!Number.isSafeInteger(value) || value < 1) {
        return DEFAULT_RALLAR_REPLAY_MAX_PAGES;
    }

    return Math.min(value, MAX_RALLAR_REPLAY_MAX_PAGES);
}

function rememberStateEventKey(keys: Set<string>, key: string): void {
    keys.add(key);
    while (keys.size > MAX_RALLAR_STATE_EVENT_DEDUPE_KEYS) {
        const oldest = keys.values().next().value;
        if (oldest === undefined) {
            break;
        }
        keys.delete(oldest);
    }
}

async function notifyStateEventListener<TEvent>(
    listener: RallarStateEventListener<TEvent>,
    event: TEvent,
    message: RallarMessage<TEvent>,
): Promise<void> {
    try {
        await listener(event, message);
    } catch (error) {
        console.error('Error notifying Rallar state event listener', error);
    }
}

function notifyListener<T>(
    listener: RallarStateListener<T>,
    state: T,
): void {
    try {
        void Promise.resolve(listener(state)).catch((error) => {
            console.error('Error notifying Rallar state listener', error);
        });
    } catch (error) {
        console.error('Error notifying Rallar state listener', error);
    }
}
