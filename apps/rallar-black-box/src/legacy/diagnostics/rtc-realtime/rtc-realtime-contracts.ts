import type { CommandCenterActionFeedback } from '../shared/action-feedback.ts';

export type RtcRealtimeTransport = 'realtime' | 'messages.rtc';

export type RtcRealtimeReceivedRow = Readonly<{
    rowId: string;
    atEpochMs: number;
    transport: RtcRealtimeTransport;
    peerId: string;
    laneId: string;
    roomId: string;
    typeId: string;
    topicId: string;
    contextId: string;
    payload?: unknown;
    raw?: unknown;
}>;

export type RtcRealtimeSubscriptionRow = Readonly<{
    subscriptionId: string;
    transport: RtcRealtimeTransport;
    label: string;
    laneId: string;
    groupId: string;
    subscribedAtEpochMs: number;
    unsubscribe(): void;
}>;

export type RtcRealtimeViewModel = Readonly<{
    transport: RtcRealtimeTransport;
    setTransport(value: RtcRealtimeTransport): void;
    laneId: string;
    setLaneId(value: string): void;
    peerIdsText: string;
    setPeerIdsText(value: string): void;
    typeId: string;
    setTypeId(value: string): void;
    topicId: string;
    setTopicId(value: string): void;
    contextId: string;
    setContextId(value: string): void;
    payloadText: string;
    setPayloadText(value: string): void;
    minSnapshotVersion: string;
    setMinSnapshotVersion(value: string): void;
    reliability: 'best-effort' | 'at-least-once';
    setReliability(value: 'best-effort' | 'at-least-once'): void;
    ack: 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';
    setAck(
        value:
            'none' | 'receiver' | 'all-logical-recipients' | 'group-leader'
    ): void;
    ownership: 'shared' | 'exclusive';
    setOwnership(value: 'shared' | 'exclusive'): void;
    timeoutMs: number;
    setTimeoutMs(value: number): void;
    busyAction?: string;
    localError?: string;
    actionFeedback: CommandCenterActionFeedback;
    result: unknown;
    received: readonly Readonly<{
        rowId: string;
        atEpochMs: number;
        transport: RtcRealtimeTransport;
        peerId: string;
        laneId: string;
        roomId: string;
        typeId: string;
        topicId: string;
        contextId: string;
        payload?: unknown;
    }>[];
    health: unknown;
    subscriptions: readonly Readonly<{
        transport: RtcRealtimeTransport;
        label: string;
        laneId: string;
        groupId: string;
        subscribedAtEpochMs: number;
    }>[];
    providerMode: 'simulated' | 'browser-rallar';
    realBackendReady: boolean;
    activeGroupId: string;
    peerIds: readonly string[];
    canRun: boolean;
    subscribeRealtime(): Promise<void>;
    subscribeRtcMessages(): Promise<void>;
    clearSubscriptions(): void;
    sendRealtime(): Promise<void>;
    sendRtcMessage(): Promise<void>;
    waitForRoomLane(): Promise<void>;
    refreshHealth(): Promise<void>;
    copyRecipe(): void;
}>;
