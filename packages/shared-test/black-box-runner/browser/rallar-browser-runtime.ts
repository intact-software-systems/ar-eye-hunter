import type { AuthSession, LoginResponse } from '@shared/api/api-config.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';
import {
    rallar,
    type RallarCrdtDocument,
    type RallarCrdtOpenOptions,
    type RallarDirectorRelayHandle,
    type RallarDirectorRelayMessage,
    type RallarDirectorStatus,
    type RallarRealtimeLaneHealth,
    type RallarRealtimeSendResult,
    type RallarRtcDiagnostics,
} from '@shared-web/browser/rallar.ts';
import { catchUpRallarCrdtDocument } from '@shared-web/browser/api-integration.ts';
import type {
    RallarCrdtOperation,
    RallarCrdtOperationBatch,
    RallarCrdtSyncOptions,
    RallarCrdtTransportStrategy,
    RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';

export type BlackBoxRallarTransport = 'realtime' | 'messages.rtc';

type BlackBoxRallarScope = Readonly<{
    applicationId?: string;
    workspaceId?: string;
}>;

type ResolvedBlackBoxRallarScope = Readonly<{
    applicationId: string;
    workspaceId: string;
}>;

type BlackBoxRallarRoomRef = Readonly<{
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
    messageSelector?: string | Readonly<{
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
    wsStatus: ReturnType<typeof rallar.ws.status>;
    rtcStatus: ReturnType<typeof rallar.rtc.status>;
    health: readonly RallarRealtimeLaneHealth[];
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
    wsStatus: ReturnType<typeof rallar.ws.status>;
    rtcStatus: ReturnType<typeof rallar.rtc.status>;
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
    status: ReturnType<typeof rallar.status>;
    wsStatus: ReturnType<typeof rallar.ws.status>;
    rtcStatus: ReturnType<typeof rallar.rtc.status>;
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

export type BlackBoxRallarCrdtApplyInput = BlackBoxRallarCrdtHandleInput & Readonly<{
    batch: RallarCrdtOperationBatch;
}>;

export type BlackBoxRallarCrdtSyncInput = BlackBoxRallarCrdtHandleInput & Readonly<{
    reason?: string;
    transport?: RallarCrdtTransportStrategy;
}>;

export type BlackBoxRallarCrdtWaitOperator =
    | 'equals'
    | 'notEquals'
    | 'contains'
    | 'exists'
    | 'gte'
    | 'lte';

export type BlackBoxRallarCrdtWaitCondition = Readonly<{
    source: 'value' | 'health';
    path?: string;
    operator: BlackBoxRallarCrdtWaitOperator;
    expected?: unknown;
}>;

export type BlackBoxRallarCrdtWaitInput = BlackBoxRallarCrdtHandleInput & Readonly<{
    intervalMs?: number;
    stableForMs?: number;
    sync?: false | Readonly<{
        reason?: string;
        transport?: RallarCrdtTransportStrategy;
    }>;
    conditions: readonly BlackBoxRallarCrdtWaitCondition[];
}>;

export type BlackBoxRallarCrdtUndoRedoInput = BlackBoxRallarCrdtHandleInput & Readonly<{
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
    status: 'opened' | 'applied' | 'read' | 'synced' | 'health' | 'wait_matched' | 'undone' | 'redone' | 'closed' | 'destroyed';
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

export type BlackBoxRallarDirectorAppointInput = BlackBoxRallarDirectorRoomInput & Readonly<{
    heartbeatTtlMs?: number;
}>;

export type BlackBoxRallarDirectorStatusInput = BlackBoxRallarDirectorRoomInput & Readonly<{
    refresh?: boolean;
    now?: number;
}>;

export type BlackBoxRallarDirectorRelayStartInput = BlackBoxRallarDirectorRoomInput & Readonly<{
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

export type BlackBoxRallarDirectorIntentInput = BlackBoxRallarDirectorHandleInput & Readonly<{
    intent: unknown;
}>;

export type BlackBoxRallarDirectorSyncRequestInput = BlackBoxRallarDirectorHandleInput & Readonly<{
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
    relayStart(input: BlackBoxRallarDirectorRelayStartInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    intent(input: BlackBoxRallarDirectorIntentInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    syncRequest(input: BlackBoxRallarDirectorSyncRequestInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    relayStop(input: BlackBoxRallarDirectorHandleInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
}>;

export type BlackBoxRallarRuntime = Readonly<{
    connect(
        config: BlackBoxRallarConnectionConfig,
    ): Promise<BlackBoxRallarConnectDiagnostics>;
    send(input: BlackBoxRallarSendInput | unknown): Promise<BlackBoxRallarSendDiagnostics>;
    sendWs(input: unknown): Promise<BlackBoxRallarWsSendDiagnostics>;
    crdt: BlackBoxRallarCrdtRuntime;
    director: BlackBoxRallarDirectorRuntime;
    close(): Promise<BlackBoxRallarCloseDiagnostics>;
    health(input?: BlackBoxRallarHealthInput | unknown): Promise<BlackBoxRallarHealthDiagnostics>;
}>;

type RuntimeSessionDiagnostic = Pick<AuthSession, 'clientId' | 'sessionId' | 'username'>;

type RuntimeState = {
    config: BlackBoxRallarConnectionConfig;
    session: RuntimeSessionDiagnostic;
    unsubscribeRealtime?: () => void;
    unsubscribeMessagesRtc?: () => void;
    unsubscribeWsLifecycle?: () => void;
    unsubscribeRtcLifecycle?: () => void;
    unsubscribeConsoleDiagnostics?: () => void;
    wsMessageUnsubscribes?: Map<string, () => void>;
};

type DirectorRelayState = {
    handle: string;
    input: BlackBoxRallarDirectorRelayStartInput;
    relay: RallarDirectorRelayHandle<unknown, BlackBoxRallarDirectorOutputRecord, unknown>;
    acceptedIntents: unknown[];
    outputs: unknown[];
    snapshots: unknown[];
    syncRequests: unknown[];
    sequence: number;
};

declare global {
    interface Window {
        __blackBoxRallar?: BlackBoxRallarRuntime;
        __blackBoxRallarEmit?: (event: BlackBoxRallarEvent) => void | Promise<void>;
    }
}

const DEFAULT_LANE_ID = 'realtime';
const DEFAULT_WORKSPACE_ID = 'default';

let state: RuntimeState | undefined;
let consoleDiagnosticConfig: BlackBoxRallarConnectionConfig | undefined;
let restoreConsoleWarn: (() => void) | undefined;
const crdtDocuments = new Map<string, RallarCrdtDocument<unknown, RallarCrdtOperationBatch>>();
const directorRelays = new Map<string, DirectorRelayState>();

function transportOf(
    config: BlackBoxRallarConnectionConfig,
): BlackBoxRallarTransport {
    return config.rallar.transport ?? 'realtime';
}

function laneIdOf(config: BlackBoxRallarConnectionConfig): string {
    return config.rallar.laneId ?? DEFAULT_LANE_ID;
}

function typeIdOf(config: BlackBoxRallarConnectionConfig): string {
    const typeId = config.rallar.typeId;
    if (!typeId) {
        throw new Error('rallar.typeId is required for messages.rtc transport.');
    }

    return typeId;
}

function topicIdOf(config: BlackBoxRallarConnectionConfig): string | undefined {
    return config.rallar.topicId ?? config.rallar.typeId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function wsScopeValue(value: unknown): 'room' | 'world' | 'all' | undefined {
    return value === 'room' || value === 'world' || value === 'all'
        ? value
        : undefined;
}

function maybeStringArray(value: unknown): readonly string[] | undefined {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : undefined;
}

function wsSelectorKey(typeId: string, topicId?: string): string {
    return `${topicId ?? '*'}/${typeId}`;
}

function scopeOf(
    config: BlackBoxRallarConnectionConfig,
    input?: BlackBoxRallarSendInput,
): ResolvedBlackBoxRallarScope | undefined {
    const scope = isRecord(input?.scope) ? input.scope : config.rallar.scope;
    const roomRef = roomRefOf(config, input);
    const applicationId = String(
        input?.applicationId ??
            scope?.applicationId ??
            roomRef?.applicationId ??
            config.rallar.applicationId ??
            '',
    ).trim();
    if (!applicationId) {
        return undefined;
    }

    const workspaceId = input?.workspaceId ??
        scope?.workspaceId ??
        roomRef?.workspaceId ??
        config.rallar.workspaceId ??
        DEFAULT_WORKSPACE_ID;

    return {
        applicationId,
        workspaceId: String(workspaceId),
    };
}

function roomRefOf(
    config: BlackBoxRallarConnectionConfig,
    input?: BlackBoxRallarSendInput,
): BlackBoxRallarRoomRef | undefined {
    const explicit = input?.roomRef ?? config.rallar.roomRef ?? config.roomRef;
    if (explicit?.applicationId && explicit.groupId) {
        return {
            applicationId: String(explicit.applicationId),
            ...(explicit.workspaceId !== undefined
                ? { workspaceId: String(explicit.workspaceId) }
                : {}),
            groupId: String(explicit.groupId),
        };
    }

    const roomId = input?.roomId ?? config.roomId;
    if (!roomId) {
        return undefined;
    }

    const applicationId = input?.applicationId ??
        input?.scope?.applicationId ??
        config.rallar.applicationId ??
        config.rallar.scope?.applicationId;
    if (!applicationId) {
        return undefined;
    }

    const workspaceId = input?.workspaceId ??
        input?.scope?.workspaceId ??
        config.rallar.workspaceId ??
        config.rallar.scope?.workspaceId;

    return {
        applicationId: String(applicationId),
        ...(workspaceId !== undefined ? { workspaceId: String(workspaceId) } : {}),
        groupId: String(roomId),
    };
}

function scopeDiagnostics(
    config: BlackBoxRallarConnectionConfig,
    input?: BlackBoxRallarSendInput,
): Record<string, unknown> {
    const scope = scopeOf(config, input);
    const roomRef = roomRefOf(config, input);

    return {
        ...(scope?.applicationId ? { applicationId: scope.applicationId } : {}),
        ...(scope?.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        ...(scope ? { scope } : {}),
        ...(roomRef ? { roomRef } : {}),
    };
}

function toRallarDefaults(config: BlackBoxRallarConnectionConfig): Record<string, unknown> | undefined {
    const scope = scopeOf(config);
    const roomRef = roomRefOf(config);
    const roomId = config.roomId ?? roomRef?.groupId;
    if (!scope?.applicationId) {
        return undefined;
    }

    const room = roomId || roomRef
        ? {
            ...(roomId ? { roomId } : {}),
            ...(roomRef ? { roomRef } : {}),
        }
        : undefined;

    return {
        applicationId: scope.applicationId,
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        ...(room ? { room } : {}),
        realtime: {
            laneId: laneIdOf(config),
            ...(config.rallar.openTimeoutMs !== undefined
                ? { openTimeoutMs: config.rallar.openTimeoutMs }
                : {}),
        },
        rtc: {
            ...(config.rallar.dataChannelLanes !== undefined
                ? { dataChannelLanes: config.rallar.dataChannelLanes }
                : {}),
        },
    };
}

function crdtHandle(input: unknown): string {
    const record = asRecord(input);
    const handle = stringValue(record.handle) ??
        stringValue(record.commandId) ??
        stringValue(record.name);
    if (!handle) {
        throw new Error('CRDT command requires handle.');
    }

    return handle;
}

function crdtRoomRef(input: BlackBoxRallarCrdtOpenInput): BlackBoxRallarRoomRef | undefined {
    const explicit = input.roomRef ?? optionalRecord(input.rallar?.roomRef) as BlackBoxRallarRoomRef | undefined;
    if (explicit?.applicationId && explicit.groupId) {
        return {
            applicationId: String(explicit.applicationId),
            ...(explicit.workspaceId !== undefined ? { workspaceId: String(explicit.workspaceId) } : {}),
            groupId: String(explicit.groupId),
        };
    }

    const roomId = input.roomId ?? stringValue(input.rallar?.roomId);
    const applicationId = input.applicationId ??
        stringValue(input.rallar?.applicationId) ??
        stringValue(optionalRecord(input.scope)?.applicationId);
    if (!roomId || !applicationId) {
        return undefined;
    }

    const workspaceId = input.workspaceId ??
        stringValue(input.rallar?.workspaceId) ??
        stringValue(optionalRecord(input.scope)?.workspaceId);

    return {
        applicationId,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        groupId: roomId,
    };
}

function normalizeCrdtOpenInput(input: BlackBoxRallarCrdtOpenInput | unknown): BlackBoxRallarCrdtOpenInput {
    const record = asRecord(input);
    const rallarConfig = asRecord(record.rallar);
    const scope = optionalRecord(record.scope) ?? optionalRecord(rallarConfig.scope);
    const roomRef = optionalRecord(record.roomRef) ?? optionalRecord(rallarConfig.roomRef);
    const name = stringValue(record.name);
    if (!name) {
        throw new Error('crdt.open requires name.');
    }

    return {
        handle: stringValue(record.handle) ?? stringValue(record.commandId) ?? name,
        name,
        applicationId: stringValue(record.applicationId) ?? stringValue(rallarConfig.applicationId),
        workspaceId: stringValue(record.workspaceId) ?? stringValue(rallarConfig.workspaceId),
        documentId: stringValue(record.documentId),
        documentType: stringValue(record.documentType),
        scope,
        roomRef: roomRef as BlackBoxRallarRoomRef | undefined,
        principalId: stringValue(record.principalId),
        customScope: stringValue(record.customScope),
        transport: toCrdtTransport(record.transport) ?? toCrdtTransport(rallarConfig.crdtTransport),
        persist: typeof record.persist === 'boolean' ? record.persist : undefined,
        tabSync: typeof record.tabSync === 'boolean' ? record.tabSync : undefined,
        initialValue: record.initialValue,
        policies: Array.isArray(record.policies) ? record.policies as readonly Readonly<Record<string, unknown>>[] : undefined,
        validation: optionalRecord(record.validation),
        encryption: optionalRecord(record.encryption),
        durableCatchUp: record.durableCatchUp === 'http'
            ? 'http'
            : record.durableCatchUp === false
                ? false
                : undefined,
        apiBaseUrl: stringValue(record.apiBaseUrl) ?? stringValue(rallarConfig.apiBaseUrl),
        actor: stringValue(record.actor),
        sessionId: stringValue(record.sessionId) ?? stringValue(rallarConfig.sessionId),
        username: stringValue(record.username) ?? stringValue(rallarConfig.username),
        password: stringValue(record.password) ?? stringValue(rallarConfig.password),
        displayName: stringValue(record.displayName) ?? stringValue(rallarConfig.displayName),
        register: record.register === true || record.register === 'if-needed'
            ? record.register
            : rallarConfig.register === true || rallarConfig.register === 'if-needed'
                ? rallarConfig.register
                : undefined,
        timeoutMs: typeof record.timeoutMs === 'number'
            ? record.timeoutMs
            : typeof rallarConfig.timeoutMs === 'number'
                ? rallarConfig.timeoutMs
                : undefined,
        roomId: stringValue(record.roomId) ?? stringValue(rallarConfig.roomId),
        rallar: rallarConfig,
    };
}

function toCrdtTransport(value: unknown): RallarCrdtTransportStrategy | undefined {
    return value === 'local-only' ||
            value === 'ws' ||
            value === 'rtc' ||
            value === 'ws-then-rtc' ||
            value === 'rtc-with-ws-fallback'
        ? value
        : undefined;
}

function toCrdtOpenScope(
    input: BlackBoxRallarCrdtOpenInput,
): RallarCrdtOpenOptions['scope'] {
    const scope = optionalRecord(input.scope);
    const kind = stringValue(scope?.kind);
    const roomRef = crdtRoomRef(input);
    if (kind === 'app') {
        return { kind: 'app' };
    }
    if (kind === 'principal') {
        const principalId = stringValue(scope?.principalId) ?? input.principalId;
        if (principalId) {
            return { kind: 'principal', principalId };
        }
    }
    if (kind === 'custom') {
        const customScope = stringValue(scope?.customScope) ?? input.customScope;
        if (customScope) {
            return { kind: 'custom', customScope };
        }
    }
    if (kind === 'room' && roomRef) {
        return { kind: 'room', roomRef };
    }
    if (input.principalId) {
        return { kind: 'principal', principalId: input.principalId };
    }
    if (input.customScope) {
        return { kind: 'custom', customScope: input.customScope };
    }
    if (roomRef) {
        return { kind: 'room', roomRef };
    }

    return undefined;
}

function toCrdtConnectionConfig(input: BlackBoxRallarCrdtOpenInput): BlackBoxRallarConnectionConfig {
    const roomRef = crdtRoomRef(input);
    const applicationId = input.applicationId ??
        stringValue(input.rallar?.applicationId) ??
        roomRef?.applicationId;
    const workspaceId = input.workspaceId ??
        stringValue(input.rallar?.workspaceId) ??
        roomRef?.workspaceId ??
        DEFAULT_WORKSPACE_ID;
    const scope = applicationId
        ? {
            applicationId,
            workspaceId,
        }
        : undefined;

    return {
        connection: input.handle ?? input.name,
        actor: input.actor,
        roomId: input.roomId ?? roomRef?.groupId,
        ...(roomRef ? { roomRef } : {}),
        rallar: {
            ...asRecord(input.rallar),
            apiBaseUrl: input.apiBaseUrl ?? stringValue(input.rallar?.apiBaseUrl) ?? '',
            ...(input.username ? { username: input.username } : {}),
            ...(input.password ? { password: input.password } : {}),
            ...(input.displayName ? { displayName: input.displayName } : {}),
            ...(input.register !== undefined ? { register: input.register } : {}),
            ...(applicationId ? { applicationId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(scope ? { scope } : {}),
            ...(roomRef ? { roomRef } : {}),
            ...(input.sessionId ? { expectedSessionId: input.sessionId } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            transport: 'realtime',
        },
    };
}

function toCrdtOpenOptions(
    input: BlackBoxRallarCrdtOpenInput,
): RallarCrdtOpenOptions<unknown, RallarCrdtOperationBatch> {
    return {
        ...(input.applicationId ? { applicationId: input.applicationId } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.documentId ? { documentId: input.documentId } : {}),
        ...(input.documentType ? { documentType: input.documentType } : {}),
        ...(toCrdtOpenScope(input) ? { scope: toCrdtOpenScope(input) } : {}),
        ...(input.transport ? { transport: input.transport } : {}),
        ...(input.persist !== undefined ? { persist: input.persist } : {}),
        ...(input.tabSync !== undefined ? { tabSync: input.tabSync } : {}),
        ...(input.initialValue !== undefined ? { initialValue: input.initialValue } : {}),
        ...(input.policies ? { policies: input.policies as any } : {}),
        ...(input.validation ? { validation: input.validation as any } : {}),
        ...(input.encryption ? { encryption: input.encryption as any } : {}),
        ...(input.actor ? { actorId: input.actor } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.durableCatchUp === 'http'
            ? { durableCatchUp: catchUpRallarCrdtDocument }
            : {}),
    };
}

async function ensureCrdtLiveConnection(
    input: BlackBoxRallarCrdtOpenInput,
): Promise<BlackBoxRallarConnectionConfig | undefined> {
    if ((input.transport ?? 'local-only') === 'local-only') {
        return undefined;
    }
    if (!input.apiBaseUrl) {
        if (rallar.isConnected()) {
            return state?.config;
        }
        throw new Error('crdt.open requires apiBaseUrl or an existing Rallar connection for live transports.');
    }

    const config = toCrdtConnectionConfig(input);
    emitDiagnostic(config, 'rallar.browser.crdt.configure_started', {
        transportStrategy: input.transport,
    });
    rallar.configure({ apiBaseUrl: input.apiBaseUrl });
    rallar.setDefaults(toRallarDefaults(config) as any);
    emitDiagnostic(config, 'rallar.browser.crdt.configure_completed', {
        defaults: toRallarDefaults(config),
    });

    if (!rallar.isConnected()) {
        const session = await loginOrRestore(config);
        await rallar.connect({
            timeoutMs: input.timeoutMs,
        });
        if (config.roomId) {
            await rallar.rooms.join(config.roomId, {
                timeoutMs: input.timeoutMs,
                scope: scopeOf(config),
            });
        }
        emitDiagnostic(config, 'rallar.browser.crdt.connected', {
            session: toSessionDiagnostic(session),
            transportStrategy: input.transport,
        });
    }

    return config;
}

function requireCrdtDocument(handle: string): RallarCrdtDocument<unknown, RallarCrdtOperationBatch> {
    const document = crdtDocuments.get(handle);
    if (!document) {
        throw new Error('CRDT document handle is not open: ' + handle);
    }

    return document;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function normalizeCrdtWaitCondition(value: unknown): BlackBoxRallarCrdtWaitCondition {
    const record = asRecord(value);
    const source = record.source === 'value' || record.source === 'health'
        ? record.source
        : undefined;
    const operator = isCrdtWaitOperator(record.operator)
        ? record.operator
        : undefined;
    if (!source || !operator) {
        throw new Error('crdt.wait conditions require source and supported operator.');
    }

    return {
        source,
        ...(stringValue(record.path) ? { path: stringValue(record.path) } : {}),
        operator,
        ...(record.expected !== undefined ? { expected: record.expected } : {}),
    };
}

function normalizeCrdtWaitInput(input: BlackBoxRallarCrdtWaitInput | unknown): BlackBoxRallarCrdtWaitInput {
    const record = asRecord(input);
    const handle = crdtHandle(record);
    const conditions = Array.isArray(record.conditions)
        ? record.conditions.map(normalizeCrdtWaitCondition)
        : [];
    if (conditions.length === 0) {
        throw new Error('crdt.wait requires at least one condition.');
    }

    const syncRecord = record.sync === false
        ? false
        : optionalRecord(record.sync);

    return {
        handle,
        ...(optionalNumber(record.timeoutMs) !== undefined
            ? { timeoutMs: Math.max(0, optionalNumber(record.timeoutMs) as number) }
            : {}),
        ...(optionalNumber(record.intervalMs) !== undefined
            ? { intervalMs: Math.max(0, optionalNumber(record.intervalMs) as number) }
            : {}),
        ...(optionalNumber(record.stableForMs) !== undefined
            ? { stableForMs: Math.max(0, optionalNumber(record.stableForMs) as number) }
            : {}),
        ...(syncRecord !== undefined
            ? {
                sync: syncRecord === false
                    ? false
                    : {
                        ...(stringValue(syncRecord.reason) ? { reason: stringValue(syncRecord.reason) } : {}),
                        ...(toCrdtTransport(syncRecord.transport) ? { transport: toCrdtTransport(syncRecord.transport) } : {}),
                    },
            }
            : {}),
        conditions,
    };
}

function isCrdtWaitOperator(value: unknown): value is BlackBoxRallarCrdtWaitOperator {
    return value === 'equals' ||
        value === 'notEquals' ||
        value === 'contains' ||
        value === 'exists' ||
        value === 'gte' ||
        value === 'lte';
}

function normalizeCrdtWaitPath(path: string): string {
    if (path.startsWith('$.')) {
        return path.slice('$.'.length);
    }
    return path;
}

function lookupCrdtWaitPath(root: unknown, path: string | undefined): Readonly<{
    exists: boolean;
    value?: unknown;
}> {
    if (!path || path.trim().length === 0) {
        return {
            exists: root !== undefined,
            value: root,
        };
    }

    let current = root;
    const segments = normalizeCrdtWaitPath(path)
        .split('.')
        .filter(segment => segment.length > 0);
    for (const segment of segments) {
        if ((Array.isArray(current) || typeof current === 'string') && segment === 'length') {
            current = current.length;
            continue;
        }

        if (Array.isArray(current)) {
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= current.length) {
                return { exists: false };
            }
            current = current[index];
            continue;
        }

        if (!current || typeof current !== 'object') {
            return { exists: false };
        }

        const record = current as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(record, segment)) {
            return { exists: false };
        }
        current = record[segment];
    }

    return {
        exists: true,
        value: current,
    };
}

function sameCrdtWaitValue(left: unknown, right: unknown): boolean {
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch (_error) {
        return Object.is(left, right);
    }
}

function containsCrdtWaitValue(value: unknown, expected: unknown): boolean {
    if (Array.isArray(value)) {
        return value.some(entry => sameCrdtWaitValue(entry, expected));
    }
    if (typeof value === 'string') {
        return value.includes(String(expected));
    }
    if (value && typeof value === 'object') {
        if (typeof expected === 'string') {
            try {
                return JSON.stringify(value).includes(expected);
            } catch (_error) {
                return String(value).includes(expected);
            }
        }
        return Object.values(value as Record<string, unknown>)
            .some(entry => sameCrdtWaitValue(entry, expected));
    }

    return String(value).includes(String(expected));
}

function crdtWaitConditionMatches(
    condition: BlackBoxRallarCrdtWaitCondition,
    value: unknown,
    health: unknown,
): boolean {
    const source = condition.source === 'value' ? value : health;
    const lookup = lookupCrdtWaitPath(source, condition.path);

    switch (condition.operator) {
        case 'equals':
            return lookup.exists && sameCrdtWaitValue(lookup.value, condition.expected);
        case 'notEquals':
            return !lookup.exists || !sameCrdtWaitValue(lookup.value, condition.expected);
        case 'contains':
            return lookup.exists && containsCrdtWaitValue(lookup.value, condition.expected);
        case 'exists':
            return condition.expected === undefined
                ? lookup.exists
                : lookup.exists === Boolean(condition.expected);
        case 'gte':
            return lookup.exists &&
                typeof lookup.value === 'number' &&
                typeof condition.expected === 'number' &&
                lookup.value >= condition.expected;
        case 'lte':
            return lookup.exists &&
                typeof lookup.value === 'number' &&
                typeof condition.expected === 'number' &&
                lookup.value <= condition.expected;
    }
}

function crdtRuntimeSummary(): BlackBoxRallarCrdtRuntimeSummary {
    return {
        handles: [...crdtDocuments.keys()],
        documents: [...crdtDocuments.entries()].map(([handle, document]) => ({
            handle,
            ref: document.ref,
            health: document.health(),
        })),
    };
}

function normalizeDirectorRoomInput(input: unknown): BlackBoxRallarDirectorRoomInput {
    const record = asRecord(input);
    const rallarConfig = asRecord(record.rallar);
    const scope = optionalRecord(record.scope) ?? optionalRecord(rallarConfig.scope);
    const roomRef = optionalRecord(record.roomRef) ?? optionalRecord(rallarConfig.roomRef);
    return {
        roomId: stringValue(record.roomId) ??
            stringValue(record.groupId) ??
            stringValue(rallarConfig.roomId),
        applicationId: stringValue(record.applicationId) ?? stringValue(rallarConfig.applicationId),
        workspaceId: stringValue(record.workspaceId) ?? stringValue(rallarConfig.workspaceId),
        scope,
        roomRef: roomRef as BlackBoxRallarRoomRef | undefined,
        timeoutMs: optionalNumber(record.timeoutMs),
    };
}

function normalizeDirectorAppointInput(input: unknown): BlackBoxRallarDirectorAppointInput {
    const record = asRecord(input);
    return {
        ...normalizeDirectorRoomInput(record),
        heartbeatTtlMs: optionalNumber(record.heartbeatTtlMs),
    };
}

function normalizeDirectorStatusInput(input: unknown): BlackBoxRallarDirectorStatusInput {
    const record = asRecord(input);
    return {
        ...normalizeDirectorRoomInput(record),
        refresh: typeof record.refresh === 'boolean' ? record.refresh : undefined,
        now: optionalNumber(record.now),
    };
}

function normalizeDirectorRelayStartInput(input: unknown): BlackBoxRallarDirectorRelayStartInput {
    const record = asRecord(input);
    const handle = stringValue(record.handle);
    const intentTypeId = stringValue(record.intentTypeId);
    const outputTypeId = stringValue(record.outputTypeId);
    if (!handle || !intentTypeId || !outputTypeId) {
        throw new Error('director.relay.start requires handle, intentTypeId, and outputTypeId.');
    }

    return {
        ...normalizeDirectorRoomInput(record),
        handle,
        laneId: stringValue(record.laneId),
        topicId: stringValue(record.topicId),
        intentTypeId,
        outputTypeId,
        heartbeatTypeId: stringValue(record.heartbeatTypeId),
        snapshotTypeId: stringValue(record.snapshotTypeId),
        syncRequestTypeId: stringValue(record.syncRequestTypeId),
        heartbeatIntervalMs: optionalNumber(record.heartbeatIntervalMs),
        snapshotIntervalMs: optionalNumber(record.snapshotIntervalMs),
        ...(Object.prototype.hasOwnProperty.call(record, 'snapshot') ? { snapshot: record.snapshot } : {}),
    };
}

function normalizeDirectorHandleInput(input: unknown): BlackBoxRallarDirectorHandleInput {
    const record = asRecord(input);
    const handle = stringValue(record.handle);
    if (!handle) {
        throw new Error('Director relay command requires handle.');
    }
    return {
        handle,
        timeoutMs: optionalNumber(record.timeoutMs),
    };
}

function normalizeDirectorIntentInput(input: unknown): BlackBoxRallarDirectorIntentInput {
    const record = asRecord(input);
    return {
        ...normalizeDirectorHandleInput(record),
        intent: record.intent,
    };
}

function normalizeDirectorSyncRequestInput(input: unknown): BlackBoxRallarDirectorSyncRequestInput {
    const record = asRecord(input);
    return {
        ...normalizeDirectorHandleInput(record),
        payload: record.payload,
    };
}

function toDirectorRoomRef(
    input: BlackBoxRallarDirectorRoomInput,
    config: BlackBoxRallarConnectionConfig,
): BlackBoxRallarRoomRef | undefined {
    return input.roomRef ?? roomRefOf(config, input as BlackBoxRallarSendInput);
}

function toDirectorTarget(
    input: BlackBoxRallarDirectorRoomInput,
    config: BlackBoxRallarConnectionConfig,
): string | BlackBoxRallarRoomRef | undefined {
    return toDirectorRoomRef(input, config) ?? input.roomId ?? config.roomId;
}

function toDirectorScope(
    input: BlackBoxRallarDirectorRoomInput,
    config: BlackBoxRallarConnectionConfig,
): ResolvedBlackBoxRallarScope | undefined {
    return scopeOf(config, input as BlackBoxRallarSendInput);
}

function directorStatusDiagnostics(
    status: BlackBoxRallarDirectorCommandDiagnostics['status'],
    input: BlackBoxRallarDirectorRoomInput,
    directorStatus: RallarDirectorStatus,
    config: BlackBoxRallarConnectionConfig,
    extra: Omit<BlackBoxRallarDirectorCommandDiagnostics, 'status' | 'roomId' | 'roomRef' | 'role' | 'state' | 'isDirector' | 'isFresh' | 'appointment' | 'directorStatus'> = {},
): BlackBoxRallarDirectorCommandDiagnostics {
    const roomRef = toDirectorRoomRef(input, config);
    return {
        status,
        roomId: input.roomId ?? roomRef?.groupId ?? config.roomId ?? directorStatus.roomId,
        ...(roomRef ? { roomRef } : {}),
        role: directorStatus.role,
        state: directorStatus.state,
        isDirector: directorStatus.isDirector,
        isFresh: directorStatus.isFresh,
        appointment: directorStatus.appointment,
        directorStatus,
        ...extra,
    };
}

function directorRelaySnapshot(entry: DirectorRelayState): Record<string, unknown> {
    const status = entry.relay.status();
    return entry.input.snapshot !== undefined
        ? {
            handle: entry.handle,
            static: true,
            status,
            snapshot: entry.input.snapshot,
        }
        : {
            handle: entry.handle,
            status,
            acceptedIntents: entry.acceptedIntents,
            outputs: entry.outputs,
            snapshots: entry.snapshots,
            syncRequests: entry.syncRequests,
            sequence: entry.sequence,
            generatedAtEpochMs: Date.now(),
        };
}

function directorRelaySummary(): BlackBoxRallarDirectorRelaySummary {
    return {
        handles: [...directorRelays.keys()],
        relays: [...directorRelays.values()].map(entry => ({
            handle: entry.handle,
            roomId: entry.input.roomId,
            topicId: entry.input.topicId,
            intentTypeId: entry.input.intentTypeId,
            outputTypeId: entry.input.outputTypeId,
            acceptedIntentCount: entry.acceptedIntents.length,
            outputCount: entry.outputs.length,
            snapshotCount: entry.snapshots.length,
            syncRequestCount: entry.syncRequests.length,
            status: entry.relay.status(),
        })),
    };
}

function emitDirectorDiagnostic(
    topic: string,
    handle: string | undefined,
    data: unknown,
    config: BlackBoxRallarConnectionConfig,
): void {
    emit({
        kind: 'diagnostic',
        topic,
        connection: config.connection,
        actor: config.actor,
        transport: transportOf(config),
        roomId: config.roomId,
        ...scopeDiagnostics(config),
        data: {
            ...(handle ? { handle } : {}),
            ...(data && typeof data === 'object' && !Array.isArray(data)
                ? data as Record<string, unknown>
                : { value: data }),
        },
    });
}

function intentIdFromPayload(payload: unknown, fallback: string): string {
    const record = asRecord(payload);
    return stringValue(record.intentId) ??
        stringValue(record.id) ??
        stringValue(record.messageId) ??
        fallback;
}

function requireDirectorRelay(handle: string): DirectorRelayState {
    const relay = directorRelays.get(handle);
    if (!relay) {
        throw new Error('Director relay handle is not open: ' + handle);
    }
    return relay;
}

function toCrdtDiagnostics(
    status: BlackBoxRallarCrdtCommandDiagnostics['status'],
    handle: string,
    document: RallarCrdtDocument<unknown, RallarCrdtOperationBatch> | undefined,
    options: Readonly<{
        update?: RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>;
        result?: unknown;
        value?: unknown;
        transportStrategy?: RallarCrdtTransportStrategy;
        attempts?: number;
        waitedMs?: number;
        stableForMs?: number;
        conditions?: readonly BlackBoxRallarCrdtWaitCondition[];
        lastSyncResult?: unknown;
    }> = {},
): BlackBoxRallarCrdtCommandDiagnostics {
    const health = document?.health();
    const value = options.value !== undefined
        ? options.value
        : document && status !== 'closed' && status !== 'destroyed'
            ? document.read()
            : undefined;

    return {
        status,
        handle,
        ...(document ? { ref: document.ref } : {}),
        ...(options.transportStrategy ? { transportStrategy: options.transportStrategy } : {}),
        ...(options.update ? { updateId: options.update.updateId } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(options.result !== undefined ? { result: options.result } : {}),
        ...(health !== undefined ? { health } : {}),
        ...(document ? { pendingUpdateCount: document.pendingUpdates().length } : {}),
        ...(document ? { failedPendingUpdateCount: document.failedPendingUpdates().length } : {}),
        ...(document ? { dependencyBlockedUpdateCount: document.dependencyBlockedUpdates().length } : {}),
        ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
        ...(options.waitedMs !== undefined ? { waitedMs: options.waitedMs } : {}),
        ...(options.stableForMs !== undefined ? { stableForMs: options.stableForMs } : {}),
        ...(options.conditions ? { conditions: options.conditions } : {}),
        ...(options.lastSyncResult !== undefined ? { lastSyncResult: options.lastSyncResult } : {}),
    };
}

function emitCrdtDiagnostic(
    topic: string,
    handle: string,
    data: unknown,
    config?: BlackBoxRallarConnectionConfig,
): void {
    emit({
        kind: 'diagnostic',
        topic,
        connection: config?.connection ?? handle,
        actor: config?.actor,
        roomId: config?.roomId,
        ...(config ? scopeDiagnostics(config) : {}),
        data,
    });
}

function messageSelectorOf(config: BlackBoxRallarConnectionConfig): string | {
    topicId?: string;
    typeId?: string;
} {
    if (config.rallar.messageSelector) {
        return config.rallar.messageSelector;
    }

    return {
        typeId: typeIdOf(config),
        topicId: config.rallar.topicId,
    };
}

function emit(partial: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void {
    const event: BlackBoxRallarEvent = {
        ...partial,
        atEpochMs: Date.now(),
    };
    if (typeof window === 'undefined') {
        return;
    }
    const handler = window.__blackBoxRallarEmit;
    if (!handler) {
        return;
    }

    try {
        void Promise.resolve(handler(event)).catch((error) => {
            console.error('black-box Rallar event sink failed', error);
        });
    } catch (error) {
        console.error('black-box Rallar event sink failed', error);
    }
}

function emitDiagnostic(
    config: BlackBoxRallarConnectionConfig,
    topic: string,
    data?: unknown,
): void {
    emit({
        kind: 'diagnostic',
        topic,
        connection: config.connection,
        actor: config.actor,
        transport: transportOf(config),
        roomId: config.roomId,
        ...scopeDiagnostics(config),
        laneId: laneIdOf(config),
        data,
    });
}

function installConsoleDiagnostics(
    config: BlackBoxRallarConnectionConfig,
): () => void {
    consoleDiagnosticConfig = config;
    if (!restoreConsoleWarn) {
        restoreExistingConsoleWarnPatch();
        const previousWarn = console.warn;
        console.warn = (...args: unknown[]) => {
            previousWarn(...args);
            const activeConfig = state?.config ?? consoleDiagnosticConfig;
            const classified = activeConfig ? classifyConsoleWarning(args) : undefined;
            if (!activeConfig || !classified) {
                return;
            }

            emit({
                kind: 'diagnostic',
                topic: classified.topic,
                connection: activeConfig.connection,
                actor: activeConfig.actor,
                transport: classified.transport,
                severity: 'warning',
                roomId: activeConfig.roomId,
                ...scopeDiagnostics(activeConfig),
                data: {
                    message: classified.message,
                    args,
                },
            });
        };
        restoreConsoleWarn = () => {
            console.warn = previousWarn;
            const globalState = consoleWarnGlobalState();
            if (globalState.__blackBoxRallarRestoreConsoleWarn === restoreConsoleWarn) {
                globalState.__blackBoxRallarRestoreConsoleWarn = undefined;
            }
            restoreConsoleWarn = undefined;
            consoleDiagnosticConfig = undefined;
        };
        consoleWarnGlobalState().__blackBoxRallarRestoreConsoleWarn = restoreConsoleWarn;
    }

    return () => {
        if (consoleDiagnosticConfig === config) {
            consoleDiagnosticConfig = state?.config;
        }
        if (!state && consoleDiagnosticConfig === undefined) {
            restoreConsoleWarn?.();
        }
    };
}

function restoreExistingConsoleWarnPatch(): void {
    consoleWarnGlobalState().__blackBoxRallarRestoreConsoleWarn?.();
}

function consoleWarnGlobalState(): typeof globalThis & {
    __blackBoxRallarRestoreConsoleWarn?: () => void;
} {
    return globalThis as typeof globalThis & {
        __blackBoxRallarRestoreConsoleWarn?: () => void;
    };
}

function classifyConsoleWarning(args: readonly unknown[]): Readonly<{
    topic: string;
    transport: BlackBoxRallarTransport | 'ws';
    message: string;
}> | undefined {
    const message = args.map(consoleWarningPart).join(' ');
    if (message.includes('Unhandled WS message') || message.includes('No callback for typeId')) {
        return {
            topic: 'rallar.browser.ws.unhandled_message',
            transport: 'ws',
            message,
        };
    }
    if (
        message.includes('Received data channel for different data channel name') ||
        message.includes('does not match peerId') ||
        message.includes('No channel for peer') ||
        message.includes('Ignoring self-connection attempt')
    ) {
        return {
            topic: 'rallar.browser.rtc.data_channel_warning',
            transport: 'realtime',
            message,
        };
    }
    return undefined;
}

function consoleWarningPart(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return String(value);
    }
}

function emitError(
    config: BlackBoxRallarConnectionConfig | undefined,
    topic: string,
    error: unknown,
    data?: unknown,
): void {
    emit({
        kind: 'diagnostic',
        topic,
        connection: config?.connection,
        actor: config?.actor,
        transport: config ? transportOf(config) : undefined,
        roomId: config?.roomId,
        ...(config ? scopeDiagnostics(config) : {}),
        laneId: config ? laneIdOf(config) : undefined,
        data,
        error: serializeError(error),
    });
}

function serializeError(error: unknown): unknown {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }

    return error;
}

function toSessionDiagnostic(session: RuntimeSessionDiagnostic): unknown {
    return {
        clientId: session.clientId,
        sessionId: session.sessionId,
        username: session.username,
    };
}

function cleanupRuntimeSubscriptions(
    runtimeState: RuntimeState | undefined,
    topicConfig: BlackBoxRallarConnectionConfig | undefined,
): number {
    let unsubscribed = 0;
    if (runtimeState?.unsubscribeMessagesRtc) {
        runtimeState.unsubscribeMessagesRtc();
        unsubscribed += 1;
    }
    if (runtimeState?.unsubscribeRealtime) {
        runtimeState.unsubscribeRealtime();
        unsubscribed += 1;
    }
    if (runtimeState?.unsubscribeRtcLifecycle) {
        runtimeState.unsubscribeRtcLifecycle();
        unsubscribed += 1;
    }
    if (runtimeState?.unsubscribeWsLifecycle) {
        runtimeState.unsubscribeWsLifecycle();
        unsubscribed += 1;
    }
    if (runtimeState?.unsubscribeConsoleDiagnostics) {
        runtimeState.unsubscribeConsoleDiagnostics();
    }
    if (runtimeState?.wsMessageUnsubscribes) {
        for (const unsubscribe of runtimeState.wsMessageUnsubscribes.values()) {
            unsubscribe();
            unsubscribed += 1;
        }
        runtimeState.wsMessageUnsubscribes.clear();
    }
    if (unsubscribed > 0 && topicConfig) {
        emitDiagnostic(topicConfig, 'rallar.browser.cleanup.unsubscribe_completed', {
            unsubscribed,
        });
    }
    return unsubscribed;
}

function emitSessionDiagnostics(
    config: BlackBoxRallarConnectionConfig,
    session: LoginResponse | AuthSession,
    previousState: RuntimeState | undefined,
): void {
    const expectedSessionId = config.rallar.expectedSessionId;
    if (expectedSessionId && expectedSessionId !== session.sessionId) {
        emitDiagnostic(config, 'rallar.browser.session.expected_mismatch', {
            expectedSessionId,
            actualSessionId: session.sessionId,
            username: session.username,
        });
    }

    if (!previousState) {
        return;
    }

    if (previousState.session.sessionId === session.sessionId) {
        emitDiagnostic(config, 'rallar.browser.session.duplicate_detected', {
            session: toSessionDiagnostic(session),
            previousConnection: previousState.config.connection,
            previousRoomId: previousState.config.roomId,
        });
        return;
    }

    emitDiagnostic(config, 'rallar.browser.session.active_replaced', {
        previousSession: toSessionDiagnostic(previousState.session),
        nextSession: toSessionDiagnostic(session),
        previousConnection: previousState.config.connection,
        previousRoomId: previousState.config.roomId,
    });
}

function toDiagnosticObject(data?: unknown): Record<string, unknown> {
    return data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : { data };
}

function toOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function emitConnectPhaseStarted(
    config: BlackBoxRallarConnectionConfig,
    phase: string,
    data?: unknown,
): void {
    emitDiagnostic(config, 'rallar.browser.connect.phase_started', {
        phase,
        ...toDiagnosticObject(data),
    });
}

function emitConnectPhaseCompleted(
    config: BlackBoxRallarConnectionConfig,
    phase: string,
    data?: unknown,
): void {
    emitDiagnostic(config, 'rallar.browser.connect.phase_completed', {
        phase,
        ...toDiagnosticObject(data),
    });
}

function requireState(): RuntimeState {
    if (!state) {
        throw new Error('Black-box Rallar runtime is not connected.');
    }
    return state;
}

function readHealth(
    config: BlackBoxRallarConnectionConfig,
): readonly RallarRealtimeLaneHealth[] {
    if (transportOf(config) !== 'realtime') {
        return [];
    }

    return rallar.realtime.health({
        laneIds: [laneIdOf(config)],
        peerIds: config.rallar.peerIds,
    });
}

function wsStatusFor(): ReturnType<typeof rallar.ws.status> {
    const ws = (rallar as unknown as {
        ws?: { status?: () => ReturnType<typeof rallar.ws.status> };
    }).ws;
    if (ws?.status) {
        return ws.status();
    }

    const connected = rallar.isConnected();
    return {
        sessionId: rallar.session()?.sessionId,
        connectState: rallar.status(),
        readyState: connected ? 'open' : 'missing',
        isOpen: connected,
        reconnecting: false,
        reconnectEnabled: false,
        reconnectAttempts: 0,
        maxReconnectAttempts: 0,
        reconnectExhausted: false,
    } as ReturnType<typeof rallar.ws.status>;
}

function rtcStatusFor(
    config: BlackBoxRallarConnectionConfig,
): ReturnType<typeof rallar.rtc.status> {
    const rtc = (rallar as unknown as {
        rtc?: { status?: (options?: unknown) => ReturnType<typeof rallar.rtc.status> };
    }).rtc;
    if (!rtc?.status) {
        return {
            sessionId: rallar.session()?.sessionId,
            laneId: transportOf(config) === 'realtime' ? laneIdOf(config) : DEFAULT_LANE_ID,
            knownPeerIds: [],
            activePeerIds: [],
            peerIdsWithNoReconnectableLanes: [],
            readyPeerIds: [],
            peers: [],
        } as ReturnType<typeof rallar.rtc.status>;
    }

    return rtc.status({
        laneId: transportOf(config) === 'realtime' ? laneIdOf(config) : undefined,
    });
}

async function rtcDiagnosticsFor(
    config: BlackBoxRallarConnectionConfig | undefined,
): Promise<RallarRtcDiagnostics | undefined> {
    const rtc = (rallar as unknown as {
        rtc?: { diagnostics?: (options?: unknown) => Promise<RallarRtcDiagnostics> };
    }).rtc;
    if (!rtc?.diagnostics) {
        return undefined;
    }

    const laneId = config && transportOf(config) === 'realtime'
        ? laneIdOf(config)
        : undefined;
    return await rtc.diagnostics(
        laneId ? { laneIds: [laneId] } : undefined,
    );
}

function includeRtcDiagnostics(input: BlackBoxRallarHealthInput | unknown): boolean {
    return !!input &&
        typeof input === 'object' &&
        (input as BlackBoxRallarHealthInput).includeRtcDiagnostics === true;
}

function statusDiagnostics(
    config: BlackBoxRallarConnectionConfig,
): Record<string, unknown> {
    return {
        rallarStatus: rallar.status(),
        rallarConnected: rallar.isConnected(),
        wsStatus: wsStatusFor(),
        rtcStatus: rtcStatusFor(config),
    };
}

function installRallarLifecycleDiagnostics(
    config: BlackBoxRallarConnectionConfig,
): Pick<RuntimeState, 'unsubscribeWsLifecycle' | 'unsubscribeRtcLifecycle'> {
    const ws = (rallar as unknown as {
        ws?: { onLifecycle?: (listener: (event: unknown) => void, options?: unknown) => () => void };
    }).ws;
    const rtc = (rallar as unknown as {
        rtc?: { onLifecycle?: (listener: (event: unknown) => void, options?: unknown) => () => void };
    }).rtc;

    return {
        unsubscribeWsLifecycle: ws?.onLifecycle
            ? ws.onLifecycle(event => {
                emitDiagnostic(config, 'rallar.browser.ws.lifecycle', event);
            }, { emitCurrent: true })
            : undefined,
        unsubscribeRtcLifecycle: rtc?.onLifecycle
            ? rtc.onLifecycle(event => {
                emitDiagnostic(config, 'rallar.browser.rtc.lifecycle', event);
            }, { emitCurrent: true })
            : undefined,
    };
}

async function loginOrRestore(
    config: BlackBoxRallarConnectionConfig,
): Promise<LoginResponse | AuthSession> {
    const { username, password, displayName, register, timeoutMs } = config.rallar;
    if (!username || !password) {
        emitDiagnostic(config, 'rallar.browser.auth.restore_started');
        const restored = rallar.auth.restore();
        if (!restored) {
            const error = new Error(
                'Rallar credentials are required when no browser session is restored.',
            );
            emitError(config, 'rallar.browser.auth.restore_failed', error, {
                phase: 'auth-restore',
            });
            throw error;
        }
        emitDiagnostic(config, 'rallar.browser.auth.restore_completed', {
            session: toSessionDiagnostic(restored),
        });
        return restored;
    }

    if (register === true || register === 'if-needed') {
        emitDiagnostic(config, 'rallar.browser.auth.register_started', {
            username,
            register,
        });
        try {
            const registered = await rallar.auth.registerAndLogin(
                { username, password, displayName },
                { timeoutMs },
            );
            emitDiagnostic(config, 'rallar.browser.auth.register_completed', {
                session: toSessionDiagnostic(registered),
            });
            return registered;
        } catch (error) {
            emitError(config, 'rallar.browser.auth.register_failed', error, {
                phase: 'auth-register',
                register,
            });
            if (register !== 'if-needed') {
                throw error;
            }
            emitDiagnostic(config, 'rallar.browser.register_failed_login_fallback', {
                error: serializeError(error),
            });
        }
    }

    emitDiagnostic(config, 'rallar.browser.auth.login_started', {
        username,
    });
    try {
        const loggedIn = await rallar.auth.login({ username, password }, { timeoutMs });
        emitDiagnostic(config, 'rallar.browser.auth.login_completed', {
            session: toSessionDiagnostic(loggedIn),
        });
        return loggedIn;
    } catch (error) {
        emitError(config, 'rallar.browser.auth.login_failed', error, {
            phase: 'auth-login',
        });
        throw error;
    }
}

async function connect(
    config: BlackBoxRallarConnectionConfig,
): Promise<BlackBoxRallarConnectDiagnostics> {
    let phase = 'validate-config';
    let lifecycleSubscriptions: Pick<
        RuntimeState,
        'unsubscribeWsLifecycle' | 'unsubscribeRtcLifecycle'
    > | undefined;
    let unsubscribeConsoleDiagnostics: (() => void) | undefined;

    try {
        if (!config.rallar.apiBaseUrl) {
            throw new Error('rallar.apiBaseUrl is required.');
        }

        const transport = transportOf(config);

        emitDiagnostic(config, 'rallar.browser.connect_started');
        unsubscribeConsoleDiagnostics = installConsoleDiagnostics(config);

        phase = 'transport-config';
        emitConnectPhaseStarted(config, phase, { transport });
        const laneId = transport === 'realtime' ? laneIdOf(config) : undefined;
        const typeId = transport === 'messages.rtc' ? typeIdOf(config) : undefined;
        const topicId = transport === 'messages.rtc' ? topicIdOf(config) : undefined;
        emitConnectPhaseCompleted(config, phase, {
            transport,
            laneId,
            typeId,
            topicId,
        });

        phase = 'configure';
        emitConnectPhaseStarted(config, phase, {
            apiBaseUrl: config.rallar.apiBaseUrl,
            ...scopeDiagnostics(config),
        });
        rallar.configure({ apiBaseUrl: config.rallar.apiBaseUrl });
        const defaults = toRallarDefaults(config);
        rallar.setDefaults(defaults as any);
        emitConnectPhaseCompleted(config, phase, {
            defaults,
        });

        phase = 'auth';
        const session = await loginOrRestore(config);
        emitDiagnostic(config, 'rallar.browser.authenticated', {
            clientId: session.clientId,
            sessionId: session.sessionId,
            username: session.username,
        });
        const previousState = state;
        emitSessionDiagnostics(config, session, previousState);
        lifecycleSubscriptions = installRallarLifecycleDiagnostics(config);

        phase = 'rallar-connect';
        emitConnectPhaseStarted(config, phase, {
            timeoutMs: config.rallar.timeoutMs,
            dataChannelLanes: config.rallar.dataChannelLanes,
            ...statusDiagnostics(config),
        });
        await rallar.connect({
            timeoutMs: config.rallar.timeoutMs,
            dataChannelLanes: config.rallar.dataChannelLanes,
        });
        emitConnectPhaseCompleted(config, phase, {
            ...statusDiagnostics(config),
        });

        if (config.roomId) {
            const roomRef = roomRefOf(config);
            const scope = scopeOf(config);
            phase = 'room-join';
            emitConnectPhaseStarted(config, phase, {
                roomId: config.roomId,
                roomRef,
                scope,
            });
            await rallar.rooms.join(config.roomId, {
                timeoutMs: config.rallar.timeoutMs,
                scope,
            });
            emitConnectPhaseCompleted(config, phase, {
                roomId: config.roomId,
                roomRef,
                scope,
                ...statusDiagnostics(config),
            });
        }

        phase = transport === 'realtime'
            ? 'subscribe-realtime'
            : 'subscribe-messages.rtc';
        emitConnectPhaseStarted(config, phase, {
            laneId,
            typeId,
            topicId,
            selector: transport === 'messages.rtc' ? messageSelectorOf(config) : undefined,
        });
        const unsubscribeRealtime = transport === 'realtime'
            ? rallar.realtime.onJson(laneId ?? DEFAULT_LANE_ID, (message) => {
                emit({
                    kind: 'message',
                    topic: 'rallar.browser.realtime.message',
                    connection: config.connection,
                    actor: config.actor,
                    transport,
                    roomId: config.roomId,
                    ...scopeDiagnostics(config),
                    laneId: message.laneId,
                    peerId: session.sessionId,
                    remotePeerId: message.peerId,
                    data: message.data,
                });
            })
            : undefined;
        const unsubscribeMessagesRtc = transport === 'messages.rtc'
            ? rallar.messages.rtc.onMessage(messageSelectorOf(config), (message) => {
                emit({
                    kind: 'message',
                    topic: 'rallar.browser.messages.rtc.message',
                    connection: config.connection,
                    actor: config.actor,
                    transport,
                    roomId: message.roomId ?? config.roomId,
                    ...scopeDiagnostics(config),
                    peerId: session.sessionId,
                    remotePeerId: message.senderId,
                    senderId: message.senderId,
                    typeId: message.typeId,
                    topicId: message.topicId,
                    contextId: message.contextId,
                    resourceId: message.resourceId,
                    data: message.payload,
                });
            })
            : undefined;
        emitConnectPhaseCompleted(config, phase, {
            laneId,
            typeId,
            topicId,
            ...statusDiagnostics(config),
        });

        cleanupRuntimeSubscriptions(previousState, config);
        state = {
            config,
            session,
            unsubscribeRealtime,
            unsubscribeMessagesRtc,
            unsubscribeConsoleDiagnostics,
            ...lifecycleSubscriptions,
        };

        const diagnostics: BlackBoxRallarConnectDiagnostics = {
            status: 'connected',
            connection: config.connection,
            actor: config.actor,
            transport,
            roomId: config.roomId,
            ...scopeDiagnostics(config),
            clientId: session.clientId,
            sessionId: session.sessionId,
            username: session.username,
            laneId,
            typeId,
            topicId,
            wsStatus: wsStatusFor(),
            rtcStatus: rtcStatusFor(config),
            health: readHealth(config),
        };
        emitDiagnostic(config, 'rallar.browser.connect_completed', diagnostics);
        return diagnostics;
    } catch (error) {
        lifecycleSubscriptions?.unsubscribeRtcLifecycle?.();
        lifecycleSubscriptions?.unsubscribeWsLifecycle?.();
        unsubscribeConsoleDiagnostics?.();
        restoreConsoleWarn?.();
        emitError(config, 'rallar.browser.connect.phase_failed', error, {
            phase,
        });
        emitError(config, 'rallar.browser.connect_failed', error, {
            phase,
        });
        throw error;
    }
}

function normalizeSendInput(
    input: BlackBoxRallarSendInput | unknown,
): BlackBoxRallarSendInput {
    if (
        input &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        ('data' in input ||
            'laneId' in input ||
            'roomId' in input ||
            'roomRef' in input ||
            'applicationId' in input ||
            'workspaceId' in input ||
            'scope' in input ||
            'peerIds' in input ||
            'nextHopPeerIds' in input ||
            'remotePeerId' in input ||
            'typeId' in input ||
            'topicId' in input ||
            'contextId' in input ||
            'resourceId' in input)
    ) {
        return input as BlackBoxRallarSendInput;
    }

    return { data: input };
}

function normalizeMessagesRtcSendInput(
    input: BlackBoxRallarSendInput | unknown,
): BlackBoxRallarSendInput {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        return input as BlackBoxRallarSendInput;
    }

    return { payload: input };
}

function summarizeRealtimeSendResults(
    results: readonly RallarRealtimeSendResult[],
): unknown {
    const statuses: Record<string, number> = {};
    const attentionResults = results.filter((entry) => {
        const status = entry.result.status;
        statuses[status] = (statuses[status] ?? 0) + 1;
        return status !== 'sent';
    });

    return {
        total: results.length,
        statuses,
        peerIds: results.map((entry) => entry.peerId),
        attentionResults,
    };
}

function realtimeSendStatusCount(summary: any, status: string): number {
    return Number(summary?.statuses?.[status] ?? 0);
}

function emitRealtimeSendOutcomeDiagnostics(
    config: BlackBoxRallarConnectionConfig,
    diagnostics: BlackBoxRallarSendDiagnostics,
): void {
    const results = diagnostics.results ?? [];
    const summary = summarizeRealtimeSendResults(results);

    if (results.length === 0) {
        emitDiagnostic(config, 'rallar.browser.realtime.peer_not_found', {
            roomId: diagnostics.roomId,
            laneId: diagnostics.laneId,
            peerIds: diagnostics.peerIds,
            health: diagnostics.health,
            summary,
        });
    }

    if (realtimeSendStatusCount(summary, 'closed') > 0) {
        emitDiagnostic(config, 'rallar.browser.realtime.data_channel_not_open', {
            roomId: diagnostics.roomId,
            laneId: diagnostics.laneId,
            peerIds: diagnostics.peerIds,
            health: diagnostics.health,
            summary,
        });
    }

    if (
        realtimeSendStatusCount(summary, 'queued') > 0 ||
        realtimeSendStatusCount(summary, 'dropped') > 0 ||
        realtimeSendStatusCount(summary, 'replaced') > 0 ||
        realtimeSendStatusCount(summary, 'closed') > 0
    ) {
        emitDiagnostic(config, 'rallar.browser.realtime.send_result_attention', {
            roomId: diagnostics.roomId,
            laneId: diagnostics.laneId,
            peerIds: diagnostics.peerIds,
            health: diagnostics.health,
            summary,
        });
    }
}

async function send(
    input: BlackBoxRallarSendInput | unknown,
): Promise<BlackBoxRallarSendDiagnostics> {
    const runtimeState = requireState();
    const { config } = runtimeState;
    try {
        const transport = transportOf(config);
        if (transport === 'messages.rtc') {
            return await sendMessagesRtc(input, config);
        }

        return await sendRealtime(input, config);
    } catch (error) {
        emitError(config, `rallar.browser.${transportOf(config)}.send_failed`, error, {
            transport: transportOf(config),
        });
        throw error;
    }
}

async function sendRealtime(
    input: BlackBoxRallarSendInput | unknown,
    config: BlackBoxRallarConnectionConfig,
): Promise<BlackBoxRallarSendDiagnostics> {
    const transport = transportOf(config);
    const normalized = normalizeSendInput(input);
    const peerIds = normalized.peerIds ??
        (normalized.remotePeerId
            ? [normalized.remotePeerId]
            : config.remotePeerId
            ? [config.remotePeerId]
            : config.rallar.peerIds);
    const laneId = normalized.laneId ?? laneIdOf(config);
    const roomId = normalized.roomId ?? config.roomId;
    const roomRef = roomRefOf(config, normalized);
    const data = 'data' in normalized ? normalized.data : normalized.payload;

    emitDiagnostic(config, 'rallar.browser.realtime.send_started', {
        roomId,
        roomRef,
        ...scopeDiagnostics(config, normalized),
        laneId,
        peerIds,
    });
    const results = await rallar.realtime.sendJson({
        data,
        laneId,
        roomId,
        roomRef,
        peerIds,
        openTimeoutMs: normalized.openTimeoutMs ?? config.rallar.openTimeoutMs,
        key: normalized.key,
        maxAgeMs: normalized.maxAgeMs,
    });
    const diagnostics: BlackBoxRallarSendDiagnostics = {
        status: results.length === 0 ? 'no-peers' : 'sent',
        connection: config.connection,
        actor: config.actor,
        transport,
        roomId,
        ...scopeDiagnostics(config, normalized),
        laneId,
        peerIds,
        results,
        health: readHealth(config),
    };
    emitRealtimeSendOutcomeDiagnostics(config, diagnostics);
    emitDiagnostic(config, 'rallar.browser.realtime.send_completed', diagnostics);
    return diagnostics;
}

async function sendMessagesRtc(
    input: BlackBoxRallarSendInput | unknown,
    config: BlackBoxRallarConnectionConfig,
): Promise<BlackBoxRallarSendDiagnostics> {
    const transport = transportOf(config);
    const normalized = normalizeMessagesRtcSendInput(input);
    const typeId = normalized.typeId ?? typeIdOf(config);
    const topicId = normalized.topicId ?? topicIdOf(config);
    const roomId = normalized.roomId ?? config.roomId;
    const roomRef = roomRefOf(config, normalized);
    const contextId = normalized.contextId ?? config.rallar.contextId;
    const resourceId = normalized.resourceId ?? config.rallar.resourceId;
    const minSnapshotVersion = toOptionalNumber(
        normalized.minSnapshotVersion ?? config.rallar.minSnapshotVersion,
    );
    const nextHopPeerIds = normalized.nextHopPeerIds ??
        normalized.peerIds ??
        config.rallar.nextHopPeerIds ??
        config.rallar.peerIds;
    const payload = 'payload' in normalized ? normalized.payload : normalized.data;

    emitDiagnostic(config, 'rallar.browser.messages.rtc.send_started', {
        roomId,
        roomRef,
        ...scopeDiagnostics(config, normalized),
        nextHopPeerIds,
        typeId,
        topicId,
        contextId,
        resourceId,
        minSnapshotVersion,
    });
    const messageInput: Record<string, unknown> = {
        typeId,
        topicId,
        contextId,
        resourceId,
        roomId,
        roomRef,
        payload,
        ttlHops: normalized.ttlHops ?? config.rallar.ttlHops,
        ttlMs: normalized.ttlMs ?? config.rallar.ttlMs,
        reliability: normalized.reliability ?? config.rallar.reliability,
        ack: normalized.ack ?? config.rallar.ack,
        ownership: normalized.ownership ?? config.rallar.ownership,
        membershipEpoch: normalized.membershipEpoch ?? config.rallar.membershipEpoch,
        minSnapshotVersion,
        seq: normalized.seq ?? config.rallar.seq,
        orderingKey: normalized.orderingKey ?? config.rallar.orderingKey,
        nextHopPeerIds,
        overlayId: normalized.overlayId ?? config.rallar.overlayId,
        fanoutLimit: normalized.fanoutLimit ?? config.rallar.fanoutLimit,
    };
    const message = await rallar.messages.rtc.send(messageInput as any);

    const diagnostics: BlackBoxRallarSendDiagnostics = {
        status: 'sent',
        connection: config.connection,
        actor: config.actor,
        transport,
        roomId,
        ...scopeDiagnostics(config, normalized),
        nextHopPeerIds,
        typeId,
        topicId,
        contextId,
        resourceId,
        minSnapshotVersion,
        message,
        health: readHealth(config),
    };
    emitDiagnostic(config, 'rallar.browser.messages.rtc.send_completed', diagnostics);
    return diagnostics;
}

function normalizeWsSendInput(input: unknown): Record<string, unknown> {
    return isRecord(input) ? input : { payload: input };
}

async function sendWs(
    input: unknown,
): Promise<BlackBoxRallarWsSendDiagnostics> {
    const runtimeState = requireState();
    const { config } = runtimeState;
    const normalized = normalizeWsSendInput(input);
    const roomId = stringValue(normalized.roomId) ??
        stringValue(normalized.groupId) ??
        config.roomId;
    const scope = wsScopeValue(normalized.scope) ?? (roomId ? 'room' : 'all');
    const scopedInput = {
        ...normalized,
        ...(roomId ? { roomId } : {}),
    } as BlackBoxRallarSendInput;
    const roomRef = roomId ? roomRefOf(config, scopedInput) : undefined;
    const typeId = stringValue(normalized.typeId) ??
        stringValue(normalized.topic) ??
        stringValue(normalized.kind) ??
        'rallar.black-box.ws.json';
    const topicId = stringValue(normalized.topicId) ??
        stringValue(normalized.topic) ??
        typeId;
    const contextId = stringValue(normalized.contextId) ?? roomId ?? scope;
    const resourceId = stringValue(normalized.resourceId);
    const minSnapshotVersion = toOptionalNumber(
        normalized.minSnapshotVersion ?? config.rallar.minSnapshotVersion,
    );
    const payload = 'payload' in normalized
        ? normalized.payload
        : 'data' in normalized
            ? normalized.data
            : input;
    ensureWsMessageSubscription(config, typeId, topicId);

    emit({
        kind: 'diagnostic',
        topic: 'rallar.browser.ws.send_started',
        connection: config.connection,
        actor: config.actor,
        transport: 'ws',
        roomId,
        roomRef,
        ...scopeDiagnostics(config, scopedInput),
        typeId,
        topicId,
        contextId,
        resourceId,
        data: {
            scope,
            minSnapshotVersion,
            wsStatus: wsStatusFor(),
        },
    });

    try {
        const result = await rallar.messages.ws.send({
            typeId,
            topicId,
            contextId,
            resourceId,
            scope,
            roomId,
            roomRef,
            payload,
            minSnapshotVersion,
            exceptPeerIds: maybeStringArray(normalized.exceptPeerIds),
            ttlHops: toOptionalNumber(normalized.ttlHops ?? config.rallar.ttlHops),
            ttlMs: toOptionalNumber(normalized.ttlMs ?? config.rallar.ttlMs),
            reliability: normalized.reliability ?? config.rallar.reliability,
            ack: normalized.ack ?? config.rallar.ack,
            ownership: normalized.ownership ?? config.rallar.ownership,
        } as any);
        const diagnostics: BlackBoxRallarWsSendDiagnostics = {
            status: 'sent',
            connection: config.connection,
            actor: config.actor,
            transport: 'ws',
            roomId,
            roomRef,
            ...scopeDiagnostics(config, scopedInput),
            scope,
            typeId,
            topicId,
            contextId,
            resourceId,
            minSnapshotVersion,
            message: payload,
            result,
            wsStatus: wsStatusFor(),
            rtcStatus: rtcStatusFor(config),
        };
        emit({
            kind: 'diagnostic',
            topic: 'rallar.browser.ws.send_completed',
            connection: config.connection,
            actor: config.actor,
            transport: 'ws',
            roomId,
            roomRef,
            ...scopeDiagnostics(config, scopedInput),
            typeId,
            topicId,
            contextId,
            resourceId,
            data: diagnostics,
        });
        return diagnostics;
    } catch (error) {
        emitError(config, 'rallar.browser.ws.send_failed', error, {
            transport: 'ws',
            roomId,
            roomRef,
            typeId,
            topicId,
            contextId,
            resourceId,
            scope,
        });
        throw error;
    }
}

function ensureWsMessageSubscription(
    config: BlackBoxRallarConnectionConfig,
    typeId: string,
    topicId?: string,
): void {
    const runtimeState = requireState();
    runtimeState.wsMessageUnsubscribes ??= new Map<string, () => void>();
    const key = wsSelectorKey(typeId, topicId);
    if (runtimeState.wsMessageUnsubscribes.has(key)) {
        return;
    }

    const unsubscribe = rallar.messages.ws.onMessage({
        typeId,
        ...(topicId ? { topicId } : {}),
    }, message => {
        emit({
            kind: 'message',
            topic: 'rallar.browser.ws.message',
            connection: config.connection,
            actor: config.actor,
            transport: 'ws',
            roomId: message.roomId ?? config.roomId,
            ...scopeDiagnostics(config),
            senderId: message.senderId,
            typeId: message.typeId,
            topicId: message.topicId,
            contextId: message.contextId,
            resourceId: message.resourceId,
            data: message.payload,
        });
    });
    runtimeState.wsMessageUnsubscribes.set(key, unsubscribe);
    emit({
        kind: 'diagnostic',
        topic: 'rallar.browser.ws.subscribed',
        connection: config.connection,
        actor: config.actor,
        transport: 'ws',
        roomId: config.roomId,
        ...scopeDiagnostics(config),
        typeId,
        topicId,
    });
}

async function crdtOpen(
    rawInput: BlackBoxRallarCrdtOpenInput | unknown,
): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
    const input = normalizeCrdtOpenInput(rawInput);
    const handle = crdtHandle(input);
    if (crdtDocuments.has(handle)) {
        throw new Error('CRDT document handle is already open: ' + handle);
    }

    let config: BlackBoxRallarConnectionConfig | undefined;
    try {
        config = await ensureCrdtLiveConnection(input);
        const document = await rallar.crdt.open(
            input.name,
            toCrdtOpenOptions(input),
        );
        crdtDocuments.set(handle, document);
        const diagnostics = toCrdtDiagnostics('opened', handle, document, {
            transportStrategy: input.transport,
        });
        emitCrdtDiagnostic('rallar.browser.crdt.opened', handle, diagnostics, config);
        return diagnostics;
    } catch (error) {
        emitError(config, 'rallar.browser.crdt.open_failed', error, {
            handle,
            transportStrategy: input.transport,
        });
        throw error;
    }
}

async function crdtApply(
    input: BlackBoxRallarCrdtApplyInput | unknown,
): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
    const record = asRecord(input);
    const handle = crdtHandle(record);
    const document = requireCrdtDocument(handle);
    const batch = record.batch as RallarCrdtOperationBatch | undefined;
    if (!batch) {
        throw new Error('crdt.apply requires batch.');
    }

    try {
        const update = await document.applyLocal(batch);
        const diagnostics = toCrdtDiagnostics('applied', handle, document, {
            update,
        });
        emitCrdtDiagnostic('rallar.browser.crdt.applied', handle, diagnostics);
        return diagnostics;
    } catch (error) {
        emitError(undefined, 'rallar.browser.crdt.apply_failed', error, { handle });
        throw error;
    }
}

async function crdtRead(
    input: BlackBoxRallarCrdtHandleInput | unknown,
): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
    const handle = crdtHandle(input);
    const document = requireCrdtDocument(handle);
    const diagnostics = toCrdtDiagnostics('read', handle, document, {
        value: document.read(),
    });
    emitCrdtDiagnostic('rallar.browser.crdt.read', handle, diagnostics);
    return diagnostics;
}

async function crdtSync(
    input: BlackBoxRallarCrdtSyncInput | unknown,
): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
    const record = asRecord(input);
    const handle = crdtHandle(record);
    const document = requireCrdtDocument(handle);
    const options: RallarCrdtSyncOptions = {
        ...(stringValue(record.reason) ? { reason: stringValue(record.reason) } : {}),
        ...(toCrdtTransport(record.transport) ? { transport: toCrdtTransport(record.transport) } : {}),
    };

    try {
        const result = await document.sync(options);
        const diagnostics = toCrdtDiagnostics('synced', handle, document, {
            result,
            transportStrategy: toCrdtTransport(record.transport),
        });
        emitCrdtDiagnostic('rallar.browser.crdt.synced', handle, diagnostics);
        return diagnostics;
    } catch (error) {
        emitError(undefined, 'rallar.browser.crdt.sync_failed', error, { handle });
        throw error;
    }
}

async function crdtHealth(
    input: BlackBoxRallarCrdtHandleInput | unknown,
): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
    const handle = crdtHandle(input);
    const document = requireCrdtDocument(handle);
    const diagnostics = toCrdtDiagnostics('health', handle, document);
    emitCrdtDiagnostic('rallar.browser.crdt.health', handle, diagnostics);
    return diagnostics;
}

async function crdtWait(
    rawInput: BlackBoxRallarCrdtWaitInput | unknown,
): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
    const input = normalizeCrdtWaitInput(rawInput);
    const document = requireCrdtDocument(input.handle);
    const timeoutMs = input.timeoutMs ?? 10_000;
    const intervalMs = input.intervalMs ?? 250;
    const stableForMs = input.stableForMs ?? 0;
    const startEpochMs = Date.now();
    const deadlineEpochMs = startEpochMs + timeoutMs;
    const syncOptions: RallarCrdtSyncOptions | undefined = input.sync && typeof input.sync === 'object'
        ? {
            ...(input.sync.reason ? { reason: input.sync.reason } : {}),
            ...(input.sync.transport ? { transport: input.sync.transport } : {}),
        }
        : undefined;
    let attempts = 0;
    let stableSinceEpochMs: number | undefined;
    let lastSyncResult: unknown;
    let lastValue: unknown;
    let lastHealth: unknown;

    emitCrdtDiagnostic('rallar.browser.crdt.waiting', input.handle, {
        status: 'waiting',
        handle: input.handle,
        ref: document.ref,
        timeoutMs,
        intervalMs,
        stableForMs,
        conditions: input.conditions,
        sync: input.sync,
    });

    try {
        while (true) {
            attempts += 1;
            if (syncOptions) {
                lastSyncResult = await document.sync(syncOptions);
            }

            lastValue = document.read();
            lastHealth = document.health();
            const now = Date.now();
            const matched = input.conditions.every(condition =>
                crdtWaitConditionMatches(condition, lastValue, lastHealth)
            );

            if (matched) {
                stableSinceEpochMs ??= now;
                if (stableForMs <= 0 || now - stableSinceEpochMs >= stableForMs) {
                    const diagnostics = toCrdtDiagnostics('wait_matched', input.handle, document, {
                        value: lastValue,
                        result: {
                            matched: true,
                            matchedAtEpochMs: now,
                        },
                        attempts,
                        waitedMs: now - startEpochMs,
                        stableForMs,
                        conditions: input.conditions,
                        lastSyncResult,
                    });
                    emitCrdtDiagnostic('rallar.browser.crdt.wait_matched', input.handle, diagnostics);
                    return diagnostics;
                }
            } else {
                stableSinceEpochMs = undefined;
            }

            if (now >= deadlineEpochMs) {
                throw new Error('Timed out waiting for CRDT conditions on handle: ' + input.handle);
            }

            await delay(Math.min(intervalMs, Math.max(0, deadlineEpochMs - now)));
        }
    } catch (error) {
        emitError(undefined, 'rallar.browser.crdt.wait_failed', error, {
            handle: input.handle,
            attempts,
            waitedMs: Date.now() - startEpochMs,
            stableForMs,
            conditions: input.conditions,
            lastValue,
            lastHealth,
            lastSyncResult,
        });
        throw error;
    }
}

async function crdtUndo(
    input: BlackBoxRallarCrdtUndoRedoInput | unknown,
): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
    const record = asRecord(input);
    const handle = crdtHandle(record);
    const document = requireCrdtDocument(handle);
    const targetOperationGroupId = stringValue(record.targetOperationGroupId);
    const operations = Array.isArray(record.operations)
        ? record.operations as readonly RallarCrdtOperation[]
        : undefined;
    if (!targetOperationGroupId || !operations) {
        throw new Error('crdt.undo requires targetOperationGroupId and operations.');
    }

    try {
        const update = await document.undoOperationGroup({
            targetOperationGroupId,
            operations,
            ...(stringValue(record.operationGroupId)
                ? { operationGroupId: stringValue(record.operationGroupId) }
                : {}),
        });
        const diagnostics = toCrdtDiagnostics('undone', handle, document, {
            update,
        });
        emitCrdtDiagnostic('rallar.browser.crdt.undone', handle, diagnostics);
        return diagnostics;
    } catch (error) {
        emitError(undefined, 'rallar.browser.crdt.undo_failed', error, { handle });
        throw error;
    }
}

async function crdtRedo(
    input: BlackBoxRallarCrdtUndoRedoInput | unknown,
): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
    const record = asRecord(input);
    const handle = crdtHandle(record);
    const document = requireCrdtDocument(handle);
    const targetOperationGroupId = stringValue(record.targetOperationGroupId);
    const operations = Array.isArray(record.operations)
        ? record.operations as readonly RallarCrdtOperation[]
        : undefined;
    if (!targetOperationGroupId || !operations) {
        throw new Error('crdt.redo requires targetOperationGroupId and operations.');
    }

    try {
        const update = await document.redoOperationGroup({
            targetOperationGroupId,
            operations,
            ...(stringValue(record.operationGroupId)
                ? { operationGroupId: stringValue(record.operationGroupId) }
                : {}),
        });
        const diagnostics = toCrdtDiagnostics('redone', handle, document, {
            update,
        });
        emitCrdtDiagnostic('rallar.browser.crdt.redone', handle, diagnostics);
        return diagnostics;
    } catch (error) {
        emitError(undefined, 'rallar.browser.crdt.redo_failed', error, { handle });
        throw error;
    }
}

async function crdtClose(
    input: BlackBoxRallarCrdtHandleInput | unknown,
): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
    const handle = crdtHandle(input);
    const document = requireCrdtDocument(handle);
    const diagnostics = toCrdtDiagnostics('closed', handle, document);
    await document.close();
    crdtDocuments.delete(handle);
    emitCrdtDiagnostic('rallar.browser.crdt.closed', handle, diagnostics);
    return diagnostics;
}

async function crdtDestroy(
    input: BlackBoxRallarCrdtHandleInput | unknown,
): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
    const handle = crdtHandle(input);
    const document = requireCrdtDocument(handle);
    const diagnostics = toCrdtDiagnostics('destroyed', handle, document);
    await document.destroy();
    crdtDocuments.delete(handle);
    emitCrdtDiagnostic('rallar.browser.crdt.destroyed', handle, diagnostics);
    return diagnostics;
}

async function directorAppoint(input: BlackBoxRallarDirectorAppointInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> {
    const runtimeState = requireState();
    const config = runtimeState.config;
    const normalized = normalizeDirectorAppointInput(input);
    const target = toDirectorTarget(normalized, config);
    const directorStatus = await rallar.director.appoint(target as any, {
        heartbeatTtlMs: normalized.heartbeatTtlMs,
        scope: toDirectorScope(normalized, config),
        timeoutMs: normalized.timeoutMs,
    } as any);
    const diagnostics = directorStatusDiagnostics('appointed', normalized, directorStatus, config);
    emitDirectorDiagnostic('rallar.browser.director.appointed', undefined, diagnostics, config);
    return diagnostics;
}

async function directorResign(input: BlackBoxRallarDirectorRoomInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> {
    const runtimeState = requireState();
    const config = runtimeState.config;
    const normalized = normalizeDirectorRoomInput(input);
    const target = toDirectorTarget(normalized, config);
    const directorStatus = await rallar.director.resign(target as any, {
        scope: toDirectorScope(normalized, config),
        timeoutMs: normalized.timeoutMs,
    } as any);
    const diagnostics = directorStatusDiagnostics('resigned', normalized, directorStatus, config);
    emitDirectorDiagnostic('rallar.browser.director.resigned', undefined, diagnostics, config);
    return diagnostics;
}

async function directorStatus(input: BlackBoxRallarDirectorStatusInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> {
    const runtimeState = requireState();
    const config = runtimeState.config;
    const normalized = normalizeDirectorStatusInput(input);
    const target = toDirectorTarget(normalized, config);
    if (normalized.refresh) {
        await rallar.rooms.refresh({
            scope: toDirectorScope(normalized, config),
            timeoutMs: normalized.timeoutMs,
        } as any);
    }
    const status = rallar.director.status(target as any, {
        now: normalized.now,
    });
    const diagnostics = directorStatusDiagnostics('status', normalized, status, config);
    emitDirectorDiagnostic('rallar.browser.director.status', undefined, diagnostics, config);
    return diagnostics;
}

async function directorRelayStart(input: BlackBoxRallarDirectorRelayStartInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> {
    const runtimeState = requireState();
    const config = runtimeState.config;
    const normalized = normalizeDirectorRelayStartInput(input);
    if (directorRelays.has(normalized.handle)) {
        throw new Error('Director relay handle is already open: ' + normalized.handle);
    }

    let entry!: DirectorRelayState;
    const relay = rallar.director.createRelay<unknown, BlackBoxRallarDirectorOutputRecord, unknown>({
        roomId: normalized.roomId ?? config.roomId,
        roomRef: toDirectorRoomRef(normalized, config) as any,
        laneId: normalized.laneId,
        topicId: normalized.topicId,
        intentTypeId: normalized.intentTypeId,
        outputTypeId: normalized.outputTypeId,
        heartbeatTypeId: normalized.heartbeatTypeId,
        snapshotTypeId: normalized.snapshotTypeId,
        syncRequestTypeId: normalized.syncRequestTypeId,
        heartbeatIntervalMs: normalized.heartbeatIntervalMs,
        snapshotIntervalMs: normalized.snapshotIntervalMs,
        readSnapshot: () => directorRelaySnapshot(entry),
        onIntent: (message: RallarDirectorRelayMessage<unknown>) => {
            const nextSequence = entry.sequence + 1;
            const output: BlackBoxRallarDirectorOutputRecord = {
                kind: 'black-box-director-output',
                intentId: intentIdFromPayload(message.data, `intent-${nextSequence}`),
                sequence: nextSequence,
                senderId: message.senderId,
                directorSessionId: entry.relay.status().appointment?.sessionId,
                directorPrincipalId: entry.relay.status().appointment?.principalId,
                epoch: message.envelope.epoch,
                receivedAtEpochMs: message.receivedAtEpochMs,
                payload: message.data,
            };
            entry.sequence = nextSequence;
            entry.acceptedIntents.push({
                intentId: output.intentId,
                senderId: message.senderId,
                epoch: message.envelope.epoch,
                receivedAtEpochMs: message.receivedAtEpochMs,
                payload: message.data,
            });
            entry.outputs.push(output);
            emitDirectorDiagnostic('rallar.browser.director.intent_received', entry.handle, {
                intent: entry.acceptedIntents.at(-1),
                output,
            }, config);
            return output;
        },
        onOutput: (message: RallarDirectorRelayMessage<BlackBoxRallarDirectorOutputRecord>) => {
            entry.outputs.push(message.data);
            emitDirectorDiagnostic('rallar.browser.director.output_received', entry.handle, {
                output: message.data,
                senderId: message.senderId,
                epoch: message.envelope.epoch,
                receivedAtEpochMs: message.receivedAtEpochMs,
            }, config);
        },
        onSnapshot: (message: RallarDirectorRelayMessage<unknown>) => {
            entry.snapshots.push(message.data);
            emitDirectorDiagnostic('rallar.browser.director.snapshot_received', entry.handle, {
                snapshot: message.data,
                senderId: message.senderId,
                epoch: message.envelope.epoch,
                receivedAtEpochMs: message.receivedAtEpochMs,
            }, config);
        },
        onSyncRequest: (message: RallarDirectorRelayMessage<unknown>) => {
            entry.syncRequests.push({
                senderId: message.senderId,
                epoch: message.envelope.epoch,
                receivedAtEpochMs: message.receivedAtEpochMs,
                payload: message.data,
            });
            emitDirectorDiagnostic('rallar.browser.director.sync_request_received', entry.handle, {
                syncRequest: entry.syncRequests.at(-1),
            }, config);
        },
    });

    entry = {
        handle: normalized.handle,
        input: normalized,
        relay,
        acceptedIntents: [],
        outputs: [],
        snapshots: [],
        syncRequests: [],
        sequence: 0,
    };
    directorRelays.set(normalized.handle, entry);
    const status = relay.status();
    const diagnostics = directorStatusDiagnostics('relay_started', normalized, status, config, {
        handle: normalized.handle,
        relay: {
            handle: normalized.handle,
            topicId: normalized.topicId,
            intentTypeId: normalized.intentTypeId,
            outputTypeId: normalized.outputTypeId,
            heartbeatTypeId: normalized.heartbeatTypeId,
            snapshotTypeId: normalized.snapshotTypeId,
            syncRequestTypeId: normalized.syncRequestTypeId,
        },
    });
    emitDirectorDiagnostic('rallar.browser.director.relay_started', normalized.handle, diagnostics, config);
    return diagnostics;
}

async function directorIntent(input: BlackBoxRallarDirectorIntentInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> {
    const runtimeState = requireState();
    const config = runtimeState.config;
    const normalized = normalizeDirectorIntentInput(input);
    const relay = requireDirectorRelay(normalized.handle);
    const sendResult = await relay.relay.sendIntent(normalized.intent);
    const diagnostics = directorStatusDiagnostics('intent_sent', relay.input, relay.relay.status(), config, {
        handle: normalized.handle,
        sendResult,
    });
    emitDirectorDiagnostic('rallar.browser.director.intent_sent', normalized.handle, {
        ...diagnostics,
        intent: normalized.intent,
    }, config);
    return diagnostics;
}

async function directorSyncRequest(input: BlackBoxRallarDirectorSyncRequestInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> {
    const runtimeState = requireState();
    const config = runtimeState.config;
    const normalized = normalizeDirectorSyncRequestInput(input);
    const relay = requireDirectorRelay(normalized.handle);
    const sendResult = await relay.relay.requestSync(normalized.payload);
    const diagnostics = directorStatusDiagnostics('sync_requested', relay.input, relay.relay.status(), config, {
        handle: normalized.handle,
        sendResult,
    });
    emitDirectorDiagnostic('rallar.browser.director.sync_requested', normalized.handle, {
        ...diagnostics,
        payload: normalized.payload,
    }, config);
    return diagnostics;
}

async function directorRelayStop(input: BlackBoxRallarDirectorHandleInput | unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> {
    const runtimeState = requireState();
    const config = runtimeState.config;
    const normalized = normalizeDirectorHandleInput(input);
    const relay = requireDirectorRelay(normalized.handle);
    const status = relay.relay.status();
    relay.relay.stop();
    directorRelays.delete(normalized.handle);
    const diagnostics = directorStatusDiagnostics('relay_stopped', relay.input, status, config, {
        handle: normalized.handle,
        acceptedIntentCount: relay.acceptedIntents.length,
        outputCount: relay.outputs.length,
        snapshotCount: relay.snapshots.length,
        syncRequestCount: relay.syncRequests.length,
    });
    emitDirectorDiagnostic('rallar.browser.director.relay_stopped', normalized.handle, diagnostics, config);
    return diagnostics;
}

async function close(): Promise<BlackBoxRallarCloseDiagnostics> {
    const runtimeState = state;
    const config = runtimeState?.config;
    const cleanupErrors: unknown[] = [];
    let unsubscribed = 0;
    let leftRoom = false;
    let logout = false;
    let disconnected = false;
    try {
        if (config) {
            emitDiagnostic(config, 'rallar.browser.cleanup.started', {
                roomId: config.roomId,
                ...scopeDiagnostics(config),
                logoutOnClose: config.rallar.logoutOnClose === true,
                leaveRoomOnClose: config.rallar.leaveRoomOnClose !== false,
            });
        }

        try {
            unsubscribed = cleanupRuntimeSubscriptions(runtimeState, config);
        } catch (error) {
            cleanupErrors.push(serializeError(error));
            emitError(config, 'rallar.browser.cleanup.unsubscribe_failed', error);
        }

        for (const [handle, relay] of [...directorRelays.entries()]) {
            try {
                relay.relay.stop();
                directorRelays.delete(handle);
                if (config) {
                    emitDirectorDiagnostic('rallar.browser.director.relay_stopped', handle, {
                        status: 'relay_stopped',
                        handle,
                        reason: 'runtime-close',
                        acceptedIntentCount: relay.acceptedIntents.length,
                        outputCount: relay.outputs.length,
                        snapshotCount: relay.snapshots.length,
                        syncRequestCount: relay.syncRequests.length,
                    }, config);
                }
            } catch (error) {
                cleanupErrors.push(serializeError(error));
                emitError(config, 'rallar.browser.director.relay_stop_failed', error, {
                    handle,
                    reason: 'runtime-close',
                });
            }
        }

        for (const [handle, document] of [...crdtDocuments.entries()]) {
            try {
                await document.close();
                crdtDocuments.delete(handle);
                emitCrdtDiagnostic('rallar.browser.crdt.closed', handle, {
                    status: 'closed',
                    handle,
                    ref: document.ref,
                    reason: 'runtime-close',
                }, config);
            } catch (error) {
                cleanupErrors.push(serializeError(error));
                emitError(config, 'rallar.browser.crdt.close_failed', error, {
                    handle,
                    reason: 'runtime-close',
                });
            }
        }

        if (config?.roomId && config.rallar.leaveRoomOnClose !== false) {
            const roomRef = roomRefOf(config);
            const scope = scopeOf(config);
            emitDiagnostic(config, 'rallar.browser.cleanup.room_leave_started', {
                roomId: config.roomId,
                roomRef,
                scope,
            });
            try {
                await rallar.rooms.leave({
                    roomId: config.roomId,
                    roomRef,
                    scope,
                    clearCurrent: true,
                    timeoutMs: config.rallar.timeoutMs,
                });
                leftRoom = true;
                emitDiagnostic(config, 'rallar.browser.cleanup.room_leave_completed', {
                    roomId: config.roomId,
                    roomRef,
                    scope,
                });
            } catch (error) {
                cleanupErrors.push(serializeError(error));
                emitError(config, 'rallar.browser.cleanup.room_leave_failed', error, {
                    roomId: config.roomId,
                    roomRef,
                    scope,
                });
            }
        } else if (config) {
            emitDiagnostic(config, 'rallar.browser.cleanup.room_leave_skipped', {
                roomId: config.roomId,
                leaveRoomOnClose: config.rallar.leaveRoomOnClose,
            });
        }

        if (config?.rallar.logoutOnClose) {
            emitDiagnostic(config, 'rallar.browser.cleanup.logout_started');
            await rallar.auth.logout({ timeoutMs: config.rallar.timeoutMs });
            logout = true;
            emitDiagnostic(config, 'rallar.browser.cleanup.logout_completed');
        } else {
            if (config) {
                emitDiagnostic(config, 'rallar.browser.cleanup.disconnect_started');
            }
            await rallar.disconnect();
            disconnected = true;
            if (config) {
                emitDiagnostic(config, 'rallar.browser.cleanup.disconnect_completed');
            }
        }
        state = undefined;
        restoreConsoleWarn?.();
        const diagnostics: BlackBoxRallarCloseDiagnostics = {
            status: 'closed',
            connection: config?.connection,
            actor: config?.actor,
            transport: config ? transportOf(config) : undefined,
            roomId: config?.roomId,
            ...(config ? scopeDiagnostics(config) : {}),
            unsubscribed,
            leftRoom,
            logout,
            disconnected,
            cleanupErrors,
        };
        emit({
            kind: 'close',
            topic: 'rallar.browser.closed',
            connection: config?.connection,
            actor: config?.actor,
            transport: config ? transportOf(config) : undefined,
            roomId: config?.roomId,
            ...(config ? scopeDiagnostics(config) : {}),
            data: diagnostics,
        });
        return diagnostics;
    } catch (error) {
        emitError(config, 'rallar.browser.close_failed', error);
        throw error;
    }
}

async function health(
    input: BlackBoxRallarHealthInput | unknown = {},
): Promise<BlackBoxRallarHealthDiagnostics> {
    const config = state?.config;
    const transport = config ? transportOf(config) : undefined;
    const rtcLaneId = transport === 'realtime' && config
        ? laneIdOf(config)
        : undefined;
    const rtcStatus = config
        ? rtcStatusFor(config)
        : ((rallar as unknown as {
            rtc?: { status?: (options?: unknown) => ReturnType<typeof rallar.rtc.status> };
        }).rtc?.status?.({ laneId: rtcLaneId }) ?? {
            sessionId: rallar.session()?.sessionId,
            laneId: rtcLaneId ?? DEFAULT_LANE_ID,
            knownPeerIds: [],
            activePeerIds: [],
            peerIdsWithNoReconnectableLanes: [],
            readyPeerIds: [],
            peers: [],
        } as ReturnType<typeof rallar.rtc.status>);
    let rtcDiagnostics: RallarRtcDiagnostics | undefined;
    let rtcDiagnosticsError: unknown;
    if (includeRtcDiagnostics(input)) {
        try {
            rtcDiagnostics = await rtcDiagnosticsFor(config);
        } catch (error) {
            rtcDiagnosticsError = serializeError(error);
            emitError(config, 'rallar.browser.rtc.diagnostics_failed', error);
        }
    }
    return {
        connected: rallar.isConnected(),
        status: rallar.status(),
        wsStatus: wsStatusFor(),
        rtcStatus,
        connection: config?.connection,
        actor: config?.actor,
        transport,
        roomId: config?.roomId,
        ...(config ? scopeDiagnostics(config) : {}),
        session: rallar.session(),
        health: config ? readHealth(config) : [],
        ...(rtcDiagnostics !== undefined ? { rtcDiagnostics } : {}),
        ...(rtcDiagnosticsError !== undefined ? { rtcDiagnosticsError } : {}),
        crdt: crdtRuntimeSummary(),
        director: directorRelaySummary(),
    };
}

window.__blackBoxRallar = {
    connect,
    send,
    sendWs,
    crdt: {
        open: crdtOpen,
        apply: crdtApply,
        read: crdtRead,
        sync: crdtSync,
        health: crdtHealth,
        wait: crdtWait,
        undo: crdtUndo,
        redo: crdtRedo,
        close: crdtClose,
        destroy: crdtDestroy,
    },
    director: {
        appoint: directorAppoint,
        resign: directorResign,
        status: directorStatus,
        relayStart: directorRelayStart,
        intent: directorIntent,
        syncRequest: directorSyncRequest,
        relayStop: directorRelayStop,
    },
    close,
    health,
};

emit({
    kind: 'diagnostic',
    topic: 'rallar.browser.runtime_loaded',
});
