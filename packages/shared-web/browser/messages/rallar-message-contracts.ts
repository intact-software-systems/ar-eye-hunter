import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarWaitForOpenOptions } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ALAckMode, ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDurabilityAlgo, ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import type { ALChannelPurpose } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type { ALDeliveryLifecycle, ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALInboundResyncCursor } from '@shared/alm/inbound/al-inbound-resync-required.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

export type RallarTypedMessageSendStrategy = 'ws' | 'rtc' | 'ws-then-rtc' | 'rtc-with-ws-fallback';

export type RallarMessageTransport = 'rtc' | 'ws' | 'replay';

export type RallarMessagePayload = object | string | number | boolean | null;

/** Where a message stands in its sender page's edge-ordered stream; positions count from 1. */
export interface RallarMessageOrder {
    /** Minted in memory by the sender's page for the channel and room, so a reload or another tab is a new stream. */
    readonly stream: string;
    readonly position: number;
}

/**
 * Why a page gave up positions of an edge-ordered stream. No one waits for the message any more: `ended-at-sender`,
 * its sender said so, because the send was over (refused, cancelled, past its deadline, or acknowledged by the
 * recipients it had) or because nothing retries it and a later message arrived first; `cannot-arrive`, the time its
 * sender gave it to arrive has passed. A bound of this page was reached, and the
 * message is dropped as late if it still arrives: `held-message-deadline`, a later message could be held no longer
 * without passing its own deadline; `channel-wait-cap`, `held-message-cap` and `held-byte-cap`, a later message was
 * held as long, or the stream held as much, as the page allows; `stream-cap`, the page follows no more streams.
 * `held-message-expired`: the position arrived and was held past its own deadline, so it was not handed over.
 */
export type RallarMessageOrderGapReason =
    | 'ended-at-sender'
    | 'cannot-arrive'
    | 'held-message-deadline'
    | 'held-message-expired'
    | 'channel-wait-cap'
    | 'held-message-cap'
    | 'held-byte-cap'
    | 'stream-cap';

/**
 * The positions `fromPosition` to `toPosition`, both included, of one sender page's edge-ordered stream that this page
 * did not hand over. A stream belongs to one room, and the gap names it.
 */
export interface RallarMessageOrderGap {
    /** The channel's topic; its type where the channel declared no topic. */
    readonly topicId: string;
    readonly typeId: string;
    /** The sender's session, as `RallarMessage.senderId` gives it. */
    readonly senderId: string;
    /** The room the stream's messages name. */
    readonly roomRef: GroupRef;
    readonly stream: string;
    readonly fromPosition: number;
    readonly toPosition: number;
    readonly reason: RallarMessageOrderGapReason;
}

export interface RallarMessage<T = never> {
    readonly transport: RallarMessageTransport;
    readonly typeId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly resourceId: string;
    readonly roomId?: string;
    readonly senderId: string;
    /** The sender's trace, `raw.id.traceId`. */
    readonly traceId: string;
    readonly payload: T;
    /** The envelope as it travelled: on an edge-ordered channel its `payload.resource` is the wrapped payload. */
    readonly raw: ALMessage;
    readonly receivedAtEpochMs: number;
    /** Present exactly on a message of a channel this page declared `order: 'edge'`. */
    readonly order?: RallarMessageOrder;
    /** A WS unicast to the sender's session under this message's correlation; its handle observes the reply's delivery. */
    reply<R>(payload: R, options?: RallarMessageReplyOptions): Promise<RallarMessageHandle>;
}

/** A room or people state event: built before messaging exists, or replayed locally, so it has no reply. */
export type RallarStateEventMessage<T = never> = Omit<RallarMessage<T>, 'reply'>;

export interface RallarMessageReplyOptions {
    /** Absent, the reply takes the request's type. */
    readonly typeId?: string;
    /** Absent, the `command` purpose's 30 s. */
    readonly ttlMs?: number;
}

export type RallarMessageHandler<T = never> = (
    message: RallarMessage<T>
) => void | Promise<void>;

export type RallarStateEventListener<TEvent> = (
    event: TEvent,
    message: RallarStateEventMessage<TEvent>
) => void | Promise<void>;

export interface RallarMessageSendBase<T> extends Pick<RallarOperationOptions, 'rtcCaptureMode' | 'rtcCaptureContext'> {
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
    /** A re-ask under an earlier request's correlation; absent, the message starts its own (its msgId). */
    readonly corrId?: string;
    /** Links the send to an earlier operation's trace; absent, the send mints its own. */
    readonly traceId?: string;
}

