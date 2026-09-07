import type { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import type {
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannel,
    RallarTypedMessageChannelDefinition,
    RallarTypedMessageSendOptions,
    RallarTypedRtcSendOptions,
    RallarTypedWsSendOptions
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import { normalizeRallarMessageSelector } from '@shared-web/browser/messages/rallar-message-selectors.ts';

export namespace BrowserTypedMessageChannels {
    export interface Input {
        readonly inputValidator: BrowserMessageInputValidator;
        readonly sender: BrowserRallarMessageSender;
        readonly rtc: Pick<RallarMessagesOperations['rtc'], 'onMessage'>;
        readonly ws: Pick<RallarMessagesOperations['ws'], 'onMessage'>;
    }
}

export class BrowserTypedMessageChannels {
    private readonly input: BrowserTypedMessageChannels.Input;

    public constructor(input: BrowserTypedMessageChannels.Input) {
        this.input = input;
    }

    public channel<T>(
        definition: RallarTypedMessageChannelDefinition
    ): RallarTypedMessageChannel<T> {
        const selector = normalizeRallarMessageSelector(definition);
        if (!selector.typeId) {
            throw new Error('Typed message channels require a typeId.');
        }
        const channelDefinition = {
            topicId: selector.topicId,
            typeId: selector.typeId
        };
        this.input.inputValidator.assertTypedChannel(
            channelDefinition.topicId,
            channelDefinition.typeId
        );

        return {
            send: async (payload, options: RallarTypedMessageSendOptions<T> = {}) =>
                await this.input.sender.sendTyped({ ...options, ...channelDefinition, payload }),
            sendRtc: async (payload, options: RallarTypedRtcSendOptions<T> = {}) =>
                await this.input.sender.sendRtc({ ...options, ...channelDefinition, payload }),
            sendWs: async (payload, options: RallarTypedWsSendOptions<T> = {}) =>
                await this.input.sender.sendWs({ ...options, ...channelDefinition, payload }),
            onRtc: (handler) =>
                this.input.rtc.onMessage<T>(channelDefinition, async (message) => {
                    await handler(message.payload, message);
                }),
            onWs: (handler) =>
                this.input.ws.onMessage<T>(channelDefinition, async (message) => {
                    await handler(message.payload, message);
                })
        };
    }

    public room<T>(definition: RallarRoomMessageChannelDefinition): RallarTypedMessageChannel<T> {
        this.input.inputValidator.assertRoomChannel(definition);
        const channel = this.channel<T>(definition);
        const roomDefaults = {
            roomId: definition.roomRef ? undefined : definition.roomId,
            roomRef: definition.roomRef
        };

        return {
            send: async (payload, options: RallarTypedMessageSendOptions<T> = {}) =>
                await channel.send(payload, {
                    ...roomDefaults,
                    strategy: options.strategy ?? 'rtc-with-ws-fallback',
                    ...options
                }),
            sendRtc: async (payload, options: RallarTypedRtcSendOptions<T> = {}) =>
                await channel.sendRtc(payload, {
                    ...roomDefaults,
                    ...options
                }),
            sendWs: async (payload, options: RallarTypedWsSendOptions<T> = {}) =>
                await channel.sendWs(payload, {
                    ...roomDefaults,
                    scope: options.scope ?? 'room',
                    ...options
                }),
            onRtc: (handler) => channel.onRtc(handler),
            onWs: (handler) => channel.onWs(handler)
        };
    }
}
