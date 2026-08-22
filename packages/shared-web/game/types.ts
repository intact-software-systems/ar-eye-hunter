import type {
    RallarDirectorRelayHandle,
    RallarDirectorRelaySendResult,
    RallarDirectorStatus,
    RallarFacade,
    RallarMessage,
    RallarMessageSendResult,
    RallarReadinessExpectation,
    RallarRealtimeLaneHealth,
    RallarRealtimeSendResult,
    RallarRoomState,
    RallarRtcDiagnostics,
    RallarRtcRoomLaneWaitResult,
    RallarRtcStatus,
    RallarUnsubscribe,
    RallarWsStatus
} from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';

export type RallarGameRallarFacade = Pick<
    RallarFacade,
    | 'session'
    | 'subscriptions'
    | 'rooms'
    | 'people'
    | 'director'
    | 'rtc'
    | 'realtime'
    | 'messages'
    | 'ws'
>;

export type RallarGameLaneIds = Readonly<{
    input: string;
    intent: string;
    snapshot: string;
    metrics: string;
    replication: string;
}>;

export type RallarGameLanePresetOptions = Readonly<{
    laneIds?: Partial<RallarGameLaneIds>;
    inputMaxQueueItems?: number;
    snapshotMaxQueueItems?: number;
    metricsMaxQueueItems?: number;
    intentMaxQueueItems?: number;
    replicationMaxQueueItems?: number;
}>;

export type RallarGameTypeIds = Readonly<{
    capability: string;
    intent: string;
    event: string;
    snapshot: string;
    syncRequest: string;
    heartbeat: string;
}>;

export type RallarGameMatchPhase =
    | 'idle'
    | 'lobby'
    | 'electing'
    | 'appointed'
    | 'connecting'
    | 'ready'
    | 'active'
    | 'recovering'
    | 'ended'
    | 'stopped'
    | 'error';

export type RallarGameRecoveryState = Readonly<{
    status: 'idle' | 'recovering' | 'synced' | 'failed';
    reason?: string;
    sinceEpochMs?: number;
    lastSyncRequestedAtEpochMs?: number;
    lastSnapshotAtEpochMs?: number;
}>;

export type RallarGameDirectorAuthority =
    | 'none'
    | 'candidate'
    | 'active'
    | 'stale';

export type RallarGameEgressState =
    | 'empty'
    | 'warming'
    | 'ready'
    | 'partial'
    | 'timeout'
    | 'failed';

export type RallarGameEgressStatus = Readonly<{
    reliable: RallarGameEgressState;
    realtime: RallarGameEgressState;
}>;

export type RallarGameMatchStatus = Readonly<{
    phase: RallarGameMatchPhase;
    protocol: string;
    topicId: string;
    roomId?: string;
    roomRef?: GroupRef;
    localPeerId?: string;
    directorPeerId?: string;
    directorEpoch?: number;
    directorIsFresh: boolean;
    directorAuthority: RallarGameDirectorAuthority;
    egress: RallarGameEgressStatus;
    recovery: RallarGameRecoveryState;
    started: boolean;
    stopped: boolean;
    updatedAtEpochMs: number;
    reason?: string;
}>;

export type RallarGameHostCapability = Readonly<{
    peerId: string;
    reportedAtEpochMs: number;
    canHost?: boolean;
    rttMs?: number;
    fps?: number;
    hardwareConcurrency?: number;
    deviceMemoryGb?: number;
    isMobile?: boolean;
    isBatterySaving?: boolean;
    previousDisconnects?: number;
    scoreBias?: number;
}>;

export type RallarGameHostCandidateReason =
    | 'fresh-capability'
    | 'missing-capability'
    | 'stale-capability'
    | 'cannot-host';

export type RallarGameHostCandidate = Readonly<{
    peerId: string;
    capability?: RallarGameHostCapability;
    score: number;
    eligible: boolean;
    reason: RallarGameHostCandidateReason;
}>;

