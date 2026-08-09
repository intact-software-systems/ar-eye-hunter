import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarCrdtOperation, RallarCrdtOperationBatch, RallarCrdtTransportStrategy } from '@shared/crdt/mod.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';
import type {
    RallarDirectorStatus,
    RallarFacade,
    RallarRealtimeLaneHealth,
    RallarRealtimeSendResult,
    RallarRtcDiagnostics,
} from '@shared-web/browser/rallar.ts';

export type BlackBoxRallarTransport = 'realtime' | 'messages.rtc';

export type BlackBoxRallarScope = Readonly<{
    applicationId?: string;
    workspaceId?: string;
}>;

export type ResolvedBlackBoxRallarScope = Readonly<{
    applicationId: string;
    workspaceId: string;
}>;

export type BlackBoxRallarRoomRef = Readonly<{
    applicationId: string;
    workspaceId?: string;
    groupId: string;
}>;

export type BlackBoxRallarConfig = Readonly<{
    apiBaseUrl: string;
    applicationId?: string;
    workspaceId?: string;
    scope?: BlackBoxRallarScope;
    roomRef?: BlackBoxRallarRoomRef;
    username?: string;
    password?: string;
    displayName?: string;
    register?: boolean | 'if-needed';
    transport?: BlackBoxRallarTransport;
    laneId?: string;
    openTimeoutMs?: number;
    timeoutMs?: number;
    peerIds?: readonly string[];
    nextHopPeerIds?: readonly string[];
    typeId?: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    messageSelector?:
        | string
        | Readonly<{
              topicId?: string;
              typeId?: string;
          }>;
    ttlHops?: number;
    ttlMs?: number;
    reliability?: 'best-effort' | 'at-least-once';
    ack?: string;
    ownership?: 'shared' | 'exclusive';
    membershipEpoch?: number;
    minSnapshotVersion?: number;
    seq?: number;
    orderingKey?: string;
    overlayId?: string;
    fanoutLimit?: number;
    dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    expectedSessionId?: string;
    leaveRoomOnClose?: boolean;
    logoutOnClose?: boolean;
}>;

export type BlackBoxRallarConnectionConfig = Readonly<{
    connection: string;
    actor?: string;
    peerId?: string;
    remotePeerId?: string;
    roomId?: string;
    roomRef?: BlackBoxRallarRoomRef;
    rallar: BlackBoxRallarConfig;
}>;

export type BlackBoxRallarSendInput = Readonly<{
    data?: unknown;
    payload?: unknown;
    laneId?: string;
    roomId?: string;
    roomRef?: BlackBoxRallarRoomRef;
    applicationId?: string;
    workspaceId?: string;
    scope?: BlackBoxRallarScope;
    peerIds?: readonly string[];
    nextHopPeerIds?: readonly string[];
    remotePeerId?: string;
    typeId?: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    ttlHops?: number;
    ttlMs?: number;
    reliability?: 'best-effort' | 'at-least-once';
    ack?: string;
    ownership?: 'shared' | 'exclusive';
    membershipEpoch?: number;
    minSnapshotVersion?: number;
    seq?: number;
    orderingKey?: string;
    overlayId?: string;
    fanoutLimit?: number;
    openTimeoutMs?: number;
    key?: string;
    maxAgeMs?: number;
}>;

export type BlackBoxRallarEvent = Readonly<{
    kind: 'diagnostic' | 'message' | 'close';
    topic: string;
    atEpochMs: number;
    connection?: string;
    actor?: string;
    transport?: BlackBoxRallarTransport | 'ws';
    severity?: 'debug' | 'info' | 'warning' | 'error';
    roomId?: string;
    roomRef?: BlackBoxRallarRoomRef;
    scope?: BlackBoxRallarScope;
    applicationId?: string;
    workspaceId?: string;
    laneId?: string;
    peerId?: string;
    remotePeerId?: string;
    senderId?: string;
    typeId?: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    data?: unknown;
    error?: unknown;
}>;

