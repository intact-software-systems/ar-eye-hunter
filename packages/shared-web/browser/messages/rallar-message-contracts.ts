import type { RallarWaitForOpenOptions } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ALAckMode, ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDurabilityAlgo, ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import type { ALChannelPurpose } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type { ALDeliveryLifecycle, ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALInboundResyncCursor } from '@shared/alm/inbound/al-inbound-resync-required.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export type RallarTypedMessageSendStrategy = 'ws' | 'rtc' | 'ws-then-rtc' | 'rtc-with-ws-fallback';

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
    /**
     * Each stated aspect overrides the request the delivery options imply for it (`qos.ack` over `ack`, for
     * example); absent, the product normalizes the QoS the delivery options imply.
     */
    readonly qos?: ALQosPolicyRequest;
}

/**
 * Who a send reaches: `room`, the room's live sessions; `principal`, one principal's live sessions in the room
 * (`principalId`); `world`, every live session of the sender's authenticated scope. RTC carries room audiences
 * only: a `world` send takes WS when its strategy allows WS and is refused `unsupported` on RTC alone.
 */
export type RallarMessageScope = 'room' | 'world' | 'principal';

/** The audience a room send narrows to: one principal's sessions, or a fixed list of sessions in the room. */
interface RallarRoomAudienceInput {
    readonly scope?: RallarMessageScope;
    /** With `scope: 'principal'` and a room: the principal whose live sessions in the room the send reaches. */
    readonly principalId?: string;
    /** With room scope: at most 256 distinct session ids; a listed session outside the room is not reached. */
    readonly recipientPeerIds?: readonly string[];
}

export interface RallarRtcSendInput<T> extends RallarMessageSendBase<T>, RallarRoomAudienceInput {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly minSnapshotVersion?: number;
    readonly seq?: number;
    readonly orderingKey?: string;
    readonly nextHopPeerIds?: readonly string[];
    readonly overlayId?: string;
    readonly fanoutLimit?: number;
}

export interface RallarWsSendInput<T> extends RallarMessageSendBase<T>, RallarRoomAudienceInput {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly minSnapshotVersion?: number;
    readonly exceptPeerIds?: readonly string[];
    /** The one session or server a send addresses; absent, the send reaches its scope. */
    readonly peerId?: string;
    /** Stated together with `orderingKey` or not at all; absent, the broadcast is unordered. */
    readonly seq?: number;
    readonly orderingKey?: string;
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

export type RallarStorageUnavailablePolicy = 'refuse' | 'volatile';

/** A typed channel's owner of resynchronization: what the application does when the receiver can no longer order a sender's messages. */
export interface RallarChannelRecovery {
    /**
     * Invoked once per ordering track (ordering key, sender, epoch) per runtime, after the sender was
     * NACKed. The sender's new epoch is a new track and invokes it again.
     */
    onResyncRequired(cursor: ALInboundResyncCursor): void;
}

export interface RallarTypedMessageChannelDefinition {
    readonly topicId?: string;
    readonly typeId: string;
    /** Fixes the send defaults (D2): at-least-once, receipted, volatile, 30 s; a send option overrides each. */
    readonly purpose: ALChannelPurpose;
    /**
     * Absent, the purpose's `volatile`; `local-checkpoint`, `local-outbox` and `local-inbox` opt the
     * channel into browser storage.
     */
    readonly durability?: ALDurabilityAlgo;
    /**
     * Absent, `refuse`: a durable send storage cannot hold reads `failed`. `volatile` sends it once without
     * storage instead; a downgraded `local-inbox` send also loses the receiver's inbox persistence.
     */
    readonly onStorageUnavailable?: RallarStorageUnavailablePolicy;
    /** Absent, a message the receiver can no longer order is dropped, and the inbound diagnostics state it. */
    readonly recovery?: RallarChannelRecovery;
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