/**
 * Who a send reaches: `room`, the room's live sessions; `principal`, one principal's live sessions in the room
 * (`principalId`); `world`, every live session of the sender's authenticated scope. RTC carries room audiences
 * only: a `world` send takes WS when its strategy allows WS and is refused `unsupported` on RTC alone.
 */
export type RallarMessageScope = 'room' | 'world' | 'principal';

/** The audience a send names, and how a room send narrows it: one principal, a fixed list, or skipped sessions. */
export interface RallarRoomAudienceInput {
    readonly scope?: RallarMessageScope;
    /** Sessions the send skips. */
    readonly exceptPeerIds?: readonly string[];
    /** With `scope: 'principal'` and a room: the principal whose live sessions in the room the send reaches. */
    readonly principalId?: string;
    /** With room scope: at most 256 distinct session ids; a listed session outside the room is not reached. */
    readonly recipientPeerIds?: readonly string[];
}

export interface RallarRtcSendInput<T> extends RallarMessageSendBase<T>, RallarRoomAudienceInput {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly minSnapshotVersion?: number;
    /** The send's position on its track, from 1 and above the track's head; absent beside a key, it is minted. */
    readonly seq?: number;
    /** The send's track; beside a `seq` it defaults to the room's track, and alone it asks for a sequence. */
    readonly orderingKey?: string;
    readonly nextHopPeerIds?: readonly string[];
    readonly overlayId?: string;
    readonly fanoutLimit?: number;
}