export type BlackBoxRallarConnectDiagnostics = Readonly<{
    status: 'connected';
    connection: string;
    actor?: string;
    transport: BlackBoxRallarTransport;
    roomId?: string;
    roomRef?: BlackBoxRallarRoomRef;
    scope?: BlackBoxRallarScope;
    applicationId?: string;
    workspaceId?: string;
    clientId: string;
    sessionId: string;
    username: string;
    laneId?: string;
    typeId?: string;
    topicId?: string;
    wsStatus: ReturnType<RallarFacade['ws']['status']>;
    rtcStatus: ReturnType<RallarFacade['rtc']['status']>;
    health: readonly RallarRealtimeLaneHealth[];
}>;

export type BlackBoxRallarAuthenticateDiagnostics = Readonly<{
    status: 'authenticated';
    connection: string;
    actor?: string;
    roomRef?: BlackBoxRallarRoomRef;
    scope?: BlackBoxRallarScope;
    applicationId?: string;
    workspaceId?: string;
    clientId: string;
    sessionId: string;
    username: string;
}>;

export type BlackBoxRallarSendDiagnostics = Readonly<{
    status: 'sent' | 'no-peers';
    connection: string;
    actor?: string;
    transport: BlackBoxRallarTransport;
    roomId?: string;
    roomRef?: BlackBoxRallarRoomRef;
    scope?: BlackBoxRallarScope;
    applicationId?: string;
    workspaceId?: string;
    laneId?: string;
    peerIds?: readonly string[];
    nextHopPeerIds?: readonly string[];
    typeId?: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    minSnapshotVersion?: number;
    results?: readonly RallarRealtimeSendResult[];
    message?: unknown;
    health: readonly RallarRealtimeLaneHealth[];
}>;

export type BlackBoxRallarWsSendDiagnostics = Readonly<{
    status: 'sent';
    connection: string;
    actor?: string;
    transport: 'ws';
    roomId?: string;
    roomRef?: BlackBoxRallarRoomRef;
    scope?: 'room' | 'world' | 'all';
    applicationId?: string;
    workspaceId?: string;
    typeId: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    minSnapshotVersion?: number;
    message?: unknown;
    result: unknown;
    wsStatus: ReturnType<RallarFacade['ws']['status']>;
    rtcStatus: ReturnType<RallarFacade['rtc']['status']>;
}>;

export type BlackBoxRallarCloseDiagnostics = Readonly<{
    status: 'closed';
    connection?: string;
    actor?: string;
    transport?: BlackBoxRallarTransport;
    roomId?: string;
    roomRef?: BlackBoxRallarRoomRef;
    scope?: BlackBoxRallarScope;
    applicationId?: string;
    workspaceId?: string;
    unsubscribed: number;
    leftRoom: boolean;
    logout: boolean;
    disconnected: boolean;
    cleanupErrors: readonly unknown[];
}>;

export type BlackBoxRallarHealthDiagnostics = Readonly<{
    connected: boolean;
    status: ReturnType<RallarFacade['status']>;
    wsStatus: ReturnType<RallarFacade['ws']['status']>;
    rtcStatus: ReturnType<RallarFacade['rtc']['status']>;
    connection?: string;
    actor?: string;
    transport?: BlackBoxRallarTransport;
    roomId?: string;
    roomRef?: BlackBoxRallarRoomRef;
    scope?: BlackBoxRallarScope;
    applicationId?: string;
    workspaceId?: string;
    session?: AuthSession;
    health: readonly RallarRealtimeLaneHealth[];
    rtcDiagnostics?: RallarRtcDiagnostics;
    rtcDiagnosticsError?: unknown;
    crdt?: BlackBoxRallarCrdtRuntimeSummary;
    director?: BlackBoxRallarDirectorRelaySummary;
}>;

export type BlackBoxRallarHealthInput = Readonly<{
    includeRtcDiagnostics?: boolean;
}>;

