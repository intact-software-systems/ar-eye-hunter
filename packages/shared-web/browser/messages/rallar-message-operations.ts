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
 * The volatile ledger beside the matched replies this page's retained deliveries hold, its reply waits in flight, and
 * the connect's publication stage: what its live channels hold against the stage's limits and what it settled.
 */
export interface RallarMessagesUsage extends ALVolatileSessionReport {
    readonly repliesHeld: number;
    readonly replyWaitsOpen: number;
    readonly publication: ALOutboundPublicationStageReport;
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
