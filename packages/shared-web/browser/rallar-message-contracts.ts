import type { RallarMessageSelectorInput } from '@shared-web/browser/rallar-message-selectors.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ALAckMode, ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueStatus } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export type RallarTypedMessageSendStrategy = 'ws' | 'rtc' | 'realtime' | 'ws-then-rtc' | 'rtc-with-ws-fallback';

export type RallarMessageTransport = 'rtc' | 'ws' | 'replay';

export interface RallarMessage<T = unknown> {
    readonly transport: RallarMessageTransport;
    readonly typeId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly resourceId: string;
    readonly roomId?: string;
    readonly senderId: string;
    readonly payload: T;
    readonly raw: ALMessage;
    readonly receivedAtEpochMs: number;
}

export type RallarMessageHandler<T = unknown> = (
    message: RallarMessage<T>
) => void | Promise<void>;

export type RallarStateEventListener<TEvent> = (
    event: TEvent,
    message: RallarMessage<TEvent>
) => void | Promise<void>;

export interface RallarMessageSendBase<T> {
    readonly typeId: string;
    readonly payload: T;
    readonly topicId?: string;
    readonly contextId?: string;
    readonly resourceId?: string;
    readonly ttlHops?: number;
    readonly ttlMs?: number;
    readonly reliability?: 'best-effort' | 'at-least-once';
    readonly ack?: ALAckMode;
    readonly ownership?: 'shared' | 'exclusive';
}

export type RallarRtcSendInput<T> =
    & RallarMessageSendBase<T>
    & Readonly<{
        roomId?: string;
        roomRef?: GroupRef;
        membershipEpoch?: number;
        minSnapshotVersion?: number;
        seq?: number;
        orderingKey?: string;
        nextHopPeerIds?: readonly string[];
        overlayId?: string;
        fanoutLimit?: number;
    }>;

export type RallarWsSendInput<T> =
    & RallarMessageSendBase<T>
    & Readonly<{
        scope?: 'room' | 'world' | 'all';
        roomId?: string;
        roomRef?: GroupRef;
        minSnapshotVersion?: number;
        exceptPeerIds?: readonly string[];
    }>;

export interface RallarMessageSendResult {
    readonly transport: RallarMessageTransport;
    readonly status: ALOutboundEnqueueStatus;
    readonly message: ALMessage;
    readonly entry?: ResourceEntry;
    readonly entries: readonly ResourceEntry[];
    readonly reason?: string;
}

export interface RallarMessageLane<TSendInput, TSelector = string> {
    send<T>(input: TSendInput & RallarMessageSendBase<T>): Promise<RallarMessageSendResult>;
    onMessage<T = unknown>(selector: TSelector, handler: RallarMessageHandler<T>): RallarUnsubscribe;
}

export interface RallarTypedMessageChannelDefinition {
    readonly topicId?: string;
    readonly typeId: string;
}

export type RallarTypedPayloadHandler<T> = (
    payload: T,
    message: RallarMessage<T>
) => void | Promise<void>;

export type RallarTypedRtcSendOptions<T> = Omit<RallarRtcSendInput<T>, 'topicId' | 'typeId' | 'payload'>;

export type RallarTypedWsSendOptions<T> = Omit<RallarWsSendInput<T>, 'topicId' | 'typeId' | 'payload'>;

export type RallarTypedMessageSendOptions<T> =
    & Partial<RallarTypedRtcSendOptions<T>>
    & Partial<RallarTypedWsSendOptions<T>>
    & Readonly<{
        strategy?: RallarTypedMessageSendStrategy;
    }>;

export interface RallarTypedMessageChannel<T> {
    send(payload: T, options?: RallarTypedMessageSendOptions<T>): Promise<RallarMessageSendResult>;
    sendRtc(payload: T, options?: RallarTypedRtcSendOptions<T>): Promise<RallarMessageSendResult>;
    sendWs(payload: T, options?: RallarTypedWsSendOptions<T>): Promise<RallarMessageSendResult>;
    onRtc(handler: RallarTypedPayloadHandler<T>): RallarUnsubscribe;
    onWs(handler: RallarTypedPayloadHandler<T>): RallarUnsubscribe;
}

export type RallarRoomMessageChannelDefinition =
    & RallarTypedMessageChannelDefinition
    & Readonly<{
        roomId?: string;
        roomRef?: GroupRef;
    }>;
