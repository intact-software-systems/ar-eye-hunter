import {
    type ALAckMode,
    type ALMessage,
    newALBroadcastMessage,
    newALMulticastMessage,
    newALRoute,
} from '@shared/al-contracts/al-contract.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundEnqueueStatus,
} from '@shared/alm/ALOutboundMessageRuntime.ts';
import {
    type AuthSession,
    type ClientInfo,
    type LoginRequest,
    type LoginResponse,
    type RegisterRequest,
    type RegisterResponse,
} from '@shared/api/api-config.ts';
import { clearSession, isLoggedIn, readSession, writeSession, } from '@shared/api/auth.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import {
    isGroupActive,
    isSessionInGroup,
    readActiveClientSessionIds,
    readGroupDisplayName,
    readGroupId,
} from '@shared/api/group-client-views.ts';
import type {
    GroupJoinMode,
    GroupMemberStatus,
    GroupRole,
    GroupSnapshot,
    GroupStatus,
} from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
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

export {
    createRallarDataFacade,
    defineRallarDataStore,
} from '@shared-web/browser/rallar-data.ts';

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
const DEFAULT_RALLAR_REALTIME_LANE_ID = 'realtime';
const DEFAULT_RALLAR_REALTIME_OPEN_TIMEOUT_MS = 5_000;

export type RallarUnsubscribe = () => void;

export type RallarStateListener<T> = (state: T) => void | Promise<void>;

export type RallarConnectStatus = 'idle' | 'connecting' | 'connected';

export type RallarFlow<K, V> = CommandsOrchestrator<K, V>;

export type RallarFlowPolicies<V> = CommandsOrchestratorPolicies<V>;

export type RallarOperationOptions = Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
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

type RallarMessageSubscription = Readonly<{
    selector: RallarMessageSelector;
    listeners: Set<RallarMessageHandler<unknown>>;
}>;

export type RallarRoomSummary = Readonly<{
    roomId: string;
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
    clearCurrent?: boolean;
}>;

export type RallarOnChangeOptions = Readonly<{
    emitCurrent?: boolean;
}>;

export type RallarMessageTransport = 'rtc' | 'ws';

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
    membershipEpoch?: number;
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

export type RallarRemoteStream = Readonly<{
    peerId: string;
    stream: MediaStream;
    event: RTCTrackEvent;
}>;

export type RallarRealtimeSendOptions =
    & RtcDataChannelSendOptions
    & Readonly<{
    laneId?: string;
    roomId?: string;
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
    signalingState?: string;
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
    /** @deprecated Use hasNoReconnectableLanes for this exact state. */
    isConnectedPeer: boolean;
    isRoutable: boolean;
    readyLaneIds: readonly string[];
}>;

