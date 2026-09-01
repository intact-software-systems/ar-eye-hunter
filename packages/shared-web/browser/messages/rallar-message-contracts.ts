import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ALAckMode, ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueStatus } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export type RallarTypedMessageSendStrategy = 'ws' | 'rtc' | 'realtime' | 'ws-then-rtc' | 'rtc-with-ws-fallback';

export type RallarMessageTransport = 'rtc' | 'ws' | 'replay';

export type RallarMessagePayload = object | string | number | boolean | null;

export interface RallarMessage<T = never> {
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

export type RallarMessageHandler<T = never> = (
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

export interface RallarRtcSendInput<T> extends RallarMessageSendBase<T> {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly membershipEpoch?: number;
    readonly minSnapshotVersion?: number;
    readonly seq?: number;
    readonly orderingKey?: string;
    readonly nextHopPeerIds?: readonly string[];
    readonly overlayId?: string;
    readonly fanoutLimit?: number;
}

export interface RallarWsSendInput<T> extends RallarMessageSendBase<T> {
    readonly scope?: 'room' | 'world' | 'all';
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly minSnapshotVersion?: number;
    readonly exceptPeerIds?: readonly string[];
}

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
    onMessage<T = never>(selector: TSelector, handler: RallarMessageHandler<T>): RallarUnsubscribe;
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

export interface RallarTypedMessageSendOptions<T>
    extends Partial<RallarTypedRtcSendOptions<T>>, Partial<RallarTypedWsSendOptions<T>> {
    readonly strategy?: RallarTypedMessageSendStrategy;
}

export interface RallarTypedMessageChannel<T> {
    send(payload: T, options?: RallarTypedMessageSendOptions<T>): Promise<RallarMessageSendResult>;
    sendRtc(payload: T, options?: RallarTypedRtcSendOptions<T>): Promise<RallarMessageSendResult>;
    sendWs(payload: T, options?: RallarTypedWsSendOptions<T>): Promise<RallarMessageSendResult>;
    onRtc(handler: RallarTypedPayloadHandler<T>): RallarUnsubscribe;
    onWs(handler: RallarTypedPayloadHandler<T>): RallarUnsubscribe;
}

export interface RallarRoomMessageChannelDefinition extends RallarTypedMessageChannelDefinition {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
}
