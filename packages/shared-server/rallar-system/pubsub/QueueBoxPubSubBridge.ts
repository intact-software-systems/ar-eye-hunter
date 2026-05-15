import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';

export type QueueBoxPubSubMessageKey = Readonly<{
    topicId: string;
    resourceId: string;
    contextId: string;
}>;

export type QueueBoxPubSubMessage = Readonly<{
    key: QueueBoxPubSubMessageKey;
    channel: string;
    publisherId: string;
    typeId: string;
    payload: string;
}>;

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
}>;

export function installQueueBoxPubSubBridge(
    options: InstallQueueBoxPubSubBridgeOptions,
): void {
    const { wsQBoxServerService, bridge, channel, publisherId } = options;

    wsQBoxServerService.onAllInboxMessagesDo({
        onMessage: async (_, entry: ResourceEntry, __) => {
            await bridge.publish(channel, toPubSubMessage(channel, publisherId, entry));
        },
    });

    wsQBoxServerService.onAllOutboxMessagesDo({
        onMessage: async (_, entry: ResourceEntry, __) => {
            await bridge.publish(channel, toPubSubMessage(channel, publisherId, entry));
        },
    });

    void bridge
        .subscribe(channel, async (message) => {
            await wsQBoxServerService.inbox.enqueueIfAbsent(
                toResourceEntryFromPubSubMessage(message),
            );
        })
        .catch((error) => {
            console.error('QueueBox pub/sub bridge listener failed:', error);
        });
}

export function toPubSubMessage(
    channel: string,
    publisherId: string,
    entry: ResourceEntry,
): QueueBoxPubSubMessage {
    return {
        key: entry.key,
        channel,
        publisherId,
        typeId: entry.typeId,
        payload: entry.resource,
    };
}

export function toResourceEntryFromPubSubMessage(
    message: QueueBoxPubSubMessage,
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

function toResourceEntryWithRawPayload(
    message: QueueBoxPubSubMessage,
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
