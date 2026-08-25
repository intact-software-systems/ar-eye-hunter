import type { RallarConnectStatus } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarRoomTransportStatus,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomTransportOptions,
    RallarWaitForOpenOptions,
    RallarWaitForOpenStatus
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarOnChangeOptions, RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RtcDataChannelHealth,
    RtcDataChannelSendOptions,
    RtcDataChannelSendResult
} from '@shared/webrtc/QRtcDataChannel.ts';

export interface RallarRealtimeSendOptions extends RtcDataChannelSendOptions {
    readonly laneId?: string;
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly peerIds?: readonly string[];
    readonly openTimeoutMs?: number;
}

export interface RallarRealtimeJsonSendInput<T> extends RallarRealtimeSendOptions {
    readonly data: T;
}

export interface RallarRealtimeBinarySendInput extends RallarRealtimeSendOptions {
    readonly data: ArrayBuffer | ArrayBufferView<ArrayBuffer>;
}

export interface RallarRealtimeSendResult {
    readonly peerId: string;
    readonly laneId: string;
    readonly result: RtcDataChannelSendResult;
}

export type RallarRealtimeJsonLaneSendOptions<T> = Omit<RallarRealtimeJsonSendInput<T>, 'data'>;

export interface RallarRealtimeJsonLane<T> {
    send(data: T, options?: RallarRealtimeJsonLaneSendOptions<T>): Promise<readonly RallarRealtimeSendResult[]>;
    on(handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
}

export type RallarRoomRealtimeSendStatus =
    | 'sent'
    | 'partial'
    | 'not-ready'
    | 'no-targets'
    | 'failed';

export interface RallarRoomRealtimeJsonDefaults extends Omit<RallarRealtimeSendOptions, 'peerIds'> {
    readonly waitForReady?: boolean;
    readonly waitTimeoutMs?: number;
    readonly minReadyPeers?: number;
    readonly connect?: boolean;
}

export interface RallarRoomRealtimeJsonSendOptions<T> extends Omit<RallarRealtimeJsonLaneSendOptions<T>, 'peerIds'> {
    readonly waitForReady?: boolean;
    readonly waitTimeoutMs?: number;
    readonly minReadyPeers?: number;
    readonly connect?: boolean;
    readonly signal?: AbortSignal;
}

export interface RallarRoomRealtimeTransportOptions extends RallarRtcRoomTransportOptions {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
}

export interface RallarRoomRealtimeSendResult {
    readonly transport: 'rtc';
    readonly status: RallarRoomRealtimeSendStatus;
    readonly laneId: string;
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly peerIds: readonly string[];
    readonly desiredPeerIds: readonly string[];
    readonly readiness?: RallarRtcRoomLaneWaitResult;
    readonly transportStatus?: RallarRoomTransportStatus;
    readonly results: readonly RallarRealtimeSendResult[];
    readonly reason?: string;
}

export interface RallarRoomRealtimeJsonChannel<T> {
    send(data: T, options?: RallarRoomRealtimeJsonSendOptions<T>): Promise<RallarRoomRealtimeSendResult>;
    on(handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
    status(options?: RallarRoomRealtimeTransportOptions): RallarRoomTransportStatus;
    wait(options?: RallarRoomRealtimeTransportOptions): Promise<RallarRoomTransportStatus>;
}

export type RallarTargetMembership = 'fixed' | 'live';

export interface RallarTargetSelector {
    readonly peerId?: string;
    readonly peerIds?: readonly string[];
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly membership?: RallarTargetMembership;
}

export interface RallarTargetedChannelDefinition extends RallarTargetSelector {
    readonly laneId?: string;
    readonly openTimeoutMs?: number;
}

export type RallarTargetedChannelSendOptions<T> =
    & RallarRealtimeJsonLaneSendOptions<T>
    & RallarTargetSelector;

export type RallarTargetedSendStatus =
    | 'sent'
    | 'partial'
    | 'no-targets'
    | 'failed';

export interface RallarTargetedSendResult {
    readonly transport: 'rtc';
    readonly status: RallarTargetedSendStatus;
    readonly laneId: string;
    readonly peerIds: readonly string[];
    readonly results: readonly RallarRealtimeSendResult[];
    readonly reason?: string;
}

export interface RallarTargetedChannel<T> {
    send(data: T, options?: RallarTargetedChannelSendOptions<T>): Promise<RallarTargetedSendResult>;
    on(handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
    peerIds(options?: RallarTargetSelector): readonly string[];
}

export interface RallarRealtimeMessage<T> {
    readonly peerId: string;
    readonly laneId: string;
    readonly data: T;
    readonly event: MessageEvent;
    readonly receivedAtEpochMs: number;
}

export type RallarRealtimeHandler<T> = (
    message: RallarRealtimeMessage<T>
) => void | Promise<void>;

export interface RallarRealtimeHealthOptions {
    readonly peerIds?: readonly string[];
    readonly laneIds?: readonly string[];
}

export interface RallarRealtimeLaneHealth {
    readonly peerId: string;
    readonly laneId: string;
    readonly channel?: RtcDataChannelHealth;
}

export type RallarWsReadyState =
    | 'missing'
    | 'connecting'
    | 'open'
    | 'closing'
    | 'closed'
    | 'unknown';

export interface RallarWsStatus {
    readonly sessionId?: string;
    readonly url?: string;
    readonly connectState: RallarConnectStatus;
    readonly readyState: RallarWsReadyState;
    readonly readyStateCode?: number;
    readonly isOpen: boolean;
    readonly reconnecting: boolean;
    readonly reconnectEnabled: boolean;
    readonly reconnectAttempts: number;
    readonly maxReconnectAttempts: number;
    readonly reconnectExhausted: boolean;
}

export interface RallarWsWaitForOpenResult {
    readonly transport: 'ws';
    readonly status: RallarWaitForOpenStatus;
    readonly wsStatus: RallarWsStatus;
}

export interface RallarWsFacade {
    status(): RallarWsStatus;
    onStatus(listener: RallarWsStatusListener, options?: RallarOnChangeOptions): RallarUnsubscribe;
    onLifecycle(listener: RallarWsLifecycleListener, options?: RallarOnChangeOptions): RallarUnsubscribe;
    waitForOpen(options?: RallarWaitForOpenOptions): Promise<RallarWsWaitForOpenResult>;
}

export type RallarWsStatusListener = (
    status: RallarWsStatus
) => void | Promise<void>;

export type RallarWsLifecycleKind =
    | 'snapshot'
    | 'connected'
    | 'disconnected'
    | 'open'
    | 'close'
    | 'error';

export interface RallarWsLifecycleEvent {
    readonly kind: RallarWsLifecycleKind;
    readonly atEpochMs: number;
    readonly status: RallarWsStatus;
    readonly code?: number;
    readonly reason?: string;
    readonly wasClean?: boolean;
    readonly eventType?: string;
    readonly intentional?: boolean;
}

export type RallarWsLifecycleListener = (
    event: RallarWsLifecycleEvent
) => void | Promise<void>;

export interface RallarRealtimeFacade {
    sendJson<T>(input: RallarRealtimeJsonSendInput<T>): Promise<readonly RallarRealtimeSendResult[]>;
    sendBinary(input: RallarRealtimeBinarySendInput): Promise<readonly RallarRealtimeSendResult[]>;
    onJson<T = unknown>(laneId: string, handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
    onBinary(laneId: string, handler: RallarRealtimeHandler<ArrayBuffer>): RallarUnsubscribe;
    json<T>(defaults?: RallarRealtimeSendOptions): RallarRealtimeJsonLane<T>;
    room<T>(defaults?: RallarRoomRealtimeJsonDefaults): RallarRoomRealtimeJsonChannel<T>;
    health(options?: RallarRealtimeHealthOptions): readonly RallarRealtimeLaneHealth[];
}
