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
import type { BrowserTypedChannelPolicy } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import { throwRallarValidation } from '@shared/api/rallar-validation.ts';

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
        const issues = this.input.inputValidator.validateTypedChannel(definition);
        if (issues.length > 0) {
            throwRallarValidation(issues);
        }
        return this.createChannel<T>(definition);
    }

    private createChannel<T>(definition: RallarTypedMessageChannelDefinition): RallarTypedMessageChannel<T> {
        const route = { topicId: definition.topicId, typeId: definition.typeId };
        const policy: BrowserTypedChannelPolicy = { purpose: definition.purpose, durability: definition.durability };
        return {
            send: async (payload, options: RallarTypedMessageSendOptions<T> = {}) =>
                await this.input.sender.sendTyped({ ...options, ...route, payload }, policy),
            sendRtc: async (payload, options: RallarTypedRtcSendOptions<T> = {}) =>
                await this.input.sender.sendRtc({ ...options, ...route, payload }, policy),
            sendWs: async (payload, options: RallarTypedWsSendOptions<T> = {}) =>
                await this.input.sender.sendWs({ ...options, ...route, payload }, policy),
            onRtc: (handler) =>
                this.input.rtc.onMessage<T>(route, async (message) => {
                    await handler(message.payload, message);
                }),
            onWs: (handler) =>
                this.input.ws.onMessage<T>(route, async (message) => {
                    await handler(message.payload, message);
                })
        };
    }

    public room<T>(definition: RallarRoomMessageChannelDefinition): RallarTypedMessageChannel<T> {
        const issues = [
            ...this.input.inputValidator.validateRoomChannel(definition),
            ...this.input.inputValidator.validateTypedChannel(definition)
        ];
        if (issues.length > 0) {
            throwRallarValidation(issues);
        }
        const channel = this.createChannel<T>(definition);
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