export type RallarGameHostElectionInput = Readonly<{
    peerIds: readonly string[];
    capabilities?: readonly RallarGameHostCapability[];
    nowEpochMs?: number;
    capabilityTtlMs?: number;
    scoreHost?: (capability: RallarGameHostCapability) => number;
}>;

export type RallarGameHostElectionResult = Readonly<{
    host?: RallarGameHostCandidate;
    backup?: RallarGameHostCandidate;
    candidates: readonly RallarGameHostCandidate[];
    nowEpochMs: number;
    capabilityTtlMs: number;
}>;

export type RallarGameHostLease = Readonly<{
    hostPeerId: string;
    backupPeerId?: string;
    epoch: number;
    appointedAtEpochMs: number;
    expiresAtEpochMs?: number;
}>;

export type RallarGameHostAppointResult = Readonly<{
    status:
        | 'appointed'
        | 'not-elected'
        | 'not-authorized'
        | 'not-ready'
        | 'no-local-peer'
        | 'failed';
    election: RallarGameHostElectionResult;
    directorStatus?: RallarDirectorStatus;
    reason?: string;
}>;

export type RallarGameEnvelopeKind =
    | 'capability'
    | 'presence'
    | 'input'
    | 'intent'
    | 'event'
    | 'snapshot'
    | 'sync-request'
    | 'heartbeat';

export type RallarGameEnvelope<T> = Readonly<{
    protocol: string;
    kind: RallarGameEnvelopeKind;
    roomId: string;
    matchId?: string;
    senderId: string;
    seq: number;
    sentAtEpochMs: number;
    directorEpoch: number;
    payload: T;
}>;

export type RallarGameEnvelopeCreateInput<T> = Readonly<{
    protocol: string;
    kind: RallarGameEnvelopeKind;
    roomId: string;
    matchId?: string;
    senderId: string;
    seq: number;
    directorEpoch: number;
    payload: T;
    sentAtEpochMs?: number;
}>;

export type RallarGameEnvelopeRejectReason =
    | 'wrong-protocol'
    | 'wrong-room'
    | 'wrong-match'
    | 'wrong-sender'
    | 'wrong-kind'
    | 'stale-epoch'
    | 'duplicate-sequence'
    | 'stale-sequence';

export type RallarGameSequenceAcceptConstraints = Readonly<{
    protocol?: string;
    roomId?: string;
    matchId?: string;
    senderId?: string;
    minDirectorEpoch?: number;
    kinds?: readonly RallarGameEnvelopeKind[];
}>;

export type RallarGameSequenceAcceptResult = Readonly<
    | {
        accepted: true;
        envelope: RallarGameEnvelope<unknown>;
    }
    | {
        accepted: false;
        reason: RallarGameEnvelopeRejectReason;
        envelope: RallarGameEnvelope<unknown>;
    }
>;

export type RallarGameSequenceTracker = Readonly<{
    accept(
        envelope: RallarGameEnvelope<unknown>,
        constraints?: RallarGameSequenceAcceptConstraints
    ): RallarGameSequenceAcceptResult;
    last(
        envelope:
            | RallarGameEnvelope<unknown>
            | Pick<RallarGameEnvelope<unknown>, 'roomId' | 'matchId' | 'directorEpoch' | 'senderId' | 'kind'>
    ): number | undefined;
    reset(): void;
}>;

export type RallarGameLaneReadyOptions = Readonly<{
    laneIds?: readonly string[];
    timeoutMs?: number;
    signal?: AbortSignal;
    connect?: boolean;
    expect?: RallarReadinessExpectation;
}>;

