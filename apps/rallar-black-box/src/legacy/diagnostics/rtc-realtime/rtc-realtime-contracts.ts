import type { CommandCenterActionFeedback } from '../shared/action-feedback.ts';

export type RtcRealtimeTransport = 'realtime' | 'messages.rtc';

export interface RtcRealtimeReceivedRow {
    readonly rowId: string;
    readonly atEpochMs: number;
    readonly transport: RtcRealtimeTransport;
    readonly peerId: string;
    readonly laneId: string;
    readonly roomId: string;
    readonly typeId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly payload: unknown;
    readonly raw: unknown;
}

export interface RtcRealtimeSubscriptionRow {
    readonly subscriptionId: string;
    readonly transport: RtcRealtimeTransport;
    readonly label: string;
    readonly laneId: string;
    readonly groupId: string;
    readonly subscribedAtEpochMs: number;
    unsubscribe(): void;
}

export interface RtcRealtimeFormValues {
    readonly transport: RtcRealtimeTransport;
    readonly laneId: string;
    readonly peerIdsText: string;
    readonly typeId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly payloadText: string;
    readonly minSnapshotVersion: string;
    readonly reliability: 'best-effort' | 'at-least-once';
    readonly ack: 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';
    readonly ownership: 'shared' | 'exclusive';
    readonly timeoutMs: number;
}

export interface RtcRealtimeFormSetters {
    setTransport(value: RtcRealtimeFormValues['transport']): void;
    setLaneId(value: string): void;
    setPeerIdsText(value: string): void;
    setTypeId(value: string): void;
    setTopicId(value: string): void;
    setContextId(value: string): void;
    setPayloadText(value: string): void;
    setMinSnapshotVersion(value: string): void;
    setReliability(value: RtcRealtimeFormValues['reliability']): void;
    setAck(value: RtcRealtimeFormValues['ack']): void;
    setOwnership(value: RtcRealtimeFormValues['ownership']): void;
    setTimeoutMs(value: number): void;
}

export interface RtcRealtimeActivity {
    readonly busyAction: string | undefined;
    readonly localError: string | undefined;
    readonly actionFeedback: CommandCenterActionFeedback;
    readonly result: unknown;
    readonly received: readonly RtcRealtimeReceivedRow[];
    readonly health: unknown;
    readonly subscriptions: readonly RtcRealtimeSubscriptionRow[];
    readonly providerMode: 'simulated' | 'browser-rallar';
    readonly realBackendReady: boolean;
    readonly activeGroupId: string;
    readonly peerIds: readonly string[];
    readonly canRun: boolean;
}

export interface RtcRealtimeOperations {
    subscribeRealtime(): Promise<void>;
    subscribeRtcMessages(): Promise<void>;
    clearSubscriptions(): void;
    sendRealtime(): Promise<void>;
    sendRtcMessage(): Promise<void>;
    waitForRoomLane(): Promise<void>;
    refreshHealth(): Promise<void>;
    copyRecipe(): void;
}

export interface RtcRealtimeViewModel
    extends RtcRealtimeFormValues, RtcRealtimeFormSetters, RtcRealtimeActivity, RtcRealtimeOperations {}
