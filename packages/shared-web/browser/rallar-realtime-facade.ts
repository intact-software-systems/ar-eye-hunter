import type { RallarConnectStatus } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarRoomTransportStatus,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomTransportOptions,
    RallarWaitForOpenStatus
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarOnChangeOptions, RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RtcDataChannelHealth,
    RtcDataChannelSendOptions,
    RtcDataChannelSendResult
} from '@shared/webrtc/QRtcDataChannel.ts';

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

export type RallarRealtimeJsonLaneSendOptions<T> = Omit<RallarRealtimeJsonSendInput<T>, 'data'>;

export type RallarRealtimeJsonLane<T> = Readonly<{
    send(
        data: T,
        options?: RallarRealtimeJsonLaneSendOptions<T>
    ): Promise<readonly RallarRealtimeSendResult[]>;
    on(handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
}>;

export type RallarRoomRealtimeSendStatus =
    | 'sent'
    | 'partial'
    | 'not-ready'
    | 'no-targets'
    | 'failed';

export type RallarRoomRealtimeJsonDefaults =
    & Omit<RallarRealtimeJsonLaneDefaults, 'peerIds'>
    & Readonly<{
        waitForReady?: boolean;
        waitTimeoutMs?: number;
        minReadyPeers?: number;
        connect?: boolean;
    }>;

export type RallarRoomRealtimeJsonSendOptions<T> =
    & Omit<RallarRealtimeJsonLaneSendOptions<T>, 'peerIds'>
    & Readonly<{
        waitForReady?: boolean;
        waitTimeoutMs?: number;
        minReadyPeers?: number;
        connect?: boolean;
        signal?: AbortSignal;
    }>;

export type RallarRoomRealtimeTransportOptions =
    & RallarRtcRoomTransportOptions
    & Readonly<{
        roomId?: string;
        roomRef?: GroupRef;
    }>;

export type RallarRoomRealtimeSendResult = Readonly<{
    transport: 'rtc';
    status: RallarRoomRealtimeSendStatus;
    laneId: string;
    roomId?: string;
    roomRef?: GroupRef;
    peerIds: readonly string[];
    desiredPeerIds: readonly string[];
    readiness?: RallarRtcRoomLaneWaitResult;
    transportStatus?: RallarRoomTransportStatus;
    results: readonly RallarRealtimeSendResult[];
    reason?: string;
}>;

export type RallarRoomRealtimeJsonChannel<T> = Readonly<{
    send(
        data: T,
        options?: RallarRoomRealtimeJsonSendOptions<T>
    ): Promise<RallarRoomRealtimeSendResult>;
    on(handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
    status(options?: RallarRoomRealtimeTransportOptions): RallarRoomTransportStatus;
    wait(options?: RallarRoomRealtimeTransportOptions): Promise<RallarRoomTransportStatus>;
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
        options?: RallarTargetedChannelSendOptions<T>
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
    message: RallarRealtimeMessage<T>
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
    status: RallarWsStatus
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
    event: RallarWsLifecycleEvent
) => void | Promise<void>;

export type RallarRealtimeFacade = Readonly<{
    sendJson<T>(
        input: RallarRealtimeJsonSendInput<T>
    ): Promise<readonly RallarRealtimeSendResult[]>;
    sendBinary(
        input: RallarRealtimeBinarySendInput
    ): Promise<readonly RallarRealtimeSendResult[]>;
    onJson<T = unknown>(
        laneId: string,
        handler: RallarRealtimeHandler<T>
    ): RallarUnsubscribe;
    onBinary(
        laneId: string,
        handler: RallarRealtimeHandler<ArrayBuffer>
    ): RallarUnsubscribe;
    json<T>(
        defaults?: RallarRealtimeJsonLaneDefaults
    ): RallarRealtimeJsonLane<T>;
    room<T>(
        defaults?: RallarRoomRealtimeJsonDefaults
    ): RallarRoomRealtimeJsonChannel<T>;
    health(
        options?: RallarRealtimeHealthOptions
    ): readonly RallarRealtimeLaneHealth[];
}>;

export type CreateRallarRealtimeFacadeOptions = RallarRealtimeFacade;

export function createRallarRealtimeFacade(
    operations: CreateRallarRealtimeFacadeOptions
): RallarRealtimeFacade {
    return {
        sendJson: async <T>(
            input: RallarRealtimeJsonSendInput<T>
        ): Promise<readonly RallarRealtimeSendResult[]> => await operations.sendJson(input),
        sendBinary: async (
            input: RallarRealtimeBinarySendInput
        ): Promise<readonly RallarRealtimeSendResult[]> => await operations.sendBinary(input),
        onJson: <T = unknown>(
            laneId: string,
            handler: RallarRealtimeHandler<T>
        ): RallarUnsubscribe => operations.onJson<T>(laneId, handler),
        onBinary: (
            laneId: string,
            handler: RallarRealtimeHandler<ArrayBuffer>
        ): RallarUnsubscribe => operations.onBinary(laneId, handler),
        json: <T>(
            defaults: RallarRealtimeJsonLaneDefaults = {}
        ): RallarRealtimeJsonLane<T> => operations.json<T>(defaults),
        room: <T>(
            defaults: RallarRoomRealtimeJsonDefaults = {}
        ): RallarRoomRealtimeJsonChannel<T> => operations.room<T>(defaults),
        health: (
            options: RallarRealtimeHealthOptions = {}
        ): readonly RallarRealtimeLaneHealth[] => operations.health(options)
    };
}