export interface RallarWsSendInput<T> extends RallarMessageSendBase<T>, RallarRoomAudienceInput {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly minSnapshotVersion?: number;
    /** The one session or server a send addresses; absent, the send reaches its scope. */
    readonly peerId?: string;
    /** Stated only beside `orderingKey`; on a room send from 1 and above the track's head, and absent there minted. */
    readonly seq?: number;
    /** The track the broadcast is ordered on; absent, the broadcast is unordered. */
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

/** The timeout is required: an acknowledged request is terminal, so nothing else would end the wait. */
export interface RallarMessageReplyWaitOptions {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}

/**
 * `lifecycle` is the request's when the wait resolves; the reply payload is unvalidated. `unanswerable` is a request
 * on a topic WS cannot carry: a reply travels WS on the request's topic, so `issues` are the ones the responder's
 * `reply()` is refused with, whatever the request's own delivery came to.
 */
export type RallarMessageReplyOutcome<T> =
    | Readonly<{ status: 'replied'; reply: RallarMessage<T>; lifecycle: ALDeliveryLifecycle; }>
    | Readonly<{ status: 'timeout' | 'aborted' | 'undelivered'; lifecycle: ALDeliveryLifecycle; }>
    | Readonly<{ status: 'unanswerable'; issues: readonly RallarValidationIssue[]; lifecycle: ALDeliveryLifecycle; }>;

export interface RallarMessageHandle {
    readonly msgId: string;
    readonly typeId: string;
    readonly corrId: string;
    readonly traceId: string;
    /** The request this message replies to; absent when the message is not a reply. */
    readonly replyToMsgId: string | undefined;
    /** Immutable receipt of the connection acquired for this send; unassociated internal handles report absent. */
    rtcCapture(): RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>;
    /** The current lifecycle; the deadline is applied lazily, so a read after `expiresAtMs` says `expired`. */
    lifecycle(): ALDeliveryLifecycle;
    onEvent(listener: RallarMessageDeliveryListener): RallarUnsubscribe;
    wait(options?: RallarMessageWaitOptions): Promise<RallarMessageDeliveryOutcome>;
    /**
     * Never throws. A request on a topic WS cannot carry resolves `unanswerable` at the call, before any wait. A
     * timeout leaves the request as it is; `aborted` and `undelivered` end only this wait, and the first timeout ends
     * every wait of the request. A request deadline that lapses during the wait ends it `undelivered`; a reply that
     * arrives after the deadline is still matched and kept, so a later `awaitReply` resolves `replied`.
     */
    awaitReply<T>(options: RallarMessageReplyWaitOptions): Promise<RallarMessageReplyOutcome<T>>;
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
     * Invoked once per ordering track (ordering key, sender, epoch) after the sender was NACKed, while the track goes
     * on resynchronizing: each resynchronization renews it, and a track forgotten 5 minutes after its last one invokes
     * it again. The sender's new epoch is a new track and invokes it again.
     */
    onResyncRequired(cursor: ALInboundResyncCursor): void;
}

export interface RallarTypedMessageChannelDefinition {
    readonly topicId?: string;
    readonly typeId: string;
    /**
     * Fixes the send defaults (D2): at-least-once, receipted, volatile, 30 s; a send option overrides each. A `live`
     * channel's sends are best-effort, unreceipted, volatile and 1 s, each names its `resourceId`, and none asks
     * for reliability, a receipt, ordering, a claim or storage (D466, D467).
     */
    readonly purpose: ALChannelPurpose;
    /**
     * Who may publish on the channel's topic: every active member of the room (`members`), or only the principals a
     * publication grant names (`granted`), whose topic it names. A granted topic rides RTC as the signed frozen
     * multicast, with a verified publisher proof and receipted or not, of a room multicast, a listed or principal room
     * broadcast or a room unicast, frozen to the sessions whose principal may subscribe and delivered to
     * `subscribe(handler)`; `onRtc` is refused `unsupported`. A granted send whose principal holds no `publish` in
     * the room's cached snapshot settles `rejected` as `no-publish-grant` before any carrier; with none cached, the
     * server decides.
     */
    readonly access: 'members' | 'granted';
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
    /**
     * Required on a `live` channel and refused on any other: the cadence, the newest values kept per stream and
     * the drain budget its sends are paced by before admission. There is no default for any field.
     */
    readonly publication?: ALPublicationPolicy;
    /**
     * `edge`, on a room channel: one sender page's messages reach this page's handlers in the order that page called
     * `send`, whichever carrier each came over. Rallar Web numbers each send, wraps the payload with the number and
     * sorts at the receiver in memory, so both ends declare it; a message that can no longer arrive is skipped. A
     * send nothing retries (best-effort, or one that asks no receipt) is never waited for: the newest message wins,
     * and one that arrives after a later one is dropped. So is a send a later latest-wins send of the same
     * `supersedenceKey` replaced. One stream is one channel, room and audience, so a narrowed send (a list, a
     * principal, a peer, skipped sessions) is ordered among the sends to the same audience; on a `live` channel one
     * stream is one `resourceId`, numbered as its values leave the publication stage. Refused `unsupported`: a
     * stored channel or send, a hop's or a leader's receipt, `orderingKey` and `seq`, latest-wins without a
     * `supersedenceKey`, a world send, a send addressed to the server, and the `ws-then-rtc` strategy.
     */
    readonly order?: 'edge';
    /**
     * On an `order: 'edge'` channel: called once for each run of positions this page gave up, in the stream's order,
     * between the handlers of the messages before and after it. The latest declaration for a topic and type stands,
     * for every room, as the latest channel for it does. What it throws is logged and does not stop the stream.
     * Absent, a gap is stated in the inbound diagnostics and counted in `messages.readUsage()` only.
     */
    readonly onOrderGap?: (gap: RallarMessageOrderGap) => void | Promise<void>;
    /**
     * On an `order: 'edge'` channel: the longest this page holds a message of the channel for an earlier one that is
     * missing, in whole milliseconds from when it was first held. Past it the page skips the missing positions,
     * reports them as a `channel-wait-cap` gap, and drops their messages as late if they still arrive. Absent, the
     * page waits as long as the sender says the missing message can arrive. Kept per topic and type like
     * `onOrderGap`: the latest declaration that names it stands, for every room, from a stream's next arrival on.
     */
    readonly orderGapWaitMs?: number;
    /**
     * On an `order: 'edge'` channel: how long this page waits for earlier messages of a stream whose first message
     * here is not its first, in whole milliseconds, before it starts at the lowest one it holds. Absent, 500. Kept
     * per topic and type like `onOrderGap`: the latest declaration that names it stands, for every room.
     */
    readonly orderEntryWindowMs?: number;
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
    /**
     * Elects this session to receive a granted room channel's topic and registers the handler; the server delivers
     * only to a session holding `subscribe` that elected to receive. A members channel and a channel without a
     * `roomRef` throw the `unsupported` issue.
     */
    subscribe(handler: RallarTypedPayloadHandler<T>): RallarTopicSubscription;
}

/**
 * `pending` until the server first answers; `active` while the election holds; `refused` when the server denies it
 * (no `subscribe` grant, not an active member, no such room); `lapsed` once it ended without a refusal (unsubscribed,
 * the session ended or was replaced, or no renewal succeeded within the lease).
 */
export type RallarTopicSubscriptionStatus = 'pending' | 'active' | 'refused' | 'lapsed';

export interface RallarTopicSubscription {
    status(): RallarTopicSubscriptionStatus;
    /** Settles when the status first leaves `pending`. */
    wait(): Promise<RallarTopicSubscriptionStatus>;
    /** Detaches the handler; the last token of its room and topic releases the election remotely. */
    unsubscribe(): Promise<void>;
}

export interface RallarRoomMessageChannelDefinition extends RallarTypedMessageChannelDefinition {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
}
