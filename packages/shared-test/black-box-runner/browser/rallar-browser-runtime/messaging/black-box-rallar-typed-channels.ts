import type {
    RallarChannelRecovery,
    RallarMessagePayload,
    RallarStorageUnavailablePolicy
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    normalizeRallarMessageSelector,
    type RallarMessageSelector
} from '@shared-web/browser/messages/rallar-message-selectors.ts';
import type { RallarMessage, RallarTypedMessageChannel } from '@shared-web/browser/rallar.ts';
import type { ALTargets } from '@shared/al-contracts/al-contract.ts';
import type { ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import type { ALChannelPurpose } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import { toALMessageTrace } from '@shared/al-contracts/trace/to-al-message-trace.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { BlackBoxRallarRuntimeDiagnostics } from '../black-box-rallar-diagnostics.ts';
import type { BlackBoxRallarConnectionConfig, BlackBoxRallarEvent } from '../black-box-rallar-operation-contracts.ts';
import { blackBoxRallarRoomRefOf, blackBoxRallarScopeDiagnosticsOf } from '../black-box-rallar-operation-policy.ts';
import type { BlackBoxBrowserMessagesDependency } from '../browser-rallar-runtime-composition.ts';
import {
    resolveBlackBoxRallarTopicId,
    resolveBlackBoxRallarTypeId
} from '../connection/black-box-rallar-connection-policy.ts';
import { BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES } from './black-box-rallar-delivery-error-message-prefixes.ts';
import type { BlackBoxRallarMessagingResourceController } from './create-black-box-rallar-messaging-resource-controller.ts';

export interface TypedChannelRoute {
    readonly typeId: string;
    readonly topicId: string | undefined;
    readonly roomRef: GroupRef | undefined;
    readonly durability: ALDurabilityAlgo | undefined;
    readonly onStorageUnavailable: RallarStorageUnavailablePolicy | undefined;
    readonly purpose: ALChannelPurpose;
    /** Stated exactly on a `live` route: the pacing its channel declares. */
    readonly publication: ALPublicationPolicy | undefined;
    /** The channel's recovery owner; undefined declares none, so a message the receiver cannot order is dropped. */
    readonly recovery: RallarChannelRecovery | undefined;
}

interface TypedChannelMessageEvent {
    readonly config: BlackBoxRallarConnectionConfig;
    readonly topic: string;
    readonly transport: BlackBoxRallarEvent['transport'];
    readonly message: RallarMessage<RallarMessagePayload>;
}

/** `messages.reply` names a request by its arrival among the last this many of its type the page received. */
const RECEIVED_MESSAGES_RETAINED_PER_TYPE = 16;

export namespace BlackBoxRallarTypedChannels {
    export interface Input {
        readonly messages: BlackBoxBrowserMessagesDependency;
        readonly resources: BlackBoxRallarMessagingResourceController;
        readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
    }
}

export class BlackBoxRallarTypedChannels {
    readonly #input: BlackBoxRallarTypedChannels.Input;
    /**
     * Oldest first, per type. Close releases every subscription together (`cleanupWsSubscriptions`), so each release
     * forgets the arrivals of every type: a typed and a selector subscription are released in the same close.
     */
    readonly #receivedByType = new Map<string, RallarMessage<RallarMessagePayload>[]>();

    constructor(input: BlackBoxRallarTypedChannels.Input) {
        this.#input = input;
    }

    /**
     * The `index`-th (from 1) of the last arrivals of `typeId` this page still holds, oldest first: a duplicate copy
     * counts as an arrival. An arrival the page does not hold fails the `messages.reply` that names it.
     */
    requireReceived(typeId: string, index: number): RallarMessage<RallarMessagePayload> {
        const received = this.#receivedByType.get(typeId) ?? [];
        const message = received[index - 1];
        if (message === undefined) {
            throw new Error(
                `${BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES.replyRequestUnreceived}: messages.reply names no ` +
                    `received ${typeId} message at index ${index}; the page holds ${received.length}.`
            );
        }
        return message;
    }

    /** The trace of the retained arrival with this `msgId`, whatever its type; undefined when the page holds none. */
    getReceivedTraceId(msgId: string): string | undefined {
        for (const received of this.#receivedByType.values()) {
            const message = received.find((candidate) => candidate.raw.id.msgId === msgId);
            if (message !== undefined) {
                return message.raw.id.traceId;
            }
        }
        return undefined;
    }

    open(
        config: BlackBoxRallarConnectionConfig,
        route: TypedChannelRoute
    ): RallarTypedMessageChannel<RallarMessagePayload> {
        const channel = this.#input.messages.room<RallarMessagePayload>({
            typeId: route.typeId,
            topicId: route.topicId,
            roomId: config.roomId,
            roomRef: route.roomRef,
            purpose: route.purpose,
            ...(route.publication === undefined ? {} : { publication: route.publication }),
            ...(route.durability === undefined ? {} : { durability: route.durability }),
            ...(route.onStorageUnavailable === undefined ? {} : { onStorageUnavailable: route.onStorageUnavailable }),
            ...(route.recovery === undefined ? {} : { recovery: route.recovery })
        });
        const selector = config.rallar.messageSelector
            ? normalizeRallarMessageSelector(config.rallar.messageSelector)
            : undefined;
        if (
            selector && (selector.typeId === undefined || selector.typeId === route.typeId) &&
            (selector.topicId === undefined || selector.topicId === route.topicId)
        ) {
            this.#subscribeSelector(config, selector);
            return channel;
        }
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
                this.#receivedByType.clear();
            };
        });
        return channel;
    }

    /**
     * A receiver that only connects still needs the inbound topics a send would otherwise install. Only this channel
     * carries the connect's recovery owner: a topic selector subscribes the lanes directly and opens no channel.
     */
    subscribe(config: BlackBoxRallarConnectionConfig): void {
        if (config.rallar.messageSelector) {
            this.#subscribeSelector(config, normalizeRallarMessageSelector(config.rallar.messageSelector));
            return;
        }
        this.open(config, {
            typeId: resolveBlackBoxRallarTypeId(config),
            topicId: resolveBlackBoxRallarTopicId(config),
            roomRef: blackBoxRallarRoomRefOf(config),
            durability: undefined,
            onStorageUnavailable: undefined,
            purpose: 'notification',
            publication: undefined,
            recovery: config.rallar.recoveryOwner === 'record' ? this.#createRecordingRecoveryOwner(config) : undefined
        });
    }

    /** The harness's owner does what a recording application would: it states the cursor it was handed. */
    #createRecordingRecoveryOwner(config: BlackBoxRallarConnectionConfig): RallarChannelRecovery {
        return {
            onResyncRequired: (cursor) => {
                this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.messages.recovery_owner_invoked', {
                    ...cursor
                });
            }
        };
    }

    /** A combined recipe keeps its authored topic selector on WS; RTC subscribes once per type it must hear. */
    #subscribeSelector(config: BlackBoxRallarConnectionConfig, selector: RallarMessageSelector): void {
        const rtcTypeIds = resolveRtcSelectorTypeIds(config, selector);
        const key = JSON.stringify({ kind: 'selector', selector, rtcTypeIds });
        this.#input.resources.ensureWsSubscription(key, () => {
            const unsubscribeWs = this.#input.messages.ws.onMessage<RallarMessagePayload>(selector, (message) => {
                this.#recordMessage({ config, topic: 'rallar.browser.ws.message', transport: 'ws', message });
            });
            const unsubscribeRtc = rtcTypeIds.map((typeId) =>
                this.#input.messages.rtc.onMessage<RallarMessagePayload>(
                    { ...selector, typeId },
                    (message) => {
                        this.#recordMessage({
                            config,
                            topic: 'rallar.browser.messages.rtc.message',
                            transport: 'messages.rtc',
                            message
                        });
                    }
                )
            );
            return () => {
                unsubscribeWs();
                for (const unsubscribe of unsubscribeRtc) {
                    unsubscribe();
                }
                this.#receivedByType.clear();
            };
        });
    }

    #retainReceived(message: RallarMessage<RallarMessagePayload>): void {
        const received = this.#receivedByType.get(message.typeId) ?? [];
        received.push(message);
        received.splice(0, received.length - RECEIVED_MESSAGES_RETAINED_PER_TYPE);
        this.#receivedByType.set(message.typeId, received);
    }

    #recordMessage(event: TypedChannelMessageEvent): void {
        const { config, topic, transport, message } = event;
        this.#retainReceived(message);
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
                rosterVersion: toRosterStamp(message.raw.targets),
                topicId: message.topicId,
                transport: message.transport,
                payload: message.payload,
                ...toALMessageTrace(message.raw)
            }
        });
    }
}

/** The roster a room send carried; undefined for a unicast or for a room send whose sender cached no snapshot. */
function toRosterStamp(targets: ALTargets | undefined): number | undefined {
    return targets === undefined || targets.mode === 'unicast' ? undefined : targets.rosterVersion;
}

function resolveRtcSelectorTypeIds(
    config: BlackBoxRallarConnectionConfig,
    selector: RallarMessageSelector
): readonly string[] {
    if (selector.typeId) {
        return [selector.typeId];
    }
    return [...new Set([...(config.rallar.messageTypeIds ?? []), resolveBlackBoxRallarTypeId(config)])];
}
