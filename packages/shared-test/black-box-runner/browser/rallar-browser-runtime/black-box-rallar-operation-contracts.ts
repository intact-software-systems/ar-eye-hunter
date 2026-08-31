import type {
    RallarConnectStatus,
    RallarDirectorRelaySendResult,
    RallarDirectorStatus,
    RallarMessageSelectorInput,
    RallarMessageSendResult,
    RallarRealtimeLaneHealth,
    RallarRealtimeSendResult,
    RallarRtcDiagnostics,
    RallarRtcStatus,
    RallarWsStatus
} from '@shared-web/browser/rallar.ts';
import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarCrdtDocumentHealth,
    RallarCrdtDocumentRef,
    RallarCrdtDocumentTypePolicy,
    RallarCrdtEncryptionKeyring,
    RallarCrdtJsonValue,
    RallarCrdtOperation,
    RallarCrdtOperationBatch,
    RallarCrdtSyncOptions,
    RallarCrdtSyncResult,
    RallarCrdtTransportStrategy,
    RallarCrdtValidationOptions
} from '@shared/crdt/mod.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/web-rtc-connection-service.ts';
import type { BlackBoxRallarSerializedError } from './black-box-rallar-serialized-error.ts';

export type BlackBoxRallarTransport = 'realtime' | 'messages.rtc';

