import type { BrowserChannelRecoveryOwners } from '@shared-web/browser/messages/browser-channel-recovery-owners.ts';
import type { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import type { BrowserGrantedTopics } from '@shared-web/browser/messages/publication/browser-granted-topics.ts';
import {
    validateBrowserLiveSend,
    type BrowserLiveSendOptions
} from '@shared-web/browser/messages/publication/validate-browser-live-send.ts';
import type {
    RallarRoomMessageChannelDefinition,
    RallarTopicSubscription,
    RallarTypedMessageChannel,
    RallarTypedMessageChannelDefinition,
    RallarTypedMessageSendOptions,
    RallarTypedPayloadHandler,
    RallarTypedRtcSendOptions,
    RallarTypedWsSendOptions
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type { BrowserTypedChannelPolicy } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { BrowserTopicSubscriptions } from '@shared-web/browser/messages/topic-subscription/browser-topic-subscriptions.ts';
import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { throwRallarValidation } from '@shared/api/rallar-validation.ts';

export namespace BrowserTypedMessageChannels {
    export interface Input {
        readonly inputValidator: BrowserMessageInputValidator;
        readonly sender: BrowserRallarMessageSender;
        readonly rtc: Pick<RallarMessagesOperations['rtc'], 'onMessage'>;
        readonly ws: Pick<RallarMessagesOperations['ws'], 'onMessage'>;
        readonly recoveryOwners: BrowserChannelRecoveryOwners;
        readonly topicSubscriptions: Pick<BrowserTopicSubscriptions, 'hold'>;
        /** Where a granted channel declares its topic, so every send on it is a granted delivery. */
        readonly grantedTopics: Pick<BrowserGrantedTopics, 'declareGrantedTopic'>;
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
        if (definition.recovery !== undefined) {
            this.input.recoveryOwners.setOwner(route, definition.recovery);
        }
        if (definition.access === 'granted' && definition.topicId !== undefined) {
            this.input.grantedTopics.declareGrantedTopic(definition.topicId);
        }
        const policy: BrowserTypedChannelPolicy = {
            purpose: definition.purpose,
            access: definition.access,
            durability: definition.durability,
            onStorageUnavailable: definition.onStorageUnavailable ?? 'refuse',
            publication: definition.publication && decodeALPublicationPolicy(definition.publication).right
        };
        return {
            send: async (payload, options: RallarTypedMessageSendOptions<T> = {}) =>
                await this.input.sender.sendTyped(toChannelSend({ ...options, ...route, payload }, policy), policy),
            sendRtc: async (payload, options: RallarTypedRtcSendOptions<T> = {}) =>
                await this.input.sender.sendRtc(toChannelSend({ ...options, ...route, payload }, policy), policy),
            sendWs: async (payload, options: RallarTypedWsSendOptions<T> = {}) =>
                await this.input.sender.sendWs(toChannelSend({ ...options, ...route, payload }, policy), policy),
            onRtc: (handler) => {
                throwIfGrantedRtc(policy);
                return this.input.rtc.onMessage<T>(route, async (message) => {
                    await handler(message.payload, message);
                });
            },
            onWs: (handler) =>
                this.input.ws.onMessage<T>(route, async (message) => {
                    await handler(message.payload, message);
                }),
            subscribe: () => throwUnsupportedSubscribe()
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
            onWs: (handler) => channel.onWs(handler),
            subscribe: (handler) => this.subscribeRoomTopic(definition, channel, handler)
        };
    }

    private subscribeRoomTopic<T>(
        definition: RallarRoomMessageChannelDefinition,
        channel: RallarTypedMessageChannel<T>,
        handler: RallarTypedPayloadHandler<T>
    ): RallarTopicSubscription {
        const { roomRef, topicId } = definition;
        if (definition.access !== 'granted' || roomRef === undefined || topicId === undefined) {
            return throwUnsupportedSubscribe();
        }
        const token = this.input.topicSubscriptions.hold({ roomRef, topicId });
        const removeWsHandler = channel.onWs(handler);
        // Not `onRtc`, which a granted channel refuses: only its own room's admitted granted multicast reaches here.
        const removeRtcHandler = this.input.rtc.onMessage<T>(
            { topicId, typeId: definition.typeId },
            async (message) => {
                if (isRoomMulticast(message.raw, roomRef)) {
                    await handler(message.payload, message);
                }
            }
        );
        return {
            status: () => token.status(),
            wait: async () => await token.wait(),
            unsubscribe: async () => {
                removeWsHandler();
                removeRtcHandler();
                await token.unsubscribe();
            }
        };
    }
}

/** A granted room frame is a multicast to that room: a unicast or another room's frame is never this channel's. */
function isRoomMulticast(message: ALMessage, roomRef: GroupRef): boolean {
    const targetRoomRef = readALTargetGroupRef(message);
    return message.targets?.mode === 'multicast' && targetRoomRef !== undefined &&
        isSameGroupRef(targetRoomRef, roomRef);
}

/** The send a channel hands its sender: a live channel's is refused here, where its policy is known, before a handle opens. */
function toChannelSend<TSend extends BrowserLiveSendOptions>(send: TSend, policy: BrowserTypedChannelPolicy): TSend {
    const issues = policy.publication === undefined ? [] : validateBrowserLiveSend(send);
    if (issues.length > 0) {
        throwRallarValidation(issues);
    }
    return send;
}

/** The server holds an election per room and topic, and only a granted topic's audience asks for one. */
function throwUnsupportedSubscribe(): never {
    return throwRallarValidation([{
        path: '$.access',
        code: 'unsupported',
        message: 'Only a granted room channel with a roomRef subscribes: an election is held per room and topic.'
    }]);
}

/** A granted channel listens on WS only; it sends on RTC only the room multicast its origin signs. */
function throwIfGrantedRtc(policy: BrowserTypedChannelPolicy): void {
    if (policy.access === 'granted') {
        throwRallarValidation([{
            path: '$.access',
            code: 'unsupported',
            message: 'A granted channel listens on WS only.'
        }]);
    }
}