export type RallarGamePeerReadiness = Readonly<{
    status:
        | 'open'
        | 'partial'
        | 'not-ready'
        | 'empty'
        | 'not-connected'
        | 'timeout'
        | 'aborted'
        | 'failed'
        | 'over-capacity'
        | 'no-room';
    roomId?: string;
    laneIds: readonly string[];
    readyPeerIds: readonly string[];
    notReadyPeerIds: readonly string[];
    missingPeerIds: readonly string[];
    extraPeerIds: readonly string[];
    observedCount: number;
    expectedCount?: number;
    lanes: readonly RallarRtcRoomLaneWaitResult[];
    reason?: string;
}>;

export type RallarGameDiagnosticsInput = Readonly<{
    status: RallarGameMatchStatus;
    election?: RallarGameHostElectionResult;
    appointment?: RallarGameDirectorAppointmentEligibility;
    lastAppointment?: RallarGameHostAppointResult;
    peerReadiness?: RallarGamePeerReadiness;
    rtcStatus?: RallarRtcStatus;
    rtcDiagnostics?: RallarRtcDiagnostics;
    wsStatus?: RallarWsStatus;
    realtimeHealth?: readonly RallarRealtimeLaneHealth[];
    capabilities?: readonly RallarGameHostCapability[];
    nowEpochMs?: number;
}>;

export type RallarGameDiagnostics = Readonly<{
    generatedAtEpochMs: number;
    phase: RallarGameMatchPhase;
    roomId?: string;
    localPeerId?: string;
    directorPeerId?: string;
    directorEpoch?: number;
    directorIsFresh: boolean;
    directorAuthority: RallarGameDirectorAuthority;
    egress: RallarGameEgressStatus;
    recovery: RallarGameRecoveryState;
    hostPeerId?: string;
    backupPeerId?: string;
    knownPeerIds: readonly string[];
    readyPeerIds: readonly string[];
    notReadyPeerIds: readonly string[];
    capabilityCount: number;
    rtcPeerCount: number;
    rtcRelayPeerCount?: number;
    wsStatus?: RallarWsStatus;
    realtimeHealth: readonly RallarRealtimeLaneHealth[];
    appointment?: RallarGameDirectorAppointmentDiagnostics;
    issues: readonly string[];
}>;

export type RallarGameDirectorAppointmentPolicy =
    | 'metadata-owner-admin-or-member-fallback'
    | 'metadata-owner-admin'
    | 'none'
    | 'custom';

export type RallarGameDirectorAppointmentEligibilityStatus =
    | 'allowed'
    | 'not-authorized'
    | 'not-ready'
    | 'no-local-peer';

export type RallarGameDirectorAppointmentEligibility = Readonly<{
    allowed: boolean;
    status: RallarGameDirectorAppointmentEligibilityStatus;
    policy: RallarGameDirectorAppointmentPolicy;
    reason?: string;
    localPeerId?: string;
    localPrincipalId?: string;
    localRole?: string;
    localMemberStatus?: string;
}>;

export type RallarGameDirectorAppointmentContext = Readonly<{
    policy: RallarGameDirectorAppointmentPolicy;
    roomId?: string;
    roomRef?: GroupRef;
    roomState: RallarRoomState;
    directorStatus: RallarDirectorStatus;
    localPeerId?: string;
    localPrincipalId?: string;
}>;

export type RallarGameDirectorAppointmentDiagnostics =
    & RallarGameDirectorAppointmentEligibility
    & Readonly<{
        lastResultStatus?: RallarGameHostAppointResult['status'];
        lastReason?: string;
    }>;

export type RallarGamePresenceSendOptions = Readonly<{
    laneId?: string;
    key?: string;
    maxAgeMs?: number;
    openTimeoutMs?: number;
}>;

export type RallarGameSendResult = Readonly<{
    status:
        | 'sent'
        | 'partial'
        | 'skipped'
        | 'failed'
        | 'no-director'
        | 'not-director'
        | 'not-ready'
        | 'stopped';
    transport?: 'local' | 'ws' | 'rtc' | 'realtime' | 'director-relay';
    reason?: string;
    ws?: RallarMessageSendResult;
    realtime?: readonly RallarRealtimeSendResult[];
    relay?: RallarDirectorRelaySendResult;
}>;

