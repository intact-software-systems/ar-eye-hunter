import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import {
    recordRallarTiming,
    type RallarTimingDetails,
    type RallarTimingSink,
} from '../services/timing.ts';

export type QueueBoxPubSubMessageKey = Readonly<{
    topicId: string;
    resourceId: string;
    contextId: string;
}>;

export type QueueBoxPubSubDelivery = 'entry' | 'key';

type QueueBoxPubSubMessageBase = Readonly<{
    key: QueueBoxPubSubMessageKey;
    channel: string;
    publisherId: string;
    typeId: string;
}>;

export type QueueBoxPubSubEntryMessage = QueueBoxPubSubMessageBase & Readonly<{
    delivery?: 'entry';
    payload: string;
}>;

export type QueueBoxPubSubKeyMessage = QueueBoxPubSubMessageBase & Readonly<{
    delivery: 'key';
    payload?: undefined;
}>;

export type QueueBoxPubSubMessage =
    | QueueBoxPubSubEntryMessage
    | QueueBoxPubSubKeyMessage;

export type QueueBoxPubSubBridge = Readonly<{
    publish(channel: string, message: QueueBoxPubSubMessage): Promise<void>;
    subscribe(
        channel: string,
        onMessage: (message: QueueBoxPubSubMessage) => Promise<void> | void,
    ): Promise<void>;
}>;

export type InstallQueueBoxPubSubBridgeOptions = Readonly<{
    wsQBoxServerService: WsQueueBoxServerService;
    bridge: QueueBoxPubSubBridge;
    channel: string;
    publisherId: string;
    delivery?: QueueBoxPubSubDelivery;
    timing?: RallarTimingSink;
}>;

export function installQueueBoxPubSubBridge(
    options: InstallQueueBoxPubSubBridgeOptions,
): void {
    const {
        wsQBoxServerService,
        bridge,
        channel,
        publisherId,
        delivery = 'entry',
        timing,
    } = options;

    wsQBoxServerService.onAllInboxMessagesDo({
        onMessage: async (_, entry: ResourceEntry, __) => {
            await bridge.publish(
                channel,
                toPubSubMessage(channel, publisherId, entry, { delivery }),
            );
        },
    });

    wsQBoxServerService.onAllOutboxMessagesDo({
        onMessage: async (_, entry: ResourceEntry, __) => {
            await bridge.publish(
                channel,
                toPubSubMessage(channel, publisherId, entry, { delivery }),
            );
        },
    });

    void bridge
        .subscribe(channel, async (message) => {
            const entry = await resolveResourceEntryFromPubSubMessage(message, {
                expectedChannel: channel,
                loadByKey: async (key) => await wsQBoxServerService.inbox.getItem(key),
                timing,
            });
            if (!entry) {
                return;
            }

            await wsQBoxServerService.inbox.enqueueIfAbsent(entry);
        })
        .catch((error) => {
            console.error('QueueBox pub/sub bridge listener failed:', error);
        });
}

export function toPubSubMessage(
    channel: string,
    publisherId: string,
    entry: ResourceEntry,
    options: Readonly<{
        delivery?: QueueBoxPubSubDelivery;
    }> = {},
): QueueBoxPubSubMessage {
    if (options.delivery === 'key') {
        return {
            key: entry.key,
            channel,
            publisherId,
            typeId: entry.typeId,
            delivery: 'key',
        };
    }

    return {
        key: entry.key,
        channel,
        publisherId,
        typeId: entry.typeId,
        delivery: 'entry',
        payload: entry.resource,
    };
}

export function toResourceEntryFromPubSubMessage(
    message: QueueBoxPubSubEntryMessage,
): ResourceEntry {
    try {
        return QueueBoxUtilities.toResourceEntryFromMsg(
            JSON.parse(message.payload) as ALMessage,
            message.typeId,
        );
    } catch (error) {
        console.warn(
            'Failed to parse published payload as ALMessage. Falling back to raw queue entry reconstruction.',
            error,
        );
        return toResourceEntryWithRawPayload(message);
    }
}

async function resolveResourceEntryFromPubSubMessage(
    message: QueueBoxPubSubMessage,
    options: Readonly<{
        expectedChannel: string;
        loadByKey: (key: QueueBoxPubSubMessageKey) => Promise<ResourceEntry | undefined>;
        timing?: RallarTimingSink;
    }>,
): Promise<ResourceEntry | undefined> {
    if (!isValidPubSubMessage(message, options.expectedChannel)) {
        recordPubSubTiming(options.timing, 'drop-malformed', message);
        return undefined;
    }

    if (message.delivery === 'key') {
        const entry = await options.loadByKey(message.key);
        if (!entry) {
            recordPubSubTiming(options.timing, 'key-load-miss', message);
            return undefined;
        }

        return entry;
    }

    return toResourceEntryFromPubSubMessage(message);
}

function toResourceEntryWithRawPayload(
    message: QueueBoxPubSubEntryMessage,
): ResourceEntry {
    return {
        key: message.key,
        resource: message.payload,
        typeId: message.typeId,
        status: EntityStatus.NEW,
        dequeueAudit: {
            attempts: 0,
        },
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: message.publisherId,
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs: NEVER_EXPIRE_TS,
        },
    };
}

function isValidPubSubMessage(
    message: QueueBoxPubSubMessage,
    expectedChannel: string,
): boolean {
    if (!message || typeof message !== 'object') {
        return false;
    }

    if (message.channel !== expectedChannel) {
        return false;
    }

    if (
        typeof message.publisherId !== 'string' ||
        typeof message.typeId !== 'string' ||
        !isValidPubSubMessageKey(message.key)
    ) {
        return false;
    }

    if (message.delivery === 'key') {
        return message.payload === undefined;
    }

    return (message.delivery === undefined || message.delivery === 'entry') &&
        typeof message.payload === 'string';
}

function isValidPubSubMessageKey(
    key: QueueBoxPubSubMessageKey | undefined,
): key is QueueBoxPubSubMessageKey {
    return !!key &&
        typeof key.topicId === 'string' &&
        typeof key.resourceId === 'string' &&
        typeof key.contextId === 'string';
}

function recordPubSubTiming(
    timing: RallarTimingSink | undefined,
    operation: string,
    message: Partial<QueueBoxPubSubMessage> | undefined,
): void {
    recordRallarTiming(
        timing,
        {
            component: 'queuebox-pubsub',
            operation,
            serviceId: message?.publisherId,
            details: toPubSubTimingDetails(message),
        },
        'ok',
        0,
    );
}

function toPubSubTimingDetails(
    message: Partial<QueueBoxPubSubMessage> | undefined,
): RallarTimingDetails {
    return {
        channel: message?.channel,
        delivery: message?.delivery,
        topicId: message?.key?.topicId,
        resourceId: message?.key?.resourceId,
        contextId: message?.key?.contextId,
        typeId: message?.typeId,
    };
}
