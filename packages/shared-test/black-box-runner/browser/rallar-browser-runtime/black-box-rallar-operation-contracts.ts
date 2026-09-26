import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarRtcRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import type {
    RallarConnectStatus,
    RallarDirectorRelaySendResult,
    RallarDirectorStatus,
    RallarMessageSelectorInput,
    RallarRealtimeLaneHealth,
    RallarRealtimeSendResult,
    RallarRtcDiagnostics,
    RallarRtcStatus,
    RallarWsStatus
} from '@shared-web/browser/rallar.ts';
import type { RallarRoomLayout } from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';
import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';
import type { ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryAttemptOutcome,
    ALDeliveryCarrier,
    ALDeliveryEvidence,
    ALDeliveryReceiptEvidence,
    ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupActivationCondition } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type {
    GroupFormationOutcome,
    GroupLifecycleState,
    GroupMemberPolicy,
    GroupTopologyReconfigureLanding,
    GroupTransportState
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupDialLayoutRoles } from '@shared/api/group-lifecycle/resolve-dial-layout-roles.ts';
import type {
    GroupRef,
    GroupSnapshot,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
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
import type { BlackBoxRtcCausalState } from './read-black-box-rtc-causal-state.ts';

export type BlackBoxRallarTransport = 'realtime' | 'messages.rtc' | 'messages.ws';

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
    /** The RTC message types a topic-only selector must also hear: the product registers RTC inbox callbacks per type. */
    readonly messageTypeIds?: readonly string[];
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
    readonly data?: RallarMessagePayload;
    readonly payload?: RallarMessagePayload;
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

export interface BlackBoxRallarDocumentFacts {
    readonly timeOrigin: number;
    readonly origin: string;
}

export interface BlackBoxRallarConnectDiagnostics {
    readonly document: BlackBoxRallarDocumentFacts;
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

/** Each optional field appears only when the connection or the send names that scope. */
export interface BlackBoxRallarSendScopeDiagnostics {
    readonly connection: string;
    readonly actor: string | undefined;
    readonly roomId: string | undefined;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly scope?: BlackBoxRallarScope;
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

export interface BlackBoxRallarRealtimeSendDiagnostics extends BlackBoxRallarSendScopeDiagnostics {
    readonly status: 'sent' | 'no-peers';
    readonly transport: Exclude<BlackBoxRallarTransport, 'messages.rtc'>;
    readonly laneId: string;
    readonly peerIds: readonly string[];
    readonly results: readonly RallarRealtimeSendResult[];
    readonly health: readonly RallarRealtimeLaneHealth[];
}

export interface BlackBoxRallarMessagesRtcSendDiagnostics extends BlackBoxRallarSendScopeDiagnostics {
    readonly transport: 'messages.rtc';
    readonly typeId: string;
    readonly topicId: string | undefined;
    readonly contextId: string | undefined;
    readonly resourceId: string | undefined;
    readonly minSnapshotVersion: number | undefined;
    readonly nextHopPeerIds: readonly string[] | undefined;
    readonly message: BlackBoxRallarDeliveryObservation;
    readonly health: readonly RallarRealtimeLaneHealth[];
}

export type BlackBoxRallarSendDiagnostics =
    | BlackBoxRallarRealtimeSendDiagnostics
    | BlackBoxRallarMessagesRtcSendDiagnostics;

/** The room fields appear only when the send names a room or an application. */
export interface BlackBoxRallarWsSendDiagnostics {
    readonly status: 'sent';
    readonly connection: string;
    readonly actor: string | undefined;
    readonly transport: 'ws';
    readonly roomId: string | undefined;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly scope: 'room' | 'world' | 'all';
    readonly typeId: string;
    readonly topicId: string | undefined;
    readonly contextId: string | undefined;
    readonly resourceId: string | undefined;
    readonly minSnapshotVersion: number | undefined;
    readonly message: RallarMessagePayload;
    readonly result: BlackBoxRallarDeliveryObservation;
    readonly wsStatus: RallarWsStatus;
    readonly rtcStatus: RallarRtcStatus;
}

export interface BlackBoxRallarMessageSendInput {
    readonly timeoutMs: number;
    readonly connection: string;
    readonly carrier: 'ws' | 'rtc' | 'rtc-with-ws-fallback';
    readonly typeId: string;
    readonly topicId: string | undefined;
    readonly payload: RallarMessagePayload;
    readonly roomRef: BlackBoxRallarRoomRef | undefined;
    readonly scope: 'room' | 'world' | 'all' | undefined;
    readonly reliability: 'best-effort' | 'at-least-once' | undefined;
    readonly ack: ALAckMode | undefined;
    readonly ttlMs: number | undefined;
    readonly orderingKey: string | undefined;
    readonly seq: number | undefined;
    readonly handleId: string;
    /** Absent, the product stamps the sender's own room version. */
    readonly minSnapshotVersion: BlackBoxRallarMessageSnapshotFloor | undefined;
    /** Absent, the product normalizes the QoS the delivery options imply. */
    readonly qos: Required<Pick<ALQosPolicyRequest, 'ack'>> | undefined;
}

/** A harness floor: `aboveCurrentBy` resolves against the sender's room version at send time. */
export type BlackBoxRallarMessageSnapshotFloor =
    | Readonly<{ absolute: number; }>
    | Readonly<{ aboveCurrentBy: number; }>;

export interface BlackBoxRallarMessageReplayTarget {
    readonly handleId: string;
    readonly carrier: ALDeliveryCarrier;
}

/** A `messages.send` that names only the earlier handle and the carrier its captured envelope is re-admitted on. */
export interface BlackBoxRallarMessageReplayInput {
    readonly timeoutMs: number;
    readonly connection: string;
    readonly replayOnCarrier: BlackBoxRallarMessageReplayTarget;
}

/** A replay opens no handle of its own: it reports the replayed handle and the carrier admission's verdict. */
export interface BlackBoxRallarMessageReplayDiagnostics {
    readonly handleId: string;
    readonly msgId: string;
    readonly carrier: ALDeliveryCarrier;
    readonly verdict: ALDeliveryAdmissionVerdict['kind'];
    /** The verdict's own detail; undefined for `admitted`, `duplicate` and `pending`, which carry none. */
    readonly reason: string | undefined;
}

/**
 * A harness capability, not a product path: one raw control envelope under the authored `msgId`, shaped as the ACK of
 * `ackedMsgId` from this session and carrying `typeId`, admitted on `carrier` for `toPeerId`, the sender of that message.
 */
export interface BlackBoxRallarControlSubmitInput {
    readonly carrier: ALDeliveryCarrier;
    readonly typeId: string;
    readonly msgId: string;
    readonly ackedMsgId: string;
    readonly toPeerId: string;
}

/** The raw control opens no handle: it reports its own identity and the verdict of the carrier admission. */
export interface BlackBoxRallarControlSubmitDiagnostics {
    readonly msgId: string;
    readonly typeId: string;
    readonly carrier: ALDeliveryCarrier;
    readonly verdict: ALDeliveryAdmissionVerdict['kind'];
    /** The verdict's own detail; undefined for `admitted`, `duplicate` and `pending`, which carry none. */
    readonly reason: string | undefined;
}

export interface BlackBoxRallarMessageSendDiagnostics {
    readonly handleId: string;
    readonly msgId: string;
    readonly carrier: BlackBoxRallarMessageSendInput['carrier'];
    readonly status: ALDeliveryState;
    readonly reason: string | undefined;
}

export interface BlackBoxRallarDeliveryObservation
    extends ALDeliveryReceiptEvidence, Pick<ALDeliveryEvidence, 'relayRejection'> {
    readonly handleId: string;
    readonly state: ALDeliveryState;
    readonly submitted: boolean;
    readonly attempts: number;
    /** The outcome of every settled attempt in attempt order, a refused or unroutable admission leg included. */
    readonly attemptOutcomes: readonly ALDeliveryAttemptOutcome[];
    readonly reason: string | undefined;
    /** A carrier refused admission because of its own rate limit or open circuit, not for want of a route. */
    readonly backpressured: boolean;
    /** The message reached a durable carrier queue, which is what a persistent admission promises. */
    readonly enqueued: boolean;
}

export interface BlackBoxRallarDeliveryHandleInput {
    readonly connection: string;
    readonly handleId: string;
}

export interface BlackBoxRallarDeliveryObserveInput extends BlackBoxRallarDeliveryHandleInput {
    readonly state: readonly ALDeliveryState[];
    readonly timeoutMs: number;
}

export interface BlackBoxRallarStorageCountersInput {
    readonly reset: boolean;
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
    readonly document: BlackBoxRallarDocumentFacts;
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
    readonly rtcCausalState?: BlackBoxRtcCausalState;
    readonly rtcDiagnosticsError?: BlackBoxRallarSerializedError;
    readonly crdt?: BlackBoxRallarCrdtRuntimeSummary;
    readonly director?: BlackBoxRallarDirectorRelaySummary;
    readonly formation?: BlackBoxRallarFormationSummary;
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

export interface BlackBoxRallarFormationRoomInput {
    readonly roomRef: GroupRef;
    readonly timeoutMs: number;
}

export type BlackBoxRallarFormationCommandInput =
    | Readonly<{ command: 'connect'; layout?: GroupLayoutIdentity; }>
    | Readonly<{ command: 'reconfigure'; landing?: GroupTopologyReconfigureLanding; }>
    | Readonly<{ command: 'plan' | 'activate' | 'pause' | 'resume' | 'reset' | 'start'; }>;

export interface BlackBoxRallarFormationCommandRequest extends BlackBoxRallarFormationRoomInput {
    readonly input: BlackBoxRallarFormationCommandInput;
    readonly reason?: string;
}

/**
 * `RallarRoomFormationStatus` without its `snapshot`, carrying the causal revision lifted out of it
 * and the six fields of the room's transport status the pins read. The status declares its
 * absent-capable fields as required-with-`undefined`, so this record is built field by field: a
 * spread would carry explicit `undefined` keys that a recipe's `exists` operator then sees.
 */
export interface BlackBoxRallarFormationSummary {
    readonly roomRef: GroupRef;
    readonly stage: GroupLifecycleState;
    readonly formationEpoch: number;
    readonly formationAttemptCount: number;
    readonly lastFormationOutcome?: GroupFormationOutcome;
    readonly causalRevision: GroupStateCausalRevision;
    readonly transportState: GroupTransportState;
    readonly dialing: GroupDialLayoutRoles;
    readonly memberPolicy: GroupMemberPolicy;
    readonly accepted?: RallarRoomLayout;
    readonly planned?: RallarRoomLayout;
    readonly condition?: GroupActivationCondition;
    readonly coverageRate?: number;
    readonly room: BlackBoxRallarFormationRoomStatus;
}

/** The room transport status projected to what a pin may assert on. */
export type BlackBoxRallarFormationRoomStatus =
    & Pick<
        RallarRtcRoomTransportStatus,
        'state' | 'desiredPeerIds' | 'readyPeerIds' | 'activePeerIds' | 'failedPeerIds'
    >
    & {
        readonly acceptedLayoutIdentity?: GroupLayoutIdentity;
    };

export interface BlackBoxRallarFormationCommandDiagnostics {
    readonly receipt: GroupSnapshot;
    readonly formation: BlackBoxRallarFormationSummary;
}

export interface BlackBoxRallarFormationReadinessDiagnostics {
    readonly readyAtEpochMs: number;
    readonly formation: BlackBoxRallarFormationSummary;
}

export interface BlackBoxRallarFormationRuntime {
    command(
        request: BlackBoxRallarFormationCommandRequest
    ): Promise<BlackBoxRallarFormationCommandDiagnostics>;
    readiness(
        room: BlackBoxRallarFormationRoomInput
    ): Promise<BlackBoxRallarFormationReadinessDiagnostics>;
}