export interface BlackBoxRallarScope {
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

export interface ResolvedBlackBoxRallarScope {
    readonly applicationId: string;
    readonly workspaceId: string;
}

export interface BlackBoxRallarRoomRef {
    readonly applicationId: string;
    readonly workspaceId?: string;
    readonly groupId: string;
}

export interface BlackBoxRallarConfig {
    readonly apiBaseUrl: string;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly scope?: BlackBoxRallarScope;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly username?: string;
    readonly password?: string;
    readonly displayName?: string;
    readonly register?: boolean | 'if-needed';
    readonly transport?: BlackBoxRallarTransport;
    readonly laneId?: string;
    readonly openTimeoutMs?: number;
    readonly timeoutMs?: number;
    readonly peerIds?: readonly string[];
    readonly nextHopPeerIds?: readonly string[];
    readonly typeId?: string;
    readonly topicId?: string;
    readonly contextId?: string;
    readonly resourceId?: string;
    readonly messageSelector?: RallarMessageSelectorInput;
    readonly ttlHops?: number;
    readonly ttlMs?: number;
    readonly reliability?: 'best-effort' | 'at-least-once';
    readonly ack?: ALAckMode;
    readonly ownership?: 'shared' | 'exclusive';
    readonly membershipEpoch?: number;
    readonly minSnapshotVersion?: number;
    readonly seq?: number;
    readonly orderingKey?: string;
    readonly overlayId?: string;
    readonly fanoutLimit?: number;
    readonly dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    readonly expectedSessionId?: string;
    readonly leaveRoomOnClose?: boolean;
    readonly logoutOnClose?: boolean;
}

export interface BlackBoxRallarConnectionConfig {
    readonly connection: string;
    readonly actor?: string;
    readonly peerId?: string;
    readonly remotePeerId?: string;
    readonly roomId?: string;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly rallar: BlackBoxRallarConfig;
}

export interface BlackBoxRallarSendInput {
    readonly data?: unknown;
    readonly payload?: unknown;
    readonly laneId?: string;
    readonly roomId?: string;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly scope?: BlackBoxRallarScope;
    readonly peerIds?: readonly string[];
    readonly nextHopPeerIds?: readonly string[];
    readonly remotePeerId?: string;
    readonly typeId?: string;
    readonly topicId?: string;
    readonly contextId?: string;
    readonly resourceId?: string;
    readonly ttlHops?: number;
    readonly ttlMs?: number;
    readonly reliability?: 'best-effort' | 'at-least-once';
    readonly ack?: ALAckMode;
    readonly ownership?: 'shared' | 'exclusive';
    readonly membershipEpoch?: number;
    readonly minSnapshotVersion?: number;
    readonly seq?: number;
    readonly orderingKey?: string;
    readonly overlayId?: string;
    readonly fanoutLimit?: number;
    readonly openTimeoutMs?: number;
    readonly key?: string;
    readonly maxAgeMs?: number;
}

export interface BlackBoxRallarEvent {
    readonly kind: 'diagnostic' | 'message' | 'close';
    readonly topic: string;
    readonly atEpochMs: number;
    readonly connection?: string;
    readonly actor?: string;
    readonly transport?: BlackBoxRallarTransport | 'ws';
    readonly severity?: 'debug' | 'info' | 'warning' | 'error';
    readonly roomId?: string;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly scope?: BlackBoxRallarScope;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly laneId?: string;
    readonly peerId?: string;
    readonly remotePeerId?: string;
    readonly senderId?: string;
    readonly typeId?: string;
    readonly topicId?: string;
    readonly contextId?: string;
    readonly resourceId?: string;
    readonly data?: unknown;
    readonly error?: BlackBoxRallarSerializedError;
}

export interface BlackBoxRallarConnectDiagnostics {
    readonly status: 'connected';
    readonly connection: string;
    readonly actor?: string;
    readonly transport: BlackBoxRallarTransport;
    readonly roomId?: string;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly scope?: BlackBoxRallarScope;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly clientId: string;
    readonly sessionId: string;
    readonly username: string;
    readonly laneId?: string;
    readonly typeId?: string;
    readonly topicId?: string;
    readonly wsStatus: RallarWsStatus;
    readonly rtcStatus: RallarRtcStatus;
    readonly health: readonly RallarRealtimeLaneHealth[];
}

export interface BlackBoxRallarAuthenticateDiagnostics {
    readonly status: 'authenticated';
    readonly connection: string;
    readonly actor?: string;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly scope?: BlackBoxRallarScope;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly clientId: string;
    readonly sessionId: string;
    readonly username: string;
}

export interface BlackBoxRallarSendDiagnostics {
    readonly status: 'sent' | 'no-peers';
    readonly connection: string;
    readonly actor?: string;
    readonly transport: BlackBoxRallarTransport;
    readonly roomId?: string;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly scope?: BlackBoxRallarScope;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly laneId?: string;
    readonly peerIds?: readonly string[];
    readonly nextHopPeerIds?: readonly string[];
    readonly typeId?: string;
    readonly topicId?: string;
    readonly contextId?: string;
    readonly resourceId?: string;
    readonly minSnapshotVersion?: number;
    readonly results?: readonly RallarRealtimeSendResult[];
    readonly message?: RallarMessageSendResult;
    readonly health: readonly RallarRealtimeLaneHealth[];
}

export interface BlackBoxRallarWsSendDiagnostics {
    readonly status: 'sent';
    readonly connection: string;
    readonly actor?: string;
    readonly transport: 'ws';
    readonly roomId?: string;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly scope?: 'room' | 'world' | 'all';
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly typeId: string;
    readonly topicId?: string;
    readonly contextId?: string;
    readonly resourceId?: string;
    readonly minSnapshotVersion?: number;
    readonly message?: unknown;
    readonly result: RallarMessageSendResult;
    readonly wsStatus: RallarWsStatus;
    readonly rtcStatus: RallarRtcStatus;
}

export interface BlackBoxRallarCloseDiagnostics {
    readonly status: 'closed';
    readonly connection?: string;
    readonly actor?: string;
    readonly transport?: BlackBoxRallarTransport;
    readonly roomId?: string;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly scope?: BlackBoxRallarScope;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly unsubscribed: number;
    readonly leftRoom: boolean;
    readonly logout: boolean;
    readonly disconnected: boolean;
    readonly cleanupErrors: readonly BlackBoxRallarSerializedError[];
}

export interface BlackBoxRallarHealthDiagnostics {
    readonly connected: boolean;
    readonly status: RallarConnectStatus;
    readonly wsStatus: RallarWsStatus;
    readonly rtcStatus: RallarRtcStatus;
    readonly connection?: string;
    readonly actor?: string;
    readonly transport?: BlackBoxRallarTransport;
    readonly roomId?: string;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly scope?: BlackBoxRallarScope;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly session?: AuthSession;
    readonly health: readonly RallarRealtimeLaneHealth[];
    readonly rtcDiagnostics?: RallarRtcDiagnostics;
    readonly rtcDiagnosticsError?: BlackBoxRallarSerializedError;
    readonly crdt?: BlackBoxRallarCrdtRuntimeSummary;
    readonly director?: BlackBoxRallarDirectorRelaySummary;
}

export interface BlackBoxRallarHealthInput {
    readonly includeRtcDiagnostics?: boolean;
}

export interface BlackBoxRallarCrdtScopeInput extends BlackBoxRallarScope {
    readonly kind?: 'app' | 'principal' | 'room' | 'custom';
    readonly principalId?: string;
    readonly customScope?: string;
}

export interface BlackBoxRallarCrdtConnectionInput extends Partial<Omit<BlackBoxRallarConfig, 'scope'>> {
    readonly scope?: BlackBoxRallarCrdtScopeInput;
    readonly roomId?: string;
    readonly sessionId?: string;
    readonly crdtTransport?: RallarCrdtTransportStrategy;
}

export interface BlackBoxRallarCrdtOpenInput {
    readonly handle?: string;
    readonly name: string;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly documentId?: string;
    readonly documentType?: string;
    readonly scope?: BlackBoxRallarCrdtScopeInput;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly principalId?: string;
    readonly customScope?: string;
    readonly transport?: RallarCrdtTransportStrategy;
    readonly persist?: boolean;
    readonly tabSync?: boolean;
    readonly initialValue?: RallarCrdtJsonValue;
    readonly policies?: readonly RallarCrdtDocumentTypePolicy[];
    readonly validation?: RallarCrdtValidationOptions;
    readonly encryption?: Omit<RallarCrdtEncryptionKeyring, 'now' | 'randomBytes'>;
    readonly durableCatchUp?: false | 'http';
    readonly apiBaseUrl?: string;
    readonly actor?: string;
    readonly sessionId?: string;
    readonly username?: string;
    readonly password?: string;
    readonly displayName?: string;
    readonly register?: boolean | 'if-needed';
    readonly timeoutMs?: number;
    readonly roomId?: string;
    readonly rallar?: BlackBoxRallarCrdtConnectionInput;
}

export interface BlackBoxRallarCrdtHandleInput {
    readonly handle: string;
    readonly timeoutMs?: number;
}

export interface BlackBoxRallarCrdtApplyInput extends BlackBoxRallarCrdtHandleInput {
    readonly batch: RallarCrdtOperationBatch;
}

export interface BlackBoxRallarCrdtSyncInput extends BlackBoxRallarCrdtHandleInput {
    readonly reason?: string;
    readonly transport?: RallarCrdtTransportStrategy;
}

export type BlackBoxRallarCrdtWaitOperator = 'equals' | 'notEquals' | 'contains' | 'exists' | 'gte' | 'lte';

export interface BlackBoxRallarCrdtWaitCondition {
    readonly source: 'value' | 'health';
    readonly path?: string;
    readonly operator: BlackBoxRallarCrdtWaitOperator;
    readonly expected?: RallarCrdtJsonValue;
}

export interface BlackBoxRallarCrdtWaitInput extends BlackBoxRallarCrdtHandleInput {
    readonly intervalMs?: number;
    readonly stableForMs?: number;
    readonly sync?:
        | false
        | RallarCrdtSyncOptions;
    readonly conditions: readonly BlackBoxRallarCrdtWaitCondition[];
}

export interface BlackBoxRallarCrdtUndoRedoInput extends BlackBoxRallarCrdtHandleInput {
    readonly targetOperationGroupId: string;
    readonly operations: readonly RallarCrdtOperation[];
    readonly operationGroupId?: string;
}

export interface BlackBoxRallarCrdtRuntimeSummary {
    readonly handles: readonly string[];
    readonly documents: readonly BlackBoxRallarCrdtDocumentSummary[];
}

export interface BlackBoxRallarCrdtCommandDiagnostics {
    readonly status:
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
    readonly handle: string;
    readonly ref?: RallarCrdtDocumentRef;
    readonly transportStrategy?: RallarCrdtTransportStrategy;
    readonly updateId?: string;
    readonly value?: RallarCrdtJsonValue;
    readonly result?: RallarCrdtSyncResult | BlackBoxRallarCrdtWaitMatch;
    readonly health?: RallarCrdtDocumentHealth;
    readonly pendingUpdateCount?: number;
    readonly failedPendingUpdateCount?: number;
    readonly dependencyBlockedUpdateCount?: number;
    readonly attempts?: number;
    readonly waitedMs?: number;
    readonly stableForMs?: number;
    readonly conditions?: readonly BlackBoxRallarCrdtWaitCondition[];
    readonly lastSyncResult?: RallarCrdtSyncResult;
}

export interface BlackBoxRallarCrdtRuntime {
    open(input: unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    apply(input: unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    read(input: unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    sync(input: unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    health(input: unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    wait(input: unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    undo(input: unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    redo(input: unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    close(input: unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
    destroy(input: unknown): Promise<BlackBoxRallarCrdtCommandDiagnostics>;
}

export interface BlackBoxRallarDirectorRoomInput {
    readonly roomId?: string;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly scope?: BlackBoxRallarScope;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly timeoutMs?: number;
}

export interface BlackBoxRallarDirectorAppointInput extends BlackBoxRallarDirectorRoomInput {
    readonly heartbeatTtlMs?: number;
}

export interface BlackBoxRallarDirectorStatusInput extends BlackBoxRallarDirectorRoomInput {
    readonly refresh?: boolean;
    readonly now?: number;
}

export interface BlackBoxRallarDirectorRelayStartInput extends BlackBoxRallarDirectorRoomInput {
    readonly handle: string;
    readonly laneId?: string;
    readonly topicId?: string;
    readonly intentTypeId: string;
    readonly outputTypeId: string;
    readonly heartbeatTypeId?: string;
    readonly snapshotTypeId?: string;
    readonly syncRequestTypeId?: string;
    readonly heartbeatIntervalMs?: number;
    readonly snapshotIntervalMs?: number;
    readonly snapshot?: unknown;
}

export interface BlackBoxRallarDirectorHandleInput {
    readonly handle: string;
    readonly timeoutMs?: number;
}

export interface BlackBoxRallarDirectorIntentInput extends BlackBoxRallarDirectorHandleInput {
    readonly intent: unknown;
}

export interface BlackBoxRallarDirectorSyncRequestInput extends BlackBoxRallarDirectorHandleInput {
    readonly payload?: unknown;
}

export interface BlackBoxRallarDirectorOutputRecord {
    readonly kind: 'black-box-director-output';
    readonly intentId: string;
    readonly sequence: number;
    readonly senderId: string;
    readonly directorSessionId?: string;
    readonly directorPrincipalId?: string;
    readonly epoch?: number;
    readonly receivedAtEpochMs: number;
    readonly payload: unknown;
}

export interface BlackBoxRallarDirectorRelaySummary {
    readonly handles: readonly string[];
    readonly relays: readonly BlackBoxRallarDirectorRelayStatus[];
}

export interface BlackBoxRallarDirectorCommandDiagnostics {
    readonly status:
        | 'appointed'
        | 'resigned'
        | 'status'
        | 'relay_started'
        | 'intent_sent'
        | 'sync_requested'
        | 'relay_stopped';
    readonly handle?: string;
    readonly roomId?: string;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly role?: RallarDirectorStatus['role'];
    readonly state?: RallarDirectorStatus['state'];
    readonly isDirector?: boolean;
    readonly isFresh?: boolean;
    readonly appointment?: RallarDirectorStatus['appointment'];
    readonly directorStatus?: RallarDirectorStatus;
    readonly relay?: BlackBoxRallarDirectorRelayDescription;
    readonly sendResult?: RallarDirectorRelaySendResult;
    readonly acceptedIntentCount?: number;
    readonly outputCount?: number;
    readonly snapshotCount?: number;
    readonly syncRequestCount?: number;
}

export interface BlackBoxRallarDirectorRuntime {
    appoint(input: unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    resign(input: unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    status(input: unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    relayStart(
        input: unknown
    ): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    intent(input: unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    syncRequest(
        input: unknown
    ): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
    relayStop(input: unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics>;
}

export interface BlackBoxRallarCrdtWaitMatch {
    readonly matched: true;
    readonly matchedAtEpochMs: number;
}

export interface BlackBoxRallarDirectorRelayDescription {
    readonly handle: string;
    readonly topicId: string | undefined;
    readonly intentTypeId: string;
    readonly outputTypeId: string;
    readonly heartbeatTypeId: string | undefined;
    readonly snapshotTypeId: string | undefined;
    readonly syncRequestTypeId: string | undefined;
}

export interface BlackBoxRallarCrdtDocumentSummary {
    readonly handle: string;
    readonly ref: RallarCrdtDocumentRef;
    readonly health: RallarCrdtDocumentHealth;
}

export interface BlackBoxRallarDirectorRelayStatus {
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
}