export type BlackBoxRallarCrdtOpenInput = Readonly<{
    handle?: string;
    name: string;
    applicationId?: string;
    workspaceId?: string;
    documentId?: string;
    documentType?: string;
    scope?: Readonly<Record<string, unknown>>;
    roomRef?: BlackBoxRallarRoomRef;
    principalId?: string;
    customScope?: string;
    transport?: RallarCrdtTransportStrategy;
    persist?: boolean;
    tabSync?: boolean;
    initialValue?: unknown;
    policies?: readonly Readonly<Record<string, unknown>>[];
    validation?: Readonly<Record<string, unknown>>;
    encryption?: Readonly<Record<string, unknown>>;
    durableCatchUp?: false | 'http';
    apiBaseUrl?: string;
    actor?: string;
    sessionId?: string;
    username?: string;
    password?: string;
    displayName?: string;
    register?: boolean | 'if-needed';
    timeoutMs?: number;
    roomId?: string;
    rallar?: Readonly<Record<string, unknown>>;
}>;

export type BlackBoxRallarCrdtHandleInput = Readonly<{
    handle: string;
    timeoutMs?: number;
}>;

export type BlackBoxRallarCrdtApplyInput = BlackBoxRallarCrdtHandleInput &
    Readonly<{
        batch: RallarCrdtOperationBatch;
    }>;

export type BlackBoxRallarCrdtSyncInput = BlackBoxRallarCrdtHandleInput &
    Readonly<{
        reason?: string;
        transport?: RallarCrdtTransportStrategy;
    }>;

export type BlackBoxRallarCrdtWaitOperator = 'equals' | 'notEquals' | 'contains' | 'exists' | 'gte' | 'lte';

export type BlackBoxRallarCrdtWaitCondition = Readonly<{
    source: 'value' | 'health';
    path?: string;
    operator: BlackBoxRallarCrdtWaitOperator;
    expected?: unknown;
}>;

export type BlackBoxRallarCrdtWaitInput = BlackBoxRallarCrdtHandleInput &
    Readonly<{
        intervalMs?: number;
        stableForMs?: number;
        sync?:
            | false
            | Readonly<{
                  reason?: string;
                  transport?: RallarCrdtTransportStrategy;
              }>;
        conditions: readonly BlackBoxRallarCrdtWaitCondition[];
    }>;

export type BlackBoxRallarCrdtUndoRedoInput = BlackBoxRallarCrdtHandleInput &
    Readonly<{
        targetOperationGroupId: string;
        operations: readonly RallarCrdtOperation[];
        operationGroupId?: string;
    }>;

export type BlackBoxRallarCrdtRuntimeSummary = Readonly<{
    handles: readonly string[];
    documents: readonly Readonly<{
        handle: string;
        ref: unknown;
        health: unknown;
    }>[];
}>;

export type BlackBoxRallarCrdtCommandDiagnostics = Readonly<{
    status:
        | 'opened'
        | 'applied'
        | 'read'
        | 'synced'
        | 'health'
        | 'wait_matched'
        | 'undone'
        | 'redone'
        | 'closed'
        | 'destroyed';
    handle: string;
    ref?: unknown;
    transportStrategy?: RallarCrdtTransportStrategy;
    updateId?: string;
    value?: unknown;
    result?: unknown;
    health?: unknown;
    pendingUpdateCount?: number;
    failedPendingUpdateCount?: number;
    dependencyBlockedUpdateCount?: number;
    attempts?: number;
    waitedMs?: number;
    stableForMs?: number;
    conditions?: readonly BlackBoxRallarCrdtWaitCondition[];
    lastSyncResult?: unknown;
}>;

