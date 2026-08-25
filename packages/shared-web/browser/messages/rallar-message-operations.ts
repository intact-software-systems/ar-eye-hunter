import type {
    RallarMessageHandler,
    RallarMessageSendResult,
    RallarRoomMessageChannelDefinition,
    RallarRtcSendInput,
    RallarTypedMessageChannel,
    RallarTypedMessageChannelDefinition,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessageSelectorInput } from '@shared-web/browser/messages/rallar-message-selectors.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';

export interface RallarRtcMessageLane {
    send<T>(input: RallarRtcSendInput<T>): Promise<RallarMessageSendResult>;
    onMessage<T = never>(
        selector: RallarMessageSelectorInput,
        handler: RallarMessageHandler<T>
    ): RallarUnsubscribe;
}

export interface RallarWsMessageLane {
    send<T>(input: RallarWsSendInput<T>): Promise<RallarMessageSendResult>;
    onMessage<T = never>(
        selector: RallarMessageSelectorInput,
        handler: RallarMessageHandler<T>
    ): RallarUnsubscribe;
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
}