export type RallarRtcStatus = Readonly<{
    sessionId?: string;
    laneId: string;
    knownPeerIds: readonly string[];
    activePeerIds: readonly string[];
    peerIdsWithNoReconnectableLanes: readonly string[];
    /** @deprecated Use peerIdsWithNoReconnectableLanes for this exact state. */
    connectedPeerIds: readonly string[];
    readyPeerIds: readonly string[];
    peers: readonly RallarRtcPeerStatus[];
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

export type RallarFacade = Readonly<{
    configure(config: RallarApiClientConfig): void;
    connect(options?: RallarOperationOptions): Promise<ApiMiddleware>;
    disconnect(): Promise<void>;
    status(): RallarConnectStatus;
    isConnected(): boolean;
    session(): AuthSession | undefined;
    flow<K, V>(policies?: RallarFlowPolicies<V>): RallarFlow<K, V>;
    data: RallarDataFacade;
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
        create(input: string | RallarCreateRoomInput): Promise<GroupSnapshot>;
        join(
            roomId: string,
            options?: RallarJoinRoomOptions,
        ): Promise<GroupSnapshot>;
        leave(
            input?: string | RallarLeaveRoomOptions,
        ): Promise<GroupSnapshot | undefined>;
        current(): GroupSnapshot | undefined;
        onChange(
            listener: RallarStateListener<RallarRoomState>,
            options?: RallarOnChangeOptions,
        ): RallarUnsubscribe;
    }>;
    people: Readonly<{
        state(): RallarPeopleState;
        list(): readonly RallarPerson[];
        refresh(
            input?: StateScope | RallarRefreshOptions,
        ): Promise<RallarPeopleState>;
        get(principalId: string): RallarPerson | undefined;
        onChange(
            listener: RallarStateListener<RallarPeopleState>,
            options?: RallarOnChangeOptions,
        ): RallarUnsubscribe;
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
    }>;
    rtc: Readonly<{
        status(options?: RallarRtcStatusOptions): RallarRtcStatus;
        onStatus(
            listener: RallarRtcStatusListener,
            options?: RallarRtcStatusSubscriptionOptions,
        ): RallarUnsubscribe;
        onLifecycle(
            listener: RallarRtcLifecycleListener,
            options?: RallarRtcStatusSubscriptionOptions,
        ): RallarUnsubscribe;
        peer(
            peerId: string,
            options?: RallarRtcStatusOptions,
        ): RallarRtcPeerStatus | undefined;
        knownPeerIds(): readonly string[];
        activePeerIds(): readonly string[];
        peerIdsWithNoReconnectableLanes(): readonly string[];
        readyPeerIds(laneId?: string): readonly string[];
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
        health(
            options?: RallarRealtimeHealthOptions,
        ): readonly RallarRealtimeLaneHealth[];
    }>;
    media: Readonly<{
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

class BrowserRallarFacade implements RallarFacade {
    private connectState: RallarConnectStatus = 'idle';
    private ctx: ApiMiddleware | undefined = undefined;
    private connectPromise: Promise<ApiMiddleware> | undefined = undefined;
    private stateCacheUnsubscribe: RallarUnsubscribe | undefined = undefined;
    private currentRoomId: string | undefined = undefined;

    private readonly roomStateListeners = new Set<
        RallarStateListener<RallarRoomState>
    >();
    private readonly peopleStateListeners = new Set<
        RallarStateListener<RallarPeopleState>
    >();
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
    readonly data = createRallarDataFacade({
        resolveScopeKey: (scope) => this.resolveDataScopeKey(scope),
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

    readonly auth = {
        login: async (
            request: LoginRequest,
            options: RallarOperationOptions = {},
        ): Promise<LoginResponse> => {
            const response = await runRallarCommand(
                (signal) => api.loginToApi(request, { signal }),
                options,
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
            return await runRallarCommand(
                (signal) =>
                    api.registerWithApi(request, {
                        signal,
                        authSession: hasOwn(options, 'adminSession')
                            ? options.adminSession
                            : undefined,
                    }),
                options,
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
                        options,
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
            const ctx = await this.connect(options);
            const { clients, groups } = await apiWorkflows.refreshStateSnapshots(
                options.scope,
                toRallarWorkflowPolicies(options),
            );
            await this.acceptSnapshots(ctx, clients, groups);
            return this.toRoomState();
        },
        create: async (
            input: string | RallarCreateRoomInput,
        ): Promise<GroupSnapshot> => {
            const createInput = typeof input === 'string'
                ? { displayName: input }
                : input;
            const operationOptions = createInput;
            const ctx = await this.connect(operationOptions);
            const session = this.requireSession();
            const snapshot = await apiWorkflows.createAndJoinStateGroup(
                createInput.displayName,
                session.clientId,
                session.sessionId,
                createInput.scope,
                toRallarWorkflowPolicies(operationOptions),
            );
            this.currentRoomId = readGroupId(snapshot);
            await this.acceptSnapshots(ctx, [], [snapshot]);
            return snapshot;
        },
        join: async (
            roomId: string,
            options: RallarJoinRoomOptions = {},
        ): Promise<GroupSnapshot> => {
            const ctx = await this.connect(options);
            const session = this.requireSession();
            const currentRoomId = this.resolveCurrentRoomId();

            const snapshot = await apiWorkflows.joinStateGroup(
                roomId,
                session.clientId,
                session.sessionId,
                options.scope,
                toRallarWorkflowPolicies(options),
            );

            if (
                (options.leaveCurrent ?? true) && currentRoomId &&
                currentRoomId !== roomId
            ) {
                await this.rooms.leave({
                    roomId: currentRoomId,
                    clearCurrent: false,
                    scope: options.scope,
                    signal: options.signal,
                    timeoutMs: options.timeoutMs,
                });
            }

            this.currentRoomId = readGroupId(snapshot);
            await this.acceptSnapshots(ctx, [], [snapshot]);
            return snapshot;
        },
        leave: async (
            input?: string | RallarLeaveRoomOptions,
        ): Promise<GroupSnapshot | undefined> => {
            const options = typeof input === 'string'
                ? { roomId: input }
                : input ?? {};
            const ctx = await this.connect(options);
            const session = this.requireSession();
            const roomId = options.roomId ?? this.resolveCurrentRoomId();

            if (!roomId) {
                return undefined;
            }

            const snapshot = await apiWorkflows.leaveStateGroup(
                roomId,
                session.clientId,
                session.sessionId,
                options.scope,
                toRallarWorkflowPolicies(options),
            );

            if ((options.clearCurrent ?? true) && this.currentRoomId === roomId) {
                this.currentRoomId = undefined;
            }

            await this.acceptSnapshots(ctx, [], [snapshot]);
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
    };

    readonly people = {
        state: (): RallarPeopleState => this.toPeopleState(),
        list: (): readonly RallarPerson[] => this.toPeopleState().people,
        refresh: async (
            input?: StateScope | RallarRefreshOptions,
        ): Promise<RallarPeopleState> => {
            const options = toRallarRefreshOptions(input);
            const ctx = await this.connect(options);
            const { clients, groups } = await apiWorkflows.refreshStateSnapshots(
                options.scope,
                toRallarWorkflowPolicies(options),
            );
            await this.acceptSnapshots(ctx, clients, groups);
            return this.toPeopleState();
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
    };

    readonly messages = {
        rtc: {
            send: async <T>(
                input: RallarRtcSendInput<T>,
            ): Promise<RallarMessageSendResult> => {
                const ctx = await this.connect();
                const session = this.requireSession();
                const roomId = input.roomId ?? this.resolveCurrentRoomId();

                if (!roomId) {
                    throw new Error('Cannot send RTC message: no current room.');
                }

                const msg = newALMulticastMessage(
                    session.sessionId,
                    newALRoute(
                        input.topicId ?? input.typeId,
                        input.contextId ?? roomId,
                        input.resourceId ?? crypto.randomUUID(),
                    ),
                    roomId,
                    input.typeId,
                    input.payload,
                    {
                        membershipEpoch: input.membershipEpoch,
                        ttlHops: input.ttlHops,
                        ttlMs: input.ttlMs,
                        seq: input.seq,
                        orderingKey: input.orderingKey ?? roomId,
                        reliability: input.reliability ?? 'at-least-once',
                        ack: input.ack ?? 'none',
                        ownership: input.ownership ?? 'shared',
                        nextHopPeerIds: input.nextHopPeerIds,
                        overlayId: input.overlayId ?? roomId,
                        fanoutLimit: input.fanoutLimit,
                    },
                );

                return toRallarMessageSendResult(
                    'rtc',
                    msg,
                    await ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent(msg),
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
                const contextId = input.contextId ?? input.roomId ?? input.scope ??
                    'all';
                const msg = newALBroadcastMessage(
                    session.sessionId,
                    newALRoute(
                        input.topicId ?? input.typeId,
                        contextId,
                        input.resourceId ?? crypto.randomUUID(),
                    ),
                    input.scope ?? (input.roomId ? 'room' : 'all'),
                    input.typeId,
                    input.payload,
                    {
                        exceptPeerIds: input.exceptPeerIds,
                        ttlHops: input.ttlHops,
                        ttlMs: input.ttlMs,
                        reliability: input.reliability ?? 'at-least-once',
                        ack: input.ack ?? 'none',
                        ownership: input.ownership ?? 'shared',
                    },
                );

                return toRallarMessageSendResult(
                    'ws',
                    msg,
                    await ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent(msg),
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
    };

    readonly rtc = {
        status: (
            options: RallarRtcStatusOptions = {},
        ): RallarRtcStatus => this.toRtcStatus(options),
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
    };

    readonly realtime = {
        sendJson: async <T>(
            input: RallarRealtimeJsonSendInput<T>,
        ): Promise<readonly RallarRealtimeSendResult[]> => {
            const ctx = await this.connect();
            const laneId = input.laneId ?? DEFAULT_RALLAR_REALTIME_LANE_ID;
            const peerIds = this.resolveRealtimePeerIds(input);

            return await Promise.all(
                peerIds.map(async (peerId) => {
                    const peer = await this.connectRealtimePeer(ctx, peerId);
                    const channel = peer?.channels.get(laneId);
                    const sendOptions = toRealtimeDataChannelSendOptions(input);
                    const isOpen = await waitForRealtimeLane(channel, input);
                    return {
                        peerId,
                        laneId,
                        result: channel && isOpen
                            ? channel.sendJson(input.data, sendOptions)
                            : toClosedRealtimeSendResult(),
                    };
                }),
            );
        },
        sendBinary: async (
            input: RallarRealtimeBinarySendInput,
        ): Promise<readonly RallarRealtimeSendResult[]> => {
            const ctx = await this.connect();
            const laneId = input.laneId ?? DEFAULT_RALLAR_REALTIME_LANE_ID;
            const peerIds = this.resolveRealtimePeerIds(input);

            return await Promise.all(
                peerIds.map(async (peerId) => {
                    const peer = await this.connectRealtimePeer(ctx, peerId);
                    const channel = peer?.channels.get(laneId);
                    const sendOptions = toRealtimeDataChannelSendOptions(input);
                    const isOpen = await waitForRealtimeLane(channel, input);
                    return {
                        peerId,
                        laneId,
                        result: channel && isOpen
                            ? channel.sendBinary(input.data, sendOptions)
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
        const connectOptions = toRallarOperationOptions(options);
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
            const peerIds = ctx.middleware.webRtcConnectionService.knownPeerIds();
            for (const peerId of peerIds) {
                ctx.middleware.webRtcConnectionService.disconnectPeer(peerId);
            }
            this.unregisterRemoteStreamCallback();
            ctx.middleware.rtcRxStreamer.stopLocalMedia('all');
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

    flow<K, V>(policies: RallarFlowPolicies<V> = {}): RallarFlow<K, V> {
        return CommandsOrchestrator.withPolicies<K, V>(policies);
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
                connectedPeerIds: [],
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
            connectedPeerIds: peerIdsWithNoReconnectableLanes,
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
            isConnectedPeer: peerIdsWithNoReconnectableLanes.has(peerId),
            isRoutable: readyPeerIds.has(peerId),
            readyLaneIds: lanes
                .filter((lane) => lane.isOpen)
                .map((lane) => lane.laneId),
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
            url: health.url,
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
    ): Promise<void> {
        await stateCaches.hydrateStateCaches(
            ctx.middleware.webRtcGroupManager,
            toClientInfo(ctx.session),
            clients,
            groups,
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
        const currentRoomId = this.resolveCurrentRoomId();
        const currentRoom = currentRoomId
            ? this.findGroupSnapshot(currentRoomId)
            : undefined;

        return {
            rooms: rooms.map((snapshot) => ({
                roomId: readGroupId(snapshot),
                name: readGroupDisplayName(snapshot),
                status: snapshot.group.status,
                kind: snapshot.group.kind,
                joinMode: snapshot.group.joinMode,
                memberCount: snapshot.memberCount,
                onlineMemberCount: snapshot.onlineMemberCount,
                isJoined: sessionId ? isSessionInGroup(snapshot, sessionId) : false,
                isCurrent: readGroupId(snapshot) === currentRoomId,
                snapshot,
            })),
            currentRoomId,
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
        const session = readSession();
        if (!session) {
            return undefined;
        }

        if (this.currentRoomId) {
            const current = this.findGroupSnapshot(this.currentRoomId);
            if (
                current &&
                isGroupActive(current) &&
                isSessionInGroup(current, session.sessionId)
            ) {
                return this.currentRoomId;
            }
        }

        return this.findFirstGroupSnapshotIdForSession(session.sessionId);
    }

    private readGroupSnapshots(): GroupSnapshot[] {
        return readRallarCacheOrDefault(
            () => groupStateSnapshotsRepository.getAllGroupStateSnapshots(),
            [],
        );
    }

    private findGroupSnapshot(groupId: string): GroupSnapshot | undefined {
        return readRallarCacheOrDefault(
            () => groupStateSnapshotsRepository.findGroupStateSnapshotById(groupId),
            undefined,
        );
    }

    private findFirstGroupSnapshotIdForSession(
        sessionId: string,
    ): string | undefined {
        return readRallarCacheOrDefault(
            () =>
                groupStateSnapshotsRepository
                    .findFirstGroupStateSnapshotIdSessionIdIsIn(sessionId),
            undefined,
        );
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

            if (transport === 'ws' && this.wsMessageListeners.size === 0) {
                this.unregisterMessageCallback(transport, selector);
            }
        };
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
        if (this.wsMessageListeners.size > 0) {
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

    private resolveRealtimePeerIds(
        input: RallarRealtimeSendOptions,
    ): readonly string[] {
        const session = readSession();
        if (input.peerIds) {
            return [...new Set(input.peerIds)]
                .filter((sessionId) => sessionId !== session?.sessionId);
        }

        const room = input.roomId
            ? this.findGroupSnapshot(input.roomId)
            : this.toRoomState().currentRoom;

        const peerIds = (room?.activeSessions ?? [])
            .map((activeSession) => activeSession.sessionId)
            .filter((sessionId) => sessionId !== session?.sessionId);

        return [...new Set(peerIds)];
    }

    private async connectRealtimePeer(
        ctx: ApiMiddleware,
        peerId: string,
    ): Promise<QRtcPeerDto | undefined> {
        const connected = await ctx.middleware.webRtcConnectionService
            .connectToPeerIfAbsent(peerId);

        return connected.right ??
            ctx.middleware.webRtcConnectionService.readPeer(peerId);
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

        if (listeners.size === 0) {
            return;
        }

        const rallarMessage = toRallarMessage(transport, message);
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
        signalingState: pc?.signalingState,
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

export function createRallarFacade(): RallarFacade {
    return new BrowserRallarFacade();
}

export const rallar: RallarFacade = createRallarFacade();

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

function toRallarWorkflowPolicies<V>(
    options?: RallarOperationOptions,
): CommandsOrchestratorPolicies<V> {
    if (!options?.signal && options?.timeoutMs === undefined) {
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
        options.dataChannelLanes === undefined
    ) {
        return {};
    }

    const normalized: {
        signal?: AbortSignal;
        timeoutMs?: number;
        dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    } = {};
    if (options.signal) {
        normalized.signal = options.signal;
    }
    if (options.timeoutMs !== undefined) {
        normalized.timeoutMs = options.timeoutMs;
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
    return {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
    };
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
        return message.targets.groupId;
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

function toClosedRealtimeSendResult(): RtcDataChannelSendResult {
    return {
        status: 'closed',
        reason: 'Realtime lane not connected',
        bufferedAmount: 0,
    };
}

async function waitForRealtimeLane(
    channel: QRtcPeerDto['channel'] | undefined,
    input: RallarRealtimeSendOptions,
): Promise<boolean> {
    if (!channel) {
        return false;
    }

    return await channel.waitUntilOpen(
        input.openTimeoutMs ?? DEFAULT_RALLAR_REALTIME_OPEN_TIMEOUT_MS,
    );
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
