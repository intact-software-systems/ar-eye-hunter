import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessage, RallarTypedMessageChannel } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { BlackBoxRallarRuntimeDiagnostics } from '../black-box-rallar-diagnostics.ts';
import type { BlackBoxRallarConnectionConfig, BlackBoxRallarEvent } from '../black-box-rallar-operation-contracts.ts';
import { blackBoxRallarRoomRefOf, blackBoxRallarScopeDiagnosticsOf } from '../black-box-rallar-operation-policy.ts';
import type { BlackBoxBrowserMessagesDependency } from '../browser-rallar-runtime-composition.ts';
import {
    resolveBlackBoxRallarTopicId,
    resolveBlackBoxRallarTypeId
} from '../connection/black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarMessagingResourceController } from './create-black-box-rallar-messaging-resource-controller.ts';

export interface TypedChannelRoute {
    readonly typeId: string;
    readonly topicId: string | undefined;
    readonly roomRef: GroupRef | undefined;
}

interface TypedChannelMessageEvent {
    readonly config: BlackBoxRallarConnectionConfig;
    readonly topic: string;
    readonly transport: BlackBoxRallarEvent['transport'];
    readonly message: RallarMessage<RallarMessagePayload>;
}

export namespace BlackBoxRallarTypedChannels {
    export interface Input {
        readonly messages: BlackBoxBrowserMessagesDependency;
        readonly resources: BlackBoxRallarMessagingResourceController;
        readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
    }
}

export class BlackBoxRallarTypedChannels {
    readonly #input: BlackBoxRallarTypedChannels.Input;

    constructor(input: BlackBoxRallarTypedChannels.Input) {
        this.#input = input;
    }

    open(
        config: BlackBoxRallarConnectionConfig,
        route: TypedChannelRoute
    ): RallarTypedMessageChannel<RallarMessagePayload> {
        const channel = this.#input.messages.room<RallarMessagePayload>({
            typeId: route.typeId,
            topicId: route.topicId,
            roomId: config.roomId,
            roomRef: route.roomRef
        });
        const key = JSON.stringify({ kind: 'typed', typeId: route.typeId, topicId: route.topicId });
        this.#input.resources.ensureWsSubscription(key, () => {
            const unsubscribeWs = channel.onWs((_payload, message) => {
                this.#recordMessage({ config, topic: 'rallar.browser.ws.message', transport: 'ws', message });
            });
            const unsubscribeRtc = channel.onRtc((_payload, message) => {
                this.#recordMessage({
                    config,
                    topic: 'rallar.browser.messages.rtc.message',
                    transport: 'messages.rtc',
                    message
                });
            });
            return () => {
                unsubscribeWs();
                unsubscribeRtc();
            };
        });
        return channel;
    }

    /** A receiver that only connects still needs the inbound topics a send would otherwise install. */
    subscribe(config: BlackBoxRallarConnectionConfig): void {
        this.open(config, {
            typeId: resolveBlackBoxRallarTypeId(config),
            topicId: resolveBlackBoxRallarTopicId(config),
            roomRef: blackBoxRallarRoomRefOf(config)
        });
    }

    #recordMessage(event: TypedChannelMessageEvent): void {
        const { config, topic, transport, message } = event;
        this.#input.diagnostics.emit({
            kind: 'message',
            topic,
            connection: config.connection,
            actor: config.actor,
            transport,
            roomId: message.roomId ?? config.roomId,
            ...blackBoxRallarScopeDiagnosticsOf(config),
            senderId: message.senderId,
            typeId: message.typeId,
            topicId: message.topicId,
            contextId: message.contextId,
            resourceId: message.resourceId,
            data: {
                msgId: message.raw.id.msgId,
                typeId: message.typeId,
                topicId: message.topicId,
                transport: message.transport,
                payload: message.payload
            }
        });
    }
}
