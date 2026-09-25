import type { RallarWaitForOpenOptions } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ALAckMode, ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import type { ALDeliveryLifecycle, ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

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
    /** Absent, the product normalizes the QoS the delivery options imply. */
    readonly qos?: ALQosPolicyRequest;
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

export type RallarMessageDeliveryListener = (
    lifecycle: ALDeliveryLifecycle
) => void | Promise<void>;

export interface RallarMessageWaitOptions extends RallarWaitForOpenOptions {
    /** Resolve at the first of these states as well as at any terminal state. */
    readonly until?: readonly ALDeliveryState[];
}

export interface RallarMessageDeliveryOutcome {
    readonly status: 'settled' | 'timeout' | 'aborted';
    readonly lifecycle: ALDeliveryLifecycle;
}

export interface RallarMessageHandle {
    readonly msgId: string;
    readonly typeId: string;
    /** The current lifecycle; the deadline is applied lazily, so a read after `expiresAtMs` says `expired`. */
    lifecycle(): ALDeliveryLifecycle;
    onEvent(listener: RallarMessageDeliveryListener): RallarUnsubscribe;
    wait(options?: RallarMessageWaitOptions): Promise<RallarMessageDeliveryOutcome>;
    cancel(): void;
}

export interface RallarMessageLane<TSendInput, TSelector = string> {
    send<T>(input: TSendInput & RallarMessageSendBase<T>): Promise<RallarMessageHandle>;
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
    send(payload: T, options?: RallarTypedMessageSendOptions<T>): Promise<RallarMessageHandle>;
    sendRtc(payload: T, options?: RallarTypedRtcSendOptions<T>): Promise<RallarMessageHandle>;
    sendWs(payload: T, options?: RallarTypedWsSendOptions<T>): Promise<RallarMessageHandle>;
    onRtc(handler: RallarTypedPayloadHandler<T>): RallarUnsubscribe;
    onWs(handler: RallarTypedPayloadHandler<T>): RallarUnsubscribe;
}

export interface RallarRoomMessageChannelDefinition extends RallarTypedMessageChannelDefinition {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
}
