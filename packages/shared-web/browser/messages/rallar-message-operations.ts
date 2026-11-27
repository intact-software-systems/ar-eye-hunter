import type { EdgeOrderArrivals } from '@shared-web/browser/messages/edge-order/edge-order-arrivals.ts';
import type { EdgeOrderSendStreams } from '@shared-web/browser/messages/edge-order/edge-order-send-streams.ts';
import type {
    RallarMessageHandle,
    RallarMessageHandler,
    RallarRoomMessageChannelDefinition,
    RallarRtcSendInput,
    RallarTypedMessageChannel,
    RallarTypedMessageChannelDefinition,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessageSelectorInput } from '@shared-web/browser/messages/rallar-message-selectors.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ALInboundOrderingCounters } from '@shared/alm/inbound/admission/al-inbound-ordering-counters.ts';
import type { ALOutboundCongestionEpisodes } from '@shared/alm/outbound/congestion/al-outbound-congestion-episodes.ts';
import type { ALOutboundPublicationStageReport } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import type { ALVolatileSessionReport } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

export interface RallarRtcMessageLane {
    send<T>(input: RallarRtcSendInput<T>): Promise<RallarMessageHandle>;
    onMessage<T = never>(
        selector: RallarMessageSelectorInput,
        handler: RallarMessageHandler<T>
    ): RallarUnsubscribe;
}

export interface RallarWsMessageLane {
    send<T>(input: RallarWsSendInput<T>): Promise<RallarMessageHandle>;
    onMessage<T = never>(
        selector: RallarMessageSelectorInput,
        handler: RallarMessageHandler<T>
    ): RallarUnsubscribe;
}

/**
 * What the page's edge-ordered channels keep and what they did not hand over. `streams`, `heldMessages`,
 * `evictedStreams`, `sendStreams` and `openSends` are what is kept at the read; the others count since the page
 * loaded, across its connects.
 */
export interface RallarEdgeOrderUsage extends EdgeOrderArrivals.Usage, EdgeOrderSendStreams.Usage {}

/**
 * The volatile ledger beside the matched replies this page's retained deliveries hold, its reply waits in flight,
 * the connect's publication stage: what its live channels hold against the stage's limits and what it settled,
 * the ordering positions the connect's arrivals stated, by status, its congestion episodes: how long each message
 * a carrier deferred waited, across both carriers, cumulative over the connect, and what the page's edge-ordered
 * channels keep and gave up.
 */
export interface RallarMessagesUsage extends ALVolatileSessionReport {
    readonly repliesHeld: number;
    readonly replyWaitsOpen: number;
    readonly publication: ALOutboundPublicationStageReport;
    /** Cumulative over the connect, across both carriers; counts events, not distinct copies. */
    readonly ordering: ALInboundOrderingCounters;
    readonly congestionEpisodes: ALOutboundCongestionEpisodes.Figures;
    readonly edgeOrder: RallarEdgeOrderUsage;
}

export interface RallarMessagesOperations {
    readonly rtc: RallarRtcMessageLane;
    readonly ws: RallarWsMessageLane;
    channel<T>(
        definition: RallarTypedMessageChannelDefinition
    ): RallarTypedMessageChannel<T>;
    room<T>(
        definition: RallarRoomMessageChannelDefinition
    ): RallarTypedMessageChannel<T>;
    /** The connected session's `RallarMessagesUsage`. */
    readUsage(): RallarMessagesUsage;
}