export type BlackBoxRallarCrdtRuntime = Readonly<{
    open(input: BlackBoxRallarCrdtOpenInput | unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    apply(input: BlackBoxRallarCrdtApplyInput | unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    read(input: BlackBoxRallarCrdtHandleInput | unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    sync(input: BlackBoxRallarCrdtSyncInput | unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    health(input: BlackBoxRallarCrdtHandleInput | unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    wait(input: BlackBoxRallarCrdtWaitInput | unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    undo(input: BlackBoxRallarCrdtUndoRedoInput | unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    redo(input: BlackBoxRallarCrdtUndoRedoInput | unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    close(input: BlackBoxRallarCrdtHandleInput | unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    destroy(input: BlackBoxRallarCrdtHandleInput | unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
}>;

export type BlackBoxRallarDirectorRoomInput = Readonly<{
    roomId?: string;
    applicationId?: string;
    workspaceId?: string;
    scope?: BlackBoxRallarScope;
    roomRef?: BlackBoxRallarRoomRef;
    timeoutMs?: number;
}>;

export type BlackBoxRallarDirectorAppointInput = BlackBoxRallarDirectorRoomInput &
    Readonly<{
        heartbeatTtlMs?: number;
    }>;

export type BlackBoxRallarDirectorStatusInput = BlackBoxRallarDirectorRoomInput &
    Readonly<{
        refresh?: boolean;
        now?: number;
    }>;

export type BlackBoxRallarDirectorRelayStartInput = BlackBoxRallarDirectorRoomInput &
    Readonly<{
        handle: string;
        laneId?: string;
        topicId?: string;
        intentTypeId: string;
        outputTypeId: string;
        heartbeatTypeId?: string;
        snapshotTypeId?: string;
        syncRequestTypeId?: string;
        heartbeatIntervalMs?: number;
        snapshotIntervalMs?: number;
        snapshot?: unknown;
    }>;

export type BlackBoxRallarDirectorHandleInput = Readonly<{
    handle: string;
    timeoutMs?: number;
}>;

export type BlackBoxRallarDirectorIntentInput = BlackBoxRallarDirectorHandleInput &
    Readonly<{
        intent: unknown;
    }>;

export type BlackBoxRallarDirectorSyncRequestInput = BlackBoxRallarDirectorHandleInput &
    Readonly<{
        payload?: unknown;
    }>;

export type BlackBoxRallarDirectorOutputRecord = Readonly<{
    kind: 'black-box-director-output';
    intentId: string;
    sequence: number;
    senderId: string;
    directorSessionId?: string;
    directorPrincipalId?: string;
    epoch?: number;
    receivedAtEpochMs: number;
    payload: unknown;
}>;

export type BlackBoxRallarDirectorRelaySummary = Readonly<{
    handles: readonly string[];
    relays: readonly Readonly<{
        handle: string;
        roomId?: string;
        topicId?: string;
        intentTypeId: string;
        outputTypeId: string;
        acceptedIntentCount: number;
        outputCount: number;
        snapshotCount: number;
        syncRequestCount: number;
        status: RallarDirectorStatus;
    }>[];
}>;

export type BlackBoxRallarDirectorCommandDiagnostics = Readonly<{
    status: 'appointed' | 'resigned' | 'status' | 'relay_started' | 'intent_sent' | 'sync_requested' | 'relay_stopped';
    handle?: string;
    roomId?: string;
    roomRef?: BlackBoxRallarRoomRef;
    role?: RallarDirectorStatus['role'];
    state?: RallarDirectorStatus['state'];
    isDirector?: boolean;
    isFresh?: boolean;
    appointment?: RallarDirectorStatus['appointment'];
    directorStatus?: RallarDirectorStatus;
    relay?: unknown;
    sendResult?: unknown;
    acceptedIntentCount?: number;
    outputCount?: number;
    snapshotCount?: number;
    syncRequestCount?: number;
}>;

export type BlackBoxRallarDirectorRuntime = Readonly<{
    appoint(input: BlackBoxRallarDirectorAppointInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    resign(input: BlackBoxRallarDirectorRoomInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    status(input: BlackBoxRallarDirectorStatusInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    relayStart(
        input: BlackBoxRallarDirectorRelayStartInput | unknown,
    ): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    intent(input: BlackBoxRallarDirectorIntentInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    syncRequest(
        input: BlackBoxRallarDirectorSyncRequestInput | unknown,
    ): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    relayStop(input: BlackBoxRallarDirectorHandleInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
}>;