export type RallarGameStatusHandler = (
    status: RallarGameMatchStatus
) => void | Promise<void>;

export type RallarGameEnvelopeHandler<T> = (
    envelope: RallarGameEnvelope<T>
) => void | Promise<void>;

export type RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence = TInput> = Readonly<{
    rallar: RallarGameRallarFacade;
    protocol: string;
    topicId: string;
    matchId?: string;
    roomId?: string;
    roomRef?: GroupRef;
    laneIds?: Partial<RallarGameLaneIds>;
    typeIds?: Partial<RallarGameTypeIds>;
    heartbeatTtlMs?: number;
    capabilityTtlMs?: number;
    readCapability?: () => Omit<RallarGameHostCapability, 'peerId' | 'reportedAtEpochMs'>;
    resolvePeerIds?: (roomState: RallarRoomState) => readonly string[];
    scoreHost?: (capability: RallarGameHostCapability) => number;
    directorAppointmentPolicy?: RallarGameDirectorAppointmentPolicy;
    canAppointDirector?: (
        context: RallarGameDirectorAppointmentContext
    ) => RallarGameDirectorAppointmentEligibility;
    readSnapshot?: () =>
        | TSnapshot
        | undefined
        | Promise<TSnapshot | undefined>;
    autoSnapshotIntervalMs?: number | false;
    onPresence?: RallarGameEnvelopeHandler<TPresence>;
    onInput?: RallarGameEnvelopeHandler<TInput>;
    onIntent?: RallarGameEnvelopeHandler<TIntent>;
    onSnapshot?: RallarGameEnvelopeHandler<TSnapshot>;
    onEvent?: RallarGameEnvelopeHandler<TEvent>;
    onSyncRequest?: RallarGameEnvelopeHandler<unknown>;
}>;

export type RallarGameMatchHandle<TInput, TIntent, TSnapshot, TEvent, TPresence = TInput> = Readonly<{
    start(): Promise<RallarGameMatchStatus>;
    stop(): void;
    status(): RallarGameMatchStatus;
    diagnostics(): RallarGameDiagnostics;
    canAppointDirector(): RallarGameDirectorAppointmentEligibility;
    reportCapability(
        capability?: Partial<RallarGameHostCapability>
    ): Promise<RallarGameSendResult>;
    election(): RallarGameHostElectionResult;
    appointIfElected(): Promise<RallarGameHostAppointResult>;
    waitForReadyLanes(
        options?: RallarGameLaneReadyOptions
    ): Promise<RallarGamePeerReadiness>;
    sendInput(input: TInput): Promise<RallarGameSendResult>;
    sendPresence(
        presence: TPresence,
        options?: RallarGamePresenceSendOptions
    ): Promise<RallarGameSendResult>;
    sendIntent(intent: TIntent): Promise<RallarGameSendResult>;
    publishSnapshot(
        snapshot: TSnapshot,
        options?: { reliable?: boolean; }
    ): Promise<RallarGameSendResult>;
    publishEvent(event: TEvent): Promise<RallarGameSendResult>;
    requestSync(payload?: unknown): Promise<RallarGameSendResult>;
    onPresence(handler: RallarGameEnvelopeHandler<TPresence>): RallarUnsubscribe;
    onStatus(handler: RallarGameStatusHandler): RallarUnsubscribe;
}>;

export type RallarGameRuntimeRelay<TIntent, TSnapshot, TEvent> = RallarDirectorRelayHandle<
    RallarGameEnvelope<TIntent>,
    RallarGameEnvelope<TEvent>,
    RallarGameEnvelope<TSnapshot>
>;

export type RallarGameCapabilityMessage = RallarMessage<RallarGameEnvelope<RallarGameHostCapability>>;

export type RallarGameLanePresetBuilder = (
    options?: RallarGameLanePresetOptions
) => readonly RtcDataChannelLaneConfig[];
