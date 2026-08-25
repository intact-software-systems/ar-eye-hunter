import type { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type {
    RallarMessageSendResult,
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannel,
    RallarTypedMessageChannelDefinition,
    RallarTypedMessageSendOptions,
    RallarTypedRtcSendOptions,
    RallarTypedWsSendOptions
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import { normalizeRallarMessageSelector } from '@shared-web/browser/messages/rallar-message-selectors.ts';
import type { ALOutboundEnqueueStatus } from '@shared/alm/ALOutboundMessageRuntime.ts';

export namespace BrowserTypedMessageChannels {
    export interface Input {
        readonly inputValidator: BrowserMessageInputValidator;
        readonly rtc: RallarMessagesOperations['rtc'];
        readonly ws: RallarMessagesOperations['ws'];
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
                await this.sendWithStrategy(channelDefinition, payload, options),
            sendRtc: async (payload, options: RallarTypedRtcSendOptions<T> = {}) =>
                await this.sendRtc(channelDefinition, payload, options),
            sendWs: async (payload, options: RallarTypedWsSendOptions<T> = {}) =>
                await this.sendWs(channelDefinition, payload, options),
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

    private async sendWithStrategy<T>(
        definition: RallarTypedMessageChannelDefinition,
        payload: T,
        options: RallarTypedMessageSendOptions<T>
    ): Promise<RallarMessageSendResult> {
        const { strategy = 'rtc-with-ws-fallback', ...sendOptions } = options;
        const rtcOptions = sendOptions as RallarTypedRtcSendOptions<T>;
        const wsOptions = sendOptions as RallarTypedWsSendOptions<T>;

        switch (strategy) {
            case 'ws':
                return await this.sendWs(definition, payload, wsOptions);
            case 'rtc':
            case 'realtime':
                return await this.sendRtc(definition, payload, rtcOptions);
            case 'ws-then-rtc': {
                const wsResult = await this.sendWs(definition, payload, wsOptions);
                if (isSuccessfulRallarMessageSendStatus(wsResult.status)) {
                    return wsResult;
                }
                return await this.sendRtc(definition, payload, rtcOptions);
            }
            case 'rtc-with-ws-fallback':
            default: {
                const rtcResult = await this.sendRtc(definition, payload, rtcOptions);
                if (isSuccessfulRallarMessageSendStatus(rtcResult.status)) {
                    return rtcResult;
                }
                return await this.sendWs(definition, payload, wsOptions);
            }
        }
    }

    private sendRtc<T>(
        definition: RallarTypedMessageChannelDefinition,
        payload: T,
        options: RallarTypedRtcSendOptions<T>
    ): Promise<RallarMessageSendResult> {
        return this.input.rtc.send<T>({
            ...options,
            topicId: definition.topicId,
            typeId: definition.typeId,
            payload
        });
    }

    private sendWs<T>(
        definition: RallarTypedMessageChannelDefinition,
        payload: T,
        options: RallarTypedWsSendOptions<T>
    ): Promise<RallarMessageSendResult> {
        return this.input.ws.send<T>({
            ...options,
            topicId: definition.topicId,
            typeId: definition.typeId,
            payload
        });
    }
}

function isSuccessfulRallarMessageSendStatus(status: ALOutboundEnqueueStatus): boolean {
    return (
        status === 'enqueued' ||
        status === 'sent-immediate' ||
        status === 'duplicate' ||
        status === 'superseded' ||
        status === 'skipped'
    );
}
