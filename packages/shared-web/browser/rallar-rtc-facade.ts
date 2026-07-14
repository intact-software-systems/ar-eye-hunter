import type { RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    RallarOnChangeOptions,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type { RallarReadinessExpectation } from '@shared-web/browser/readiness.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RtcDataChannelHealth } from '@shared/webrtc/QRtcDataChannel.ts';
import type { QRtcPeerConnectionDiagnostics } from '@shared/webrtc/QRtcPeerConnection.ts';

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
    expect?: RallarReadinessExpectation;
}>;

export type RallarRtcRoomLaneWaitStatus =
    | 'open'
    | 'partial'
    | 'not-ready'
    | 'empty'
    | 'over-capacity'
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
    connectionDiagnostics?: QRtcPeerConnectionDiagnostics;
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
    readyPeerIds: readonly string[];
    notReadyPeerIds: readonly string[];
    missingPeerIds: readonly string[];
    extraPeerIds: readonly string[];
    observedCount: number;
    expectedCount?: number;
}>;

export type RallarRtcFacade = Readonly<{
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

export type CreateRallarRtcFacadeOptions = RallarRtcFacade;

export function createRallarRtcFacade(
    operations: CreateRallarRtcFacadeOptions,
): RallarRtcFacade {
    return {
        status: (
            options: RallarRtcStatusOptions = {},
        ): RallarRtcStatus => operations.status(options),
        roomStatus: (
            room,
            options: RallarRtcRoomTransportOptions = {},
        ): RallarRoomTransportStatus => operations.roomStatus(room, options),
        openRoom: async (
            room,
            options: RallarRtcRoomTransportOptions = {},
        ): Promise<RallarRoomTransportStatus> =>
            await operations.openRoom(room, options),
        waitForRoom: async (
            room,
            options: RallarRtcRoomTransportOptions = {},
        ): Promise<RallarRoomTransportStatus> =>
            await operations.waitForRoom(room, options),
        onStatus: (
            listener,
            options: RallarRtcStatusSubscriptionOptions = {},
        ): RallarUnsubscribe => operations.onStatus(listener, options),
        onLifecycle: (
            listener,
            options: RallarRtcStatusSubscriptionOptions = {},
        ): RallarUnsubscribe => operations.onLifecycle(listener, options),
        waitForLane: async (
            peerId,
            laneId,
            options: RallarRtcWaitForOpenOptions = {},
        ): Promise<RallarRtcWaitForOpenResult> =>
            await operations.waitForLane(peerId, laneId, options),
        waitForOpen: async (
            peerId,
            options: RallarRtcWaitForOpenOptions = {},
        ): Promise<RallarRtcWaitForOpenResult> =>
            await operations.waitForOpen(peerId, options),
        waitForRoomLane: async (
            room,
            laneId,
            options: RallarRtcRoomLaneWaitOptions = {},
        ): Promise<RallarRtcRoomLaneWaitResult> =>
            await operations.waitForRoomLane(room, laneId, options),
        peer: (
            peerId,
            options: RallarRtcStatusOptions = {},
        ): RallarRtcPeerStatus | undefined => operations.peer(peerId, options),
        knownPeerIds: (): readonly string[] => operations.knownPeerIds(),
        activePeerIds: (): readonly string[] => operations.activePeerIds(),
        peerIdsWithNoReconnectableLanes: (): readonly string[] =>
            operations.peerIdsWithNoReconnectableLanes(),
        readyPeerIds: (laneId?: string): readonly string[] =>
            operations.readyPeerIds(laneId),
        diagnostics: async (
            options: RallarRtcDiagnosticsOptions = {},
        ): Promise<RallarRtcDiagnostics> =>
            await operations.diagnostics(options),
        restartIce: async (
            peerId,
        ): Promise<RallarRtcRecoveryResult> =>
            await operations.restartIce(peerId),
        reconnectPeer: async (
            peerId,
            options: RallarRtcReconnectOptions = {},
        ): Promise<RallarRtcRecoveryResult> =>
            await operations.reconnectPeer(peerId, options),
    };
}
